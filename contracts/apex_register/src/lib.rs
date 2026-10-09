//! `apex_register`: a per-period counterparty-confirmation register for a SACCO apex body.
//!
//! Each period the apex commits its book of member positions (deposits it holds for
//! members, loans it has made) as the root of a Merkle sum tree. Every node carries a
//! hash, a deposit sum and a loan sum, so the root carries the period's booked deposit
//! liabilities and booked loans. Each registered member SACCO's board confirms or disputes
//! its own lines with an inclusion proof; the custodian bank attests the cash balance on
//! the same balance date. After the response window anyone can close the period, which
//! freezes a coverage report:
//!
//! ```text
//! coverage_bps        = (attested cash + recognised performing loans) * 10000 / (booked deposits + uplift)
//! booked_coverage_bps = (attested cash + all booked loans)             * 10000 /  booked deposits
//! ```
//!
//! Loans that no counterparty confirms fall out of `coverage_bps`. The register does not
//! decide who is right in a dispute, moves no funds and has no admin override: no party
//! can edit a posted root, delete a response or change a closed report.
//!
//! Roles: the `registrar` (the regulator in the target design, never the apex) admits
//! member boards and custodians; the `apex` opens periods and posts roots; member boards
//! respond; custodians attest cash; anyone closes and raises staleness flags.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
    Symbol, Vec,
};

pub mod merkle;

pub const KIND_DEPOSIT: u32 = 1;
pub const KIND_LOAN: u32 = 2;

pub const VERDICT_CONFIRMED: u32 = 1;
pub const VERDICT_DISPUTED: u32 = 2;

pub const REASON_NONE: u32 = 0;
pub const REASON_BALANCE_WRONG: u32 = 1;
pub const REASON_NOT_OURS: u32 = 2;
pub const REASON_ARREARS_WRONG: u32 = 3;
pub const REASON_OTHER: u32 = 4;

pub const FLAG_BELOW_ALERT: u32 = 1;
pub const FLAG_UNCONFIRMED_LOANS: u32 = 2;
pub const FLAG_DISPUTES: u32 = 4;
pub const FLAG_LATE_RESPONSES: u32 = 8;
pub const FLAG_CUSTODIAN_LATE: u32 = 16;
pub const FLAG_OMITTED_CLAIMS: u32 = 32;
pub const FLAG_GAP_WIDE: u32 = 64;
pub const FLAG_NO_LIABILITIES: u32 = 128;

/// Gap between booked and confirmed coverage that raises `GAP_WIDE` (10 percentage points).
pub const GAP_WIDE_BPS: i128 = 1000;
pub const MAX_MEMBER_NO: u32 = 1024;
pub const MAX_CUSTODIANS: u32 = 4;
pub const MAX_BATCH: u32 = 16;
pub const MAX_OVERDUE_PAGE: u32 = 25;
pub const MAX_REPORT_RANGE: u32 = 24;
pub const MAX_UNRESPONDED_PAGE: u32 = 512;
pub const MAX_DISPUTE_PAGE: u32 = 32;
const BPS: i128 = 10_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The contract has already been initialised.
    AlreadyInitialised = 1,
    /// The contract requires initialisation before use.
    NotInitialised = 2,
    /// The provided configuration is invalid.
    BadConfig = 3,
    /// The provided roles have a conflict.
    RoleConflict = 4,
    /// The provided member number is invalid.
    BadMemberNo = 5,
    MemberExists = 6,
    UnknownMember = 7,
    MemberInactive = 8,
    TooManyCustodians = 9,
    NotCustodian = 10,
    NoCustodian = 11,
    PreviousNotClosed = 12,
    AsOfNotIncreasing = 13,
    FutureAsOf = 14,
    BadSupersedes = 15,
    BadState = 16,
    BadLeafCount = 17,
    NegativeSum = 18,
    WrongPeriod = 19,
    BadIndex = 20,
    NotYourLeaf = 21,
    BadLeaf = 22,
    BadProof = 23,
    AlreadyResponded = 24,
    BadReason = 25,
    BadClaim = 26,
    NotADispute = 27,
    BatchTooLarge = 28,
    AlreadyClaimed = 29,
    AsOfMismatch = 30,
    AlreadyAttested = 31,
    TooEarly = 32,
    CustodianMissing = 33,
    Overflow = 34,
    RangeTooLarge = 35,
}

// ------------------------------------------------------------------------------ types

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub registrar: Address,
    pub apex: Address,
    pub currency: Symbol,
    pub decimals: u32,
    pub confirm_window_secs: u64,
    pub attest_window_secs: u64,
    pub max_period_gap_secs: u64,
    pub performing_max_days: u32,
    pub alert_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Member {
    pub no: u32,
    pub board: Address,
    pub licence_hash: BytesN<32>,
    pub active: bool,
    pub admitted_at: u64,
    pub overdue_streak: u32,
    pub last_response_period: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Node {
    pub hash: BytesN<32>,
    pub dep: i128,
    pub loan: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Leaf {
    pub period: u32,
    pub index: u32,
    pub cp: u32,
    pub kind: u32,
    pub line_ref: BytesN<32>,
    pub balance: i128,
    pub arrears_days: u32,
    pub salt: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Response {
    pub index: u32,
    pub member_no: u32,
    pub kind: u32,
    pub verdict: u32,
    pub booked: i128,
    pub claimed: i128,
    pub arrears_days: u32,
    pub claimed_arrears_days: u32,
    pub reason: u32,
    pub evidence_hash: BytesN<32>,
    pub at: u64,
    pub late: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CashAttestation {
    pub custodian: Address,
    pub balance: i128,
    pub as_of: u64,
    pub statement_hash: BytesN<32>,
    pub at: u64,
    pub late: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OmittedClaim {
    pub member_no: u32,
    pub claimed_deposit: i128,
    pub evidence_hash: BytesN<32>,
    pub at: u64,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PeriodState {
    Open = 1,
    Posted = 2,
    Closed = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Period {
    pub id: u32,
    pub as_of: u64,
    pub opened_at: u64,
    pub supersedes: u32,
    pub root: Node,
    pub leaf_count: u32,
    pub depth: u32,
    pub file_hash: BytesN<32>,
    pub posted_at: u64,
    pub confirm_by: u64,
    pub attest_by: u64,
    pub custodians: Vec<Address>,
    pub state: PeriodState,
}

#[contracttype]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Tally {
    pub responded: u32,
    pub late: u32,
    pub confirmed_dep: i128,
    pub confirmed_loans: i128,
    pub recognised_loans: i128,
    pub disputed_loans_booked: i128,
    pub disputed_loans_ack: i128,
    pub disputed_count: u32,
    pub deposit_uplift: i128,
    pub omitted_count: u32,
    pub cash: i128,
    pub cash_count: u32,
    pub cash_late: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Report {
    pub period: u32,
    pub liabilities: i128,
    pub cash: i128,
    pub recognised_loans: i128,
    pub booked_loans: i128,
    pub unconfirmed_loans: i128,
    pub coverage_bps: i128,
    pub booked_coverage_bps: i128,
    pub unresponded: u32,
    pub disputed: u32,
    pub late: u32,
    pub omitted: u32,
    pub flags: u32,
    pub closed_at: u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    // instance
    Config,
    CurrentPeriod,
    LastClosedAt,
    LastReport,
    MemberCount,
    MaxMemberNo,
    ApexStaleSince,
    Custodians,
    // persistent
    Member(u32),
    BoardIndex(Address),
    Custodian(Address),
    Period(u32),
    Tally(u32),
    Report(u32),
    Resp(u32, u32),
    RespBits(u32, u32),
    MemberResp(u32, u32),
    Omitted(u32, u32),
    Cash(u32, Address),
    OverdueCursor(u32),
    DisputeAt(u32, u32),
}

// ------------------------------------------------------------------------------ events

#[contractevent(topics = ["open"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenEvent {
    #[topic]
    pub period: u32,
    pub as_of: u64,
    pub supersedes: u32,
}

#[contractevent(topics = ["post"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PostEvent {
    #[topic]
    pub period: u32,
    pub root_hash: BytesN<32>,
    pub dep: i128,
    pub loan: i128,
    pub leaf_count: u32,
    pub file_hash: BytesN<32>,
}

#[contractevent(topics = ["confirm"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfirmEvent {
    #[topic]
    pub period: u32,
    pub index: u32,
    pub member_no: u32,
    pub kind: u32,
    pub booked: i128,
    pub late: bool,
}

#[contractevent(topics = ["dispute"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeEvent {
    #[topic]
    pub period: u32,
    pub index: u32,
    pub member_no: u32,
    pub kind: u32,
    pub booked: i128,
    pub claimed: i128,
    pub reason: u32,
}

#[contractevent(topics = ["omitted"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OmittedEvent {
    #[topic]
    pub period: u32,
    pub member_no: u32,
    pub claimed_deposit: i128,
}

#[contractevent(topics = ["attest"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestEvent {
    #[topic]
    pub period: u32,
    pub custodian: Address,
    pub balance: i128,
    pub late: bool,
}

#[contractevent(topics = ["close"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloseEvent {
    #[topic]
    pub period: u32,
    pub coverage_bps: i128,
    pub booked_coverage_bps: i128,
    pub unconfirmed_loans: i128,
    pub flags: u32,
}

#[contractevent(topics = ["coverage_alert"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CoverageAlertEvent {
    #[topic]
    pub period: u32,
    pub coverage_bps: i128,
}

#[contractevent(topics = ["overdue"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OverdueEvent {
    #[topic]
    pub member_no: u32,
    pub period: u32,
    pub streak: u32,
}

#[contractevent(topics = ["apex_stale"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApexStaleEvent {
    pub since: u64,
}

#[contractevent(topics = ["member"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemberEvent {
    #[topic]
    pub no: u32,
    pub board: Address,
    pub active: bool,
}

#[contractevent(topics = ["custodian"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CustodianEvent {
    #[topic]
    pub custodian: Address,
    pub active: bool,
}

// ------------------------------------------------------------------------------ storage helpers

fn bump_instance(env: &Env) {
    let max = env.storage().max_ttl();
    env.storage().instance().extend_ttl(max, max);
}

fn put<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey, val: &V) {
    let max = env.storage().max_ttl();
    env.storage().persistent().set(key, val);
    env.storage().persistent().extend_ttl(key, max, max);
}

fn get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey) -> Option<V> {
    env.storage().persistent().get(key)
}

fn iget<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey) -> Option<V> {
    env.storage().instance().get(key)
}

fn iset<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey, val: &V) {
    env.storage().instance().set(key, val);
    bump_instance(env);
}

fn config(env: &Env) -> Result<Config, Error> {
    iget(env, &DataKey::Config).ok_or(Error::NotInitialised)
}

fn load_period(env: &Env, id: u32) -> Result<Period, Error> {
    get(env, &DataKey::Period(id)).ok_or(Error::BadState)
}

fn load_member(env: &Env, no: u32) -> Result<Member, Error> {
    get(env, &DataKey::Member(no)).ok_or(Error::UnknownMember)
}

fn load_tally(env: &Env, id: u32) -> Tally {
    get(env, &DataKey::Tally(id)).unwrap_or_default()
}

fn is_custodian(env: &Env, a: &Address) -> bool {
    get::<bool>(env, &DataKey::Custodian(a.clone())).unwrap_or(false)
}

fn is_board(env: &Env, a: &Address) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::BoardIndex(a.clone()))
}

fn custodian_list(env: &Env) -> Vec<Address> {
    iget(env, &DataKey::Custodians).unwrap_or(Vec::new(env))
}

/// A member board may not be the registrar, the apex, a custodian or another member's board.
fn check_board_free(env: &Env, cfg: &Config, board: &Address) -> Result<(), Error> {
    if *board == cfg.apex
        || *board == cfg.registrar
        || is_board(env, board)
        || is_custodian(env, board)
    {
        return Err(Error::RoleConflict);
    }
    Ok(())
}

fn resp_bit(env: &Env, period: u32, index: u32) -> bool {
    let word: u128 = get(env, &DataKey::RespBits(period, index / 128)).unwrap_or(0);
    word & (1u128 << (index % 128)) != 0
}

fn set_resp_bit(env: &Env, period: u32, index: u32) {
    let key = DataKey::RespBits(period, index / 128);
    let word: u128 = get(env, &key).unwrap_or(0);
    put(env, &key, &(word | (1u128 << (index % 128))));
}

fn add(a: i128, b: i128) -> Result<i128, Error> {
    a.checked_add(b).ok_or(Error::Overflow)
}

/// Pure report computation, shared by `close_period` and the tests. The TypeScript
/// `app/src/report/coverage.ts` reproduces it; `contracts/vectors/coverage.json` holds
/// cases exported by the property test.
pub fn compute_report(
    period: u32,
    alert_bps: u32,
    root: &Node,
    leaf_count: u32,
    t: &Tally,
    closed_at: u64,
) -> Result<Report, Error> {
    let liabilities = add(root.dep, t.deposit_uplift)?;
    let unconfirmed_loans = root
        .loan
        .checked_sub(t.confirmed_loans)
        .and_then(|v| v.checked_sub(t.disputed_loans_booked))
        .ok_or(Error::Overflow)?;
    let mut flags = 0u32;
    let coverage_bps = if liabilities > 0 {
        add(t.cash, t.recognised_loans)?
            .checked_mul(BPS)
            .ok_or(Error::Overflow)?
            / liabilities
    } else {
        -1
    };
    let booked_coverage_bps = if root.dep > 0 {
        add(t.cash, root.loan)?
            .checked_mul(BPS)
            .ok_or(Error::Overflow)?
            / root.dep
    } else {
        -1
    };
    if liabilities <= 0 || root.dep <= 0 {
        flags |= FLAG_NO_LIABILITIES;
    }
    if liabilities > 0 && coverage_bps < alert_bps as i128 {
        flags |= FLAG_BELOW_ALERT;
    }
    if unconfirmed_loans > 0 {
        flags |= FLAG_UNCONFIRMED_LOANS;
    }
    if t.disputed_count > 0 {
        flags |= FLAG_DISPUTES;
    }
    if t.late > 0 {
        flags |= FLAG_LATE_RESPONSES;
    }
    if t.cash_late {
        flags |= FLAG_CUSTODIAN_LATE;
    }
    if t.omitted_count > 0 {
        flags |= FLAG_OMITTED_CLAIMS;
    }
    if coverage_bps >= 0
        && booked_coverage_bps >= 0
        && booked_coverage_bps - coverage_bps >= GAP_WIDE_BPS
    {
        flags |= FLAG_GAP_WIDE;
    }
    Ok(Report {
        period,
        liabilities,
        cash: t.cash,
        recognised_loans: t.recognised_loans,
        booked_loans: root.loan,
        unconfirmed_loans,
        coverage_bps,
        booked_coverage_bps,
        unresponded: leaf_count - t.responded,
        disputed: t.disputed_count,
        late: t.late,
        omitted: t.omitted_count,
        flags,
        closed_at,
    })
}

/// The checks shared by `confirm`, `dispute` and `confirm_batch` (after board auth).
/// Returns the period so the caller can use `confirm_by`.
fn check_line(
    env: &Env,
    period: &Period,
    member_no: u32,
    leaf: &Leaf,
    proof: &Vec<Node>,
) -> Result<(), Error> {
    if leaf.period != period.id {
        return Err(Error::WrongPeriod);
    }
    if leaf.index >= period.leaf_count {
        return Err(Error::BadIndex);
    }
    if leaf.cp != member_no {
        return Err(Error::NotYourLeaf);
    }
    if (leaf.kind != KIND_DEPOSIT && leaf.kind != KIND_LOAN) || leaf.balance < 0 {
        return Err(Error::BadLeaf);
    }
    if proof.len() != period.depth {
        return Err(Error::BadProof);
    }
    let start = merkle::leaf_node(env, leaf);
    let root = merkle::root_from_proof(env, start, leaf.index, proof)?;
    if root != period.root {
        return Err(Error::BadProof);
    }
    if resp_bit(env, period.id, leaf.index) {
        return Err(Error::AlreadyResponded);
    }
    Ok(())
}

/// Load the posted period and the responding member, and require the member board's auth.
fn responder(env: &Env, period_id: u32, member_no: u32) -> Result<(Config, Period, Member), Error> {
    let cfg = config(env)?;
    let period = load_period(env, period_id)?;
    if period.state != PeriodState::Posted {
        return Err(Error::BadState);
    }
    let member = load_member(env, member_no)?;
    member.board.require_auth();
    if !member.active {
        return Err(Error::MemberInactive);
    }
    Ok((cfg, period, member))
}

fn record(env: &Env, period: u32, t: &mut Tally, r: &Response) {
    put(env, &DataKey::Resp(period, r.index), r);
    set_resp_bit(env, period, r.index);
    t.responded += 1;
    if r.late {
        t.late += 1;
    }
    let mk = DataKey::MemberResp(period, r.member_no);
    let n: u32 = get(env, &mk).unwrap_or(0);
    put(env, &mk, &(n + 1));
}

fn do_confirm(
    env: &Env,
    cfg: &Config,
    period: &Period,
    t: &mut Tally,
    member_no: u32,
    leaf: &Leaf,
    proof: &Vec<Node>,
) -> Result<(), Error> {
    check_line(env, period, member_no, leaf, proof)?;
    let now = env.ledger().timestamp();
    let late = now > period.confirm_by;
    if leaf.kind == KIND_DEPOSIT {
        t.confirmed_dep = add(t.confirmed_dep, leaf.balance)?;
    } else {
        t.confirmed_loans = add(t.confirmed_loans, leaf.balance)?;
        if leaf.arrears_days <= cfg.performing_max_days {
            t.recognised_loans = add(t.recognised_loans, leaf.balance)?;
        }
    }
    let r = Response {
        index: leaf.index,
        member_no,
        kind: leaf.kind,
        verdict: VERDICT_CONFIRMED,
        booked: leaf.balance,
        claimed: leaf.balance,
        arrears_days: leaf.arrears_days,
        claimed_arrears_days: leaf.arrears_days,
        reason: REASON_NONE,
        evidence_hash: BytesN::from_array(env, &[0u8; 32]),
        at: now,
        late,
    };
    record(env, period.id, t, &r);
    ConfirmEvent {
        period: period.id,
        index: leaf.index,
        member_no,
        kind: leaf.kind,
        booked: leaf.balance,
        late,
    }
    .publish(env);
    Ok(())
}

// ------------------------------------------------------------------------------ contract

#[contract]
pub struct ApexRegister;

#[contractimpl]
impl ApexRegister {
    // -------------------------------------------------------------- setup and roles

    #[allow(clippy::too_many_arguments)]
    pub fn init(
        env: Env,
        registrar: Address,
        apex: Address,
        currency: Symbol,
        decimals: u32,
        confirm_window_secs: u64,
        attest_window_secs: u64,
        max_period_gap_secs: u64,
        performing_max_days: u32,
        alert_bps: u32,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialised);
        }
        registrar.require_auth();
        if confirm_window_secs == 0
            || attest_window_secs == 0
            || max_period_gap_secs == 0
            || attest_window_secs > confirm_window_secs
            || alert_bps == 0
            || alert_bps > 20_000
        {
            return Err(Error::BadConfig);
        }
        if registrar == apex {
            return Err(Error::RoleConflict);
        }
        let cfg = Config {
            registrar,
            apex,
            currency,
            decimals,
            confirm_window_secs,
            attest_window_secs,
            max_period_gap_secs,
            performing_max_days,
            alert_bps,
        };
        iset(&env, &DataKey::Config, &cfg);
        iset(&env, &DataKey::CurrentPeriod, &0u32);
        iset(&env, &DataKey::LastClosedAt, &0u64);
        iset(&env, &DataKey::MemberCount, &0u32);
        iset(&env, &DataKey::MaxMemberNo, &0u32);
        iset(&env, &DataKey::ApexStaleSince, &0u64);
        Ok(())
    }

    pub fn get_config(env: Env) -> Result<Config, Error> {
        config(&env)
    }

    pub fn get_member(env: Env, no: u32) -> Result<Member, Error> {
        load_member(&env, no)
    }

    pub fn get_tally(env: Env, period: u32) -> Result<Tally, Error> {
        Ok(load_tally(&env, period))
    }

    pub fn register_member(
        env: Env,
        no: u32,
        board: Address,
        licence_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let cfg = config(&env)?;
        cfg.registrar.require_auth();
        if no == 0 || no > MAX_MEMBER_NO {
            return Err(Error::BadMemberNo);
        }
        if env.storage().persistent().has(&DataKey::Member(no)) {
            return Err(Error::MemberExists);
        }
        check_board_free(&env, &cfg, &board)?;
        let m = Member {
            no,
            board: board.clone(),
            licence_hash,
            active: true,
            admitted_at: env.ledger().timestamp(),
            overdue_streak: 0,
            last_response_period: 0,
        };
        put(&env, &DataKey::Member(no), &m);
        put(&env, &DataKey::BoardIndex(board.clone()), &no);
        let count: u32 = iget(&env, &DataKey::MemberCount).unwrap_or(0);
        iset(&env, &DataKey::MemberCount, &(count + 1));
        let max_no: u32 = iget(&env, &DataKey::MaxMemberNo).unwrap_or(0);
        if no > max_no {
            iset(&env, &DataKey::MaxMemberNo, &no);
        }
        MemberEvent {
            no,
            board,
            active: true,
        }
        .publish(&env);
        Ok(())
    }

    pub fn set_member_active(env: Env, no: u32, active: bool) -> Result<(), Error> {
        let cfg = config(&env)?;
        cfg.registrar.require_auth();
        let mut m = load_member(&env, no)?;
        m.active = active;
        put(&env, &DataKey::Member(no), &m);
        MemberEvent {
            no,
            board: m.board,
            active,
        }
        .publish(&env);
        Ok(())
    }

    pub fn rotate_board(env: Env, no: u32, new_board: Address) -> Result<(), Error> {
        let cfg = config(&env)?;
        cfg.registrar.require_auth();
        let mut m = load_member(&env, no)?;
        check_board_free(&env, &cfg, &new_board)?;
        env.storage()
            .persistent()
            .remove(&DataKey::BoardIndex(m.board.clone()));
        m.board = new_board.clone();
        put(&env, &DataKey::Member(no), &m);
        put(&env, &DataKey::BoardIndex(new_board.clone()), &no);
        MemberEvent {
            no,
            board: new_board,
            active: m.active,
        }
        .publish(&env);
        Ok(())
    }

    pub fn set_custodian(env: Env, custodian: Address, active: bool) -> Result<(), Error> {
        let cfg = config(&env)?;
        cfg.registrar.require_auth();
        let mut list = custodian_list(&env);
        let pos = list.first_index_of(&custodian);
        if active {
            if custodian == cfg.apex || custodian == cfg.registrar || is_board(&env, &custodian) {
                return Err(Error::RoleConflict);
            }
            if pos.is_none() {
                if list.len() >= MAX_CUSTODIANS {
                    return Err(Error::TooManyCustodians);
                }
                list.push_back(custodian.clone());
            }
        } else if let Some(i) = pos {
            list.remove(i);
        }
        iset(&env, &DataKey::Custodians, &list);
        put(&env, &DataKey::Custodian(custodian.clone()), &active);
        CustodianEvent { custodian, active }.publish(&env);
        Ok(())
    }

    pub fn set_apex(env: Env, new_apex: Address) -> Result<(), Error> {
        let mut cfg = config(&env)?;
        cfg.registrar.require_auth();
        if new_apex == cfg.registrar || is_board(&env, &new_apex) || is_custodian(&env, &new_apex) {
            return Err(Error::RoleConflict);
        }
        cfg.apex = new_apex;
        iset(&env, &DataKey::Config, &cfg);
        Ok(())
    }

    pub fn transfer_registrar(env: Env, new_registrar: Address) -> Result<(), Error> {
        let mut cfg = config(&env)?;
        cfg.registrar.require_auth();
        new_registrar.require_auth();
        if new_registrar == cfg.apex
            || is_board(&env, &new_registrar)
            || is_custodian(&env, &new_registrar)
        {
            return Err(Error::RoleConflict);
        }
        cfg.registrar = new_registrar;
        iset(&env, &DataKey::Config, &cfg);
        Ok(())
    }

    // -------------------------------------------------------------- apex

    /// Open the next period for balance date `as_of`. A superseding period (a correction of
    /// closed period `supersedes`) may reuse the same balance date as the previous period.
    pub fn open_period(env: Env, as_of: u64, supersedes: u32) -> Result<u32, Error> {
        let cfg = config(&env)?;
        cfg.apex.require_auth();
        let now = env.ledger().timestamp();
        let cur: u32 = iget(&env, &DataKey::CurrentPeriod).unwrap_or(0);
        if cur > 0 {
            let prev = load_period(&env, cur)?;
            if prev.state != PeriodState::Closed {
                return Err(Error::PreviousNotClosed);
            }
            let correction_of_prev = supersedes == cur;
            if as_of < prev.as_of || (as_of == prev.as_of && !correction_of_prev) {
                return Err(Error::AsOfNotIncreasing);
            }
        }
        if as_of > now {
            return Err(Error::FutureAsOf);
        }
        if supersedes != 0 {
            let ok = supersedes <= cur
                && get::<Period>(&env, &DataKey::Period(supersedes))
                    .map(|p| p.state == PeriodState::Closed)
                    .unwrap_or(false);
            if !ok {
                return Err(Error::BadSupersedes);
            }
        }
        let custodians = custodian_list(&env);
        if custodians.is_empty() {
            return Err(Error::NoCustodian);
        }
        let id = cur + 1;
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        let p = Period {
            id,
            as_of,
            opened_at: now,
            supersedes,
            root: Node {
                hash: zero.clone(),
                dep: 0,
                loan: 0,
            },
            leaf_count: 0,
            depth: 0,
            file_hash: zero,
            posted_at: 0,
            confirm_by: 0,
            attest_by: 0,
            custodians,
            state: PeriodState::Open,
        };
        put(&env, &DataKey::Period(id), &p);
        put(&env, &DataKey::Tally(id), &Tally::default());
        iset(&env, &DataKey::CurrentPeriod, &id);
        iset(&env, &DataKey::ApexStaleSince, &0u64);
        OpenEvent {
            period: id,
            as_of,
            supersedes,
        }
        .publish(&env);
        Ok(id)
    }

    /// Post the Merkle sum root. A root can never be replaced; a wrong book is corrected by
    /// closing this period and opening a superseding one.
    pub fn post_root(
        env: Env,
        period: u32,
        root: Node,
        leaf_count: u32,
        file_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let cfg = config(&env)?;
        cfg.apex.require_auth();
        let mut p = load_period(&env, period)?;
        if p.state != PeriodState::Open {
            return Err(Error::BadState);
        }
        if leaf_count == 0 || leaf_count > merkle::MAX_LEAVES {
            return Err(Error::BadLeafCount);
        }
        if root.dep < 0 || root.loan < 0 {
            return Err(Error::NegativeSum);
        }
        let now = env.ledger().timestamp();
        p.root = root.clone();
        p.leaf_count = leaf_count;
        p.depth = merkle::depth_for(leaf_count);
        p.file_hash = file_hash.clone();
        p.posted_at = now;
        p.confirm_by = now + cfg.confirm_window_secs;
        p.attest_by = now + cfg.attest_window_secs;
        p.state = PeriodState::Posted;
        put(&env, &DataKey::Period(period), &p);
        PostEvent {
            period,
            root_hash: root.hash,
            dep: root.dep,
            loan: root.loan,
            leaf_count,
            file_hash,
        }
        .publish(&env);
        Ok(())
    }

    // -------------------------------------------------------------- member boards

    pub fn confirm(
        env: Env,
        period: u32,
        member_no: u32,
        leaf: Leaf,
        proof: Vec<Node>,
    ) -> Result<(), Error> {
        let (cfg, p, _m) = responder(&env, period, member_no)?;
        let mut t = load_tally(&env, period);
        do_confirm(&env, &cfg, &p, &mut t, member_no, &leaf, &proof)?;
        put(&env, &DataKey::Tally(period), &t);
        Ok(())
    }

    /// Confirm up to 16 lines under one board authorisation. All-or-nothing.
    pub fn confirm_batch(
        env: Env,
        period: u32,
        member_no: u32,
        items: Vec<(Leaf, Vec<Node>)>,
    ) -> Result<(), Error> {
        if items.len() > MAX_BATCH {
            return Err(Error::BatchTooLarge);
        }
        let (cfg, p, _m) = responder(&env, period, member_no)?;
        let mut t = load_tally(&env, period);
        for (leaf, proof) in items.iter() {
            do_confirm(&env, &cfg, &p, &mut t, member_no, &leaf, &proof)?;
        }
        put(&env, &DataKey::Tally(period), &t);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn dispute(
        env: Env,
        period: u32,
        member_no: u32,
        leaf: Leaf,
        proof: Vec<Node>,
        claimed: i128,
        claimed_arrears_days: u32,
        reason: u32,
        evidence_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let (cfg, p, _m) = responder(&env, period, member_no)?;
        check_line(&env, &p, member_no, &leaf, &proof)?;
        if reason < REASON_BALANCE_WRONG || reason > REASON_OTHER {
            return Err(Error::BadReason);
        }
        if claimed < 0 || (reason == REASON_NOT_OURS && claimed != 0) {
            return Err(Error::BadClaim);
        }
        if claimed == leaf.balance && claimed_arrears_days == leaf.arrears_days {
            return Err(Error::NotADispute);
        }
        let now = env.ledger().timestamp();
        let late = now > p.confirm_by;
        let mut t = load_tally(&env, period);
        if leaf.kind == KIND_LOAN {
            let ack = if claimed < leaf.balance {
                claimed
            } else {
                leaf.balance
            };
            t.disputed_loans_booked = add(t.disputed_loans_booked, leaf.balance)?;
            t.disputed_loans_ack = add(t.disputed_loans_ack, ack)?;
            if claimed_arrears_days <= cfg.performing_max_days {
                t.recognised_loans = add(t.recognised_loans, ack)?;
            }
        } else if claimed > leaf.balance {
            t.deposit_uplift = add(t.deposit_uplift, claimed - leaf.balance)?;
        }
        let r = Response {
            index: leaf.index,
            member_no,
            kind: leaf.kind,
            verdict: VERDICT_DISPUTED,
            booked: leaf.balance,
            claimed,
            arrears_days: leaf.arrears_days,
            claimed_arrears_days,
            reason,
            evidence_hash,
            at: now,
            late,
        };
        put(
            &env,
            &DataKey::DisputeAt(period, t.disputed_count),
            &leaf.index,
        );
        t.disputed_count += 1;
        record(&env, period, &mut t, &r);
        put(&env, &DataKey::Tally(period), &t);
        DisputeEvent {
            period,
            index: leaf.index,
            member_no,
            kind: leaf.kind,
            booked: leaf.balance,
            claimed,
            reason,
        }
        .publish(&env);
        Ok(())
    }

    /// A member that holds a deposit with the apex but received no line for it claims the
    /// amount. A claim of 0 means "we hold nothing and received no lines" and still counts
    /// as the member's response.
    pub fn claim_omitted(
        env: Env,
        period: u32,
        member_no: u32,
        claimed_deposit: i128,
        evidence_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let (_cfg, _p, _m) = responder(&env, period, member_no)?;
        let key = DataKey::Omitted(period, member_no);
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyClaimed);
        }
        if claimed_deposit < 0 {
            return Err(Error::BadClaim);
        }
        let mut t = load_tally(&env, period);
        t.deposit_uplift = add(t.deposit_uplift, claimed_deposit)?;
        t.omitted_count += 1;
        let c = OmittedClaim {
            member_no,
            claimed_deposit,
            evidence_hash,
            at: env.ledger().timestamp(),
        };
        put(&env, &key, &c);
        put(&env, &DataKey::Tally(period), &t);
        OmittedEvent {
            period,
            member_no,
            claimed_deposit,
        }
        .publish(&env);
        Ok(())
    }

    // -------------------------------------------------------------- custodian

    pub fn attest_cash(
        env: Env,
        period: u32,
        custodian: Address,
        balance: i128,
        as_of: u64,
        statement_hash: BytesN<32>,
    ) -> Result<(), Error> {
        custodian.require_auth();
        let p = load_period(&env, period)?;
        if p.state == PeriodState::Closed {
            return Err(Error::BadState);
        }
        if !p.custodians.contains(&custodian) {
            return Err(Error::NotCustodian);
        }
        if as_of != p.as_of {
            return Err(Error::AsOfMismatch);
        }
        if balance < 0 {
            return Err(Error::BadClaim);
        }
        let key = DataKey::Cash(period, custodian.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyAttested);
        }
        let now = env.ledger().timestamp();
        let late = p.state == PeriodState::Posted && now > p.attest_by;
        let mut t = load_tally(&env, period);
        t.cash = add(t.cash, balance)?;
        t.cash_count += 1;
        t.cash_late = t.cash_late || late;
        put(
            &env,
            &key,
            &CashAttestation {
                custodian: custodian.clone(),
                balance,
                as_of,
                statement_hash,
                at: now,
                late,
            },
        );
        put(&env, &DataKey::Tally(period), &t);
        AttestEvent {
            period,
            custodian,
            balance,
            late,
        }
        .publish(&env);
        Ok(())
    }

    // -------------------------------------------------------------- anyone

    pub fn close_period(env: Env, period: u32) -> Result<Report, Error> {
        let cfg = config(&env)?;
        let mut p = load_period(&env, period)?;
        if p.state != PeriodState::Posted {
            return Err(Error::BadState);
        }
        let now = env.ledger().timestamp();
        let t = load_tally(&env, period);
        if now < p.confirm_by && t.responded < p.leaf_count {
            return Err(Error::TooEarly);
        }
        for c in p.custodians.iter() {
            if !env.storage().persistent().has(&DataKey::Cash(period, c)) {
                return Err(Error::CustodianMissing);
            }
        }
        let r = compute_report(period, cfg.alert_bps, &p.root, p.leaf_count, &t, now)?;
        put(&env, &DataKey::Report(period), &r);
        p.state = PeriodState::Closed;
        put(&env, &DataKey::Period(period), &p);
        iset(&env, &DataKey::LastClosedAt, &now);
        iset(&env, &DataKey::LastReport, &period);
        CloseEvent {
            period,
            coverage_bps: r.coverage_bps,
            booked_coverage_bps: r.booked_coverage_bps,
            unconfirmed_loans: r.unconfirmed_loans,
            flags: r.flags,
        }
        .publish(&env);
        if r.flags & FLAG_BELOW_ALERT != 0 {
            CoverageAlertEvent {
                period,
                coverage_bps: r.coverage_bps,
            }
            .publish(&env);
        }
        Ok(r)
    }

    /// Walk member numbers from the period's cursor, at most `max` numbers per call, and
    /// flag every active member that neither responded to a line nor filed an omitted
    /// claim. Idempotent: the cursor only moves forward. Returns the number flagged.
    pub fn mark_overdue(env: Env, period: u32, max: u32) -> Result<u32, Error> {
        if max > MAX_OVERDUE_PAGE {
            return Err(Error::BatchTooLarge);
        }
        let p = load_period(&env, period)?;
        if p.state == PeriodState::Open {
            return Err(Error::BadState);
        }
        if env.ledger().timestamp() <= p.confirm_by {
            return Err(Error::TooEarly);
        }
        let max_no: u32 = iget(&env, &DataKey::MaxMemberNo).unwrap_or(0);
        let ck = DataKey::OverdueCursor(period);
        let mut cursor: u32 = get(&env, &ck).unwrap_or(1);
        let mut flagged = 0u32;
        let mut steps = 0u32;
        while cursor <= max_no && steps < max {
            if let Some(mut m) = get::<Member>(&env, &DataKey::Member(cursor)) {
                if m.active && m.admitted_at <= p.posted_at {
                    let responded =
                        get::<u32>(&env, &DataKey::MemberResp(period, cursor)).unwrap_or(0) > 0
                            || env
                                .storage()
                                .persistent()
                                .has(&DataKey::Omitted(period, cursor));
                    if responded {
                        m.overdue_streak = 0;
                        m.last_response_period = period;
                    } else {
                        m.overdue_streak += 1;
                        flagged += 1;
                        OverdueEvent {
                            member_no: cursor,
                            period,
                            streak: m.overdue_streak,
                        }
                        .publish(&env);
                    }
                    put(&env, &DataKey::Member(cursor), &m);
                }
            }
            cursor += 1;
            steps += 1;
        }
        put(&env, &ck, &cursor);
        Ok(flagged)
    }

    /// Raise the apex staleness flag when the apex stopped posting: no period open or
    /// posted for more than `max_period_gap_secs` after the last close, or a period open
    /// that long without a root. Set once; cleared by the next `open_period`.
    pub fn flag_stale_apex(env: Env) -> Result<bool, Error> {
        let cfg = config(&env)?;
        let since: u64 = iget(&env, &DataKey::ApexStaleSince).unwrap_or(0);
        if since > 0 {
            return Ok(true);
        }
        let cur: u32 = iget(&env, &DataKey::CurrentPeriod).unwrap_or(0);
        if cur == 0 {
            return Ok(false);
        }
        let now = env.ledger().timestamp();
        let p = load_period(&env, cur)?;
        let last_closed: u64 = iget(&env, &DataKey::LastClosedAt).unwrap_or(0);
        let stale = match p.state {
            PeriodState::Closed => last_closed > 0 && now > last_closed + cfg.max_period_gap_secs,
            PeriodState::Open => now > p.opened_at + cfg.max_period_gap_secs,
            PeriodState::Posted => false,
        };
        if stale {
            iset(&env, &DataKey::ApexStaleSince, &now);
            ApexStaleEvent { since: now }.publish(&env);
        }
        Ok(stale)
    }

    // -------------------------------------------------------------- views

    pub fn config(env: Env) -> Result<Config, Error> {
        config(&env)
    }

    pub fn member(env: Env, no: u32) -> Option<Member> {
        get(&env, &DataKey::Member(no))
    }

    pub fn member_by_board(env: Env, board: Address) -> Option<u32> {
        get(&env, &DataKey::BoardIndex(board))
    }

    pub fn member_count(env: Env) -> u32 {
        iget(&env, &DataKey::MemberCount).unwrap_or(0)
    }

    pub fn custodians(env: Env) -> Vec<Address> {
        custodian_list(&env)
    }

    pub fn current_period(env: Env) -> u32 {
        iget(&env, &DataKey::CurrentPeriod).unwrap_or(0)
    }

    pub fn period(env: Env, id: u32) -> Option<Period> {
        get(&env, &DataKey::Period(id))
    }

    pub fn tally(env: Env, id: u32) -> Option<Tally> {
        get(&env, &DataKey::Tally(id))
    }

    pub fn report(env: Env, id: u32) -> Option<Report> {
        get(&env, &DataKey::Report(id))
    }

    pub fn latest_report(env: Env) -> Option<Report> {
        let id: u32 = iget(&env, &DataKey::LastReport)?;
        get(&env, &DataKey::Report(id))
    }

    pub fn reports(env: Env, from: u32, to: u32) -> Result<Vec<Report>, Error> {
        if to < from || to - from >= MAX_REPORT_RANGE {
            return Err(Error::RangeTooLarge);
        }
        let mut out = Vec::new(&env);
        for id in from..=to {
            if let Some(r) = get::<Report>(&env, &DataKey::Report(id)) {
                out.push_back(r);
            }
        }
        Ok(out)
    }

    pub fn response(env: Env, period: u32, index: u32) -> Option<Response> {
        get(&env, &DataKey::Resp(period, index))
    }

    /// Unresponded line indexes from `from_index`, at most `limit` (≤ 512) of them.
    pub fn unresponded(
        env: Env,
        period: u32,
        from_index: u32,
        limit: u32,
    ) -> Result<Vec<u32>, Error> {
        if limit > MAX_UNRESPONDED_PAGE {
            return Err(Error::RangeTooLarge);
        }
        let p = load_period(&env, period)?;
        let mut out = Vec::new(&env);
        let mut i = from_index;
        let mut word_no = u32::MAX;
        let mut word: u128 = 0;
        while i < p.leaf_count && out.len() < limit {
            if i / 128 != word_no {
                word_no = i / 128;
                word = get(&env, &DataKey::RespBits(period, word_no)).unwrap_or(0);
            }
            if word & (1u128 << (i % 128)) == 0 {
                out.push_back(i);
            }
            i += 1;
        }
        Ok(out)
    }

    /// Disputed responses in the order they were filed, from ordinal `from`, at most `limit` (≤ 32).
    pub fn disputes(env: Env, period: u32, from: u32, limit: u32) -> Result<Vec<Response>, Error> {
        if limit > MAX_DISPUTE_PAGE {
            return Err(Error::RangeTooLarge);
        }
        let t = load_tally(&env, period);
        let mut out = Vec::new(&env);
        let end = core::cmp::min(t.disputed_count, from.saturating_add(limit));
        let mut n = from;
        while n < end {
            if let Some(idx) = get::<u32>(&env, &DataKey::DisputeAt(period, n)) {
                if let Some(r) = get::<Response>(&env, &DataKey::Resp(period, idx)) {
                    out.push_back(r);
                }
            }
            n += 1;
        }
        Ok(out)
    }

    pub fn cash(env: Env, period: u32) -> Vec<CashAttestation> {
        let mut out = Vec::new(&env);
        if let Some(p) = get::<Period>(&env, &DataKey::Period(period)) {
            for c in p.custodians.iter() {
                if let Some(a) = get::<CashAttestation>(&env, &DataKey::Cash(period, c)) {
                    out.push_back(a);
                }
            }
        }
        out
    }

    pub fn omitted(env: Env, period: u32, member_no: u32) -> Option<OmittedClaim> {
        get(&env, &DataKey::Omitted(period, member_no))
    }

    pub fn member_responses(env: Env, period: u32, member_no: u32) -> u32 {
        get(&env, &DataKey::MemberResp(period, member_no)).unwrap_or(0)
    }

    pub fn apex_stale_since(env: Env) -> u64 {
        iget(&env, &DataKey::ApexStaleSince).unwrap_or(0)
    }
}

#[cfg(test)]
mod test;

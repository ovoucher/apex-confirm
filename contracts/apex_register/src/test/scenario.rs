//! `scenario_kuscco_pattern`: the seeded journey over two periods, replayed from the
//! vectors that `app/src/seed/generate.ts` writes from `data/seed/`. All numbers are
//! Simulated; they illustrate the mechanism only.
extern crate std;

use super::util::*;
use crate::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env, Symbol, Vec};

/// Seed plan constants (data/seed/expected.json).
const ROOT_DEP: i128 = 2_480_000_000_00;
const ROOT_LOAN: i128 = 2_236_900_000_00;
const LIABILITIES: i128 = 2_510_500_000_00;
const RECOGNISED: i128 = 1_654_600_000_00;
const CASH_AUG: i128 = 305_412_318_55;
const COLLUDING_LOAN: i128 = 48_000_000_00;

struct Replay<'a> {
    env: &'a Env,
    c: &'a ApexRegisterClient<'static>,
    boards: &'a std::vec::Vec<Address>,
    custodian: &'a Address,
}

impl<'a> Replay<'a> {
    /// Run the vector's custodian attestation and member actions in time order.
    fn respond(&self, v: &serde_json::Value, p: u32, tree: &Tree) {
        let cash_at = js_u64(&v["cash"]["at"]);
        let mut cash_done = cash_at < js_u64(&v["post_at"]);
        for a in v["actions"].as_array().unwrap() {
            let at = js_u64(&a["at"]);
            if !cash_done && cash_at <= at {
                self.attest(v, p);
                cash_done = true;
            }
            self.env.ledger().set_timestamp(at);
            let m = js_u32(&a["member"]);
            match a["type"].as_str().unwrap() {
                "confirm" => {
                    let idx: std::vec::Vec<u32> = a["indexes"].as_array().unwrap().iter().map(js_u32).collect();
                    for chunk in idx.chunks(16) {
                        let mut items = Vec::new(self.env);
                        for i in chunk {
                            items.push_back((tree.leaf(*i), tree.proof(*i)));
                        }
                        self.c.confirm_batch(&p, &m, &items);
                    }
                }
                "dispute" => {
                    let i = js_u32(&a["index"]);
                    self.c.dispute(
                        &p,
                        &m,
                        &tree.leaf(i),
                        &tree.proof(i),
                        &js_i128(&a["claimed"]),
                        &js_u32(&a["claimed_arrears"]),
                        &js_u32(&a["reason"]),
                        &hex32(self.env, a["evidence"].as_str().unwrap()),
                    );
                }
                "omitted" => {
                    self.c.claim_omitted(&p, &m, &js_i128(&a["claimed"]), &hex32(self.env, a["evidence"].as_str().unwrap()));
                }
                other => panic!("unknown action {other}"),
            }
        }
        if !cash_done {
            self.attest(v, p);
        }
    }

    fn attest(&self, v: &serde_json::Value, p: u32) {
        self.env.ledger().set_timestamp(js_u64(&v["cash"]["at"]));
        self.c.attest_cash(&p, self.custodian, &js_i128(&v["cash"]["balance"]), &js_u64(&v["as_of"]), &h(self.env, "statement"));
    }

    fn watch(&self, p: u32) {
        let mut flagged = 0;
        flagged += self.c.mark_overdue(&p, &25);
        flagged += self.c.mark_overdue(&p, &25);
        assert_eq!(self.c.mark_overdue(&p, &25), 0);
        assert_eq!(flagged, 1, "exactly one active member stayed silent");
        let _ = self.boards;
    }
}

fn expect_report(r: &Report, e: &serde_json::Value) {
    assert_eq!(r.liabilities, js_i128(&e["liabilities"]));
    assert_eq!(r.cash, js_i128(&e["cash"]));
    assert_eq!(r.recognised_loans, js_i128(&e["recognised_loans"]));
    assert_eq!(r.booked_loans, js_i128(&e["booked_loans"]));
    assert_eq!(r.unconfirmed_loans, js_i128(&e["unconfirmed_loans"]));
    assert_eq!(r.coverage_bps, js_i128(&e["coverage_bps"]));
    assert_eq!(r.booked_coverage_bps, js_i128(&e["booked_coverage_bps"]));
    assert_eq!(r.unresponded, js_u32(&e["unresponded"]));
    assert_eq!(r.disputed, js_u32(&e["disputed"]));
    assert_eq!(r.late, js_u32(&e["late"]));
    assert_eq!(r.omitted, js_u32(&e["omitted"]));
    assert_eq!(r.flags, js_u32(&e["flags"]));
}

#[test]
fn scenario_kuscco_pattern() {
    let v1 = load_vector("seed-period-1.json");
    let v2 = load_vector("seed-period-2.json");

    // ------------------------------------------------ 1. init, 40 members (38 dormant), custodian
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();
    env.ledger().set_timestamp(js_u64(&v1["open_at"]) - 7 * DAY);
    let id = env.register(ApexRegister, ());
    let c = ApexRegisterClient::new(&env, &id);
    let registrar = Address::generate(&env);
    let apex = Address::generate(&env);
    let custodian = Address::generate(&env);
    c.init(&registrar, &apex, &Symbol::new(&env, "KES"), &2, &CONFIRM_WINDOW, &ATTEST_WINDOW, &MAX_GAP, &90, &10_000);
    let mut boards = std::vec![apex.clone()];
    for no in 1..=40u32 {
        let b = Address::generate(&env);
        c.register_member(&no, &b, &h(&env, &std::format!("SIM/DT/{no:04}")));
        boards.push(b);
    }
    c.set_member_active(&38, &false);
    c.set_custodian(&custodian, &true);
    let rp = Replay { env: &env, c: &c, boards: &boards, custodian: &custodian };

    // ------------------------------------------------ 2. open for 2026-08-31, post the 159-line root
    let leaves: std::vec::Vec<Leaf> = v1["leaves"].as_array().unwrap().iter().map(|j| leaf_from_json(&env, j)).collect();
    let tree = Tree::from_leaves(&env, 1, leaves);
    assert_eq!(tree.leaf_count(), 159);
    assert_eq!(tree.root().dep, ROOT_DEP);
    assert_eq!(tree.root().loan, ROOT_LOAN);
    env.ledger().set_timestamp(js_u64(&v1["open_at"]));
    let p1 = c.open_period(&js_u64(&v1["as_of"]), &0);
    assert_eq!(p1, 1);
    env.ledger().set_timestamp(js_u64(&v1["post_at"]));
    c.post_root(&p1, &tree.root(), &159, &hex32(&env, v1["file_hash"].as_str().unwrap()));

    // Lines booked to non-members (901-903) and to dormant member 38 can never be confirmed.
    for (i, l) in tree.leaves.iter().enumerate() {
        if l.cp > 40 {
            assert_eq!(c.try_confirm(&p1, &l.cp, l, &tree.proof(i as u32)), Err(Ok(Error::UnknownMember)));
        }
        if l.cp == 38 {
            assert_eq!(c.try_confirm(&p1, &38, l, &tree.proof(i as u32)), Err(Ok(Error::MemberInactive)));
        }
    }

    // ------------------------------------------------ 3. responses per responses-plan.json; custodian on day 3
    rp.respond(&v1, p1, &tree);
    let cash = c.cash(&p1);
    assert_eq!(cash.get(0).unwrap().balance, CASH_AUG);
    assert!(!cash.get(0).unwrap().late);
    // members 11 and 29 responded after the window
    for no in [11u32, 29] {
        for i in tree.lines_of(no) {
            assert!(c.response(&p1, &i).unwrap().late, "member {no} line {i} is late");
        }
    }
    // member 22 never responded
    for i in tree.lines_of(22) {
        assert!(c.response(&p1, &i).is_none());
    }

    // ------------------------------------------------ 4. watch: mark_overdue flags member 22
    env.ledger().set_timestamp(js_u64(&v1["watch_at"]));
    rp.watch(p1);
    for no in 1..=40u32 {
        let m = c.member(&no).unwrap();
        let want = if no == 22 { 1 } else { 0 };
        assert_eq!(m.overdue_streak, want, "member {no}");
    }
    assert!(!c.flag_stale_apex());

    // ------------------------------------------------ 5. close: 7807 vs 10251 bps
    let r1 = c.close_period(&p1);
    assert_eq!(r1.coverage_bps, 7807);
    assert_eq!(r1.booked_coverage_bps, 10251);
    assert_eq!(r1.liabilities, LIABILITIES);
    assert_eq!(r1.recognised_loans, RECOGNISED);
    assert_eq!(
        r1.flags,
        FLAG_BELOW_ALERT | FLAG_UNCONFIRMED_LOANS | FLAG_DISPUTES | FLAG_LATE_RESPONSES | FLAG_OMITTED_CLAIMS | FLAG_GAP_WIDE
    );
    assert_eq!(r1.unresponded, 10);
    expect_report(&r1, &v1["expected"]);
    let t1 = c.tally(&p1).unwrap();
    assert_eq!(t1.deposit_uplift, 18_500_000_00 + 12_000_000_00);
    assert_eq!(c.omitted(&p1, &33).unwrap().claimed_deposit, 12_000_000_00);

    // ------------------------------------------------ 6. the known limitation: the colluding loan counts
    let ci = js_u32(&v1["colluding_index"]);
    let collusion = c.response(&p1, &ci).unwrap();
    assert_eq!(collusion.member_no, 37);
    assert_eq!(collusion.verdict, VERDICT_CONFIRMED);
    assert_eq!(collusion.booked, COLLUDING_LOAN);
    assert!(collusion.arrears_days <= 90, "so it is recognised: confirmation cannot catch collusion");

    // ------------------------------------------------ 7. period 2: the apex stalls for 50 days
    let open2 = js_u64(&v2["open_at"]);
    env.ledger().set_timestamp(open2);
    let p2 = c.open_period(&js_u64(&v2["as_of"]), &0);
    assert_eq!(p2, 2);
    assert_eq!(c.apex_stale_since(), 0);
    let tree2 = Tree::from_leaves(
        &env,
        2,
        v2["leaves"].as_array().unwrap().iter().map(|j| leaf_from_json(&env, j)).collect(),
    );
    // custodian attests while the period is still open
    rp.attest(&v2, p2);
    for chk in v2["stale_checks"].as_array().unwrap() {
        env.ledger().set_timestamp(js_u64(&chk["at"]));
        assert_eq!(c.flag_stale_apex(), chk["expect"].as_bool().unwrap());
    }
    env.ledger().set_timestamp(open2 + 50 * DAY);
    assert!(c.apex_stale_since() > 0, "apex_stale_since set after 50 days without a root");
    env.ledger().set_timestamp(js_u64(&v2["post_at"]));
    c.post_root(&p2, &tree2.root(), &tree2.leaf_count(), &hex32(&env, v2["file_hash"].as_str().unwrap()));
    rp.respond(&v2, p2, &tree2);
    env.ledger().set_timestamp(js_u64(&v2["watch_at"]));
    rp.watch(p2);
    assert_eq!(c.member(&22).unwrap().overdue_streak, 2, "member 22 silent two periods running");
    assert_eq!(c.member(&11).unwrap().overdue_streak, 0);
    let r2 = c.close_period(&p2);
    expect_report(&r2, &v2["expected"]);
    assert_eq!(c.reports(&1, &2).len(), 2);
    // reports are frozen
    assert_eq!(c.report(&p1).unwrap(), r1);
}

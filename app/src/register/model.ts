/**
 * Offline mirror of `apex_register`: the same state machine, checks (in the same order),
 * tally rules, report formulas and error codes. Used by `apex --offline`, by `apex
 * simulate` and by the tests. It is NOT a substitute for the contract: signature checks
 * are modelled as a set of addresses that authorised the call (the real 2-of-3 board
 * signature path is exercised in the Rust tests).
 */
import { KIND_DEPOSIT, KIND_LOAN, type Leaf, leafNode } from "../tree/leaf.js";
import { MAX_LEAVES, type SumNode, depthFor, nodesEqual } from "../tree/node.js";
import { NegativeSumError, rootFromProof } from "../tree/proof.js";
import { OverflowError, checkedAdd } from "../util/hash.js";
import { computeReport } from "../report/coverage.js";
import { FLAGS } from "../report/flags.js";
import { AuthError, ContractError, type ErrorName, REASON } from "./errors.js";
import {
  type CashAttestation,
  type Config,
  type Member,
  type NodeHex,
  type OmittedClaim,
  type Period,
  type Report,
  type Response,
  type Tally,
  emptyTally,
} from "./types.js";

export const MAX_MEMBER_NO = 1024;
export const MAX_CUSTODIANS = 4;
export const MAX_BATCH = 16;
export const MAX_OVERDUE_PAGE = 25;
export const MAX_REPORT_RANGE = 24;
export const MAX_UNRESPONDED_PAGE = 512;
export const MAX_DISPUTE_PAGE = 32;

export type EventRecord = { name: string; topics: (string | number)[]; data: unknown; at: number };

export interface ModelState {
  now: number;
  config: Config | null;
  currentPeriod: number;
  lastClosedAt: number;
  lastReport: number;
  memberCount: number;
  maxMemberNo: number;
  apexStaleSince: number;
  custodians: string[];
  custodianFlag: Record<string, boolean>;
  members: Record<string, Member>;
  boardIndex: Record<string, number>;
  periods: Record<string, Period>;
  tallies: Record<string, Tally>;
  reports: Record<string, Report>;
  responses: Record<string, Response>;
  respBits: Record<string, boolean>;
  memberResp: Record<string, number>;
  omitted: Record<string, OmittedClaim>;
  cash: Record<string, CashAttestation>;
  overdueCursor: Record<string, number>;
  disputeAt: Record<string, number>;
  events: EventRecord[];
}

export function emptyState(now = 0): ModelState {
  return {
    now,
    config: null,
    currentPeriod: 0,
    lastClosedAt: 0,
    lastReport: 0,
    memberCount: 0,
    maxMemberNo: 0,
    apexStaleSince: 0,
    custodians: [],
    custodianFlag: {},
    members: {},
    boardIndex: {},
    periods: {},
    tallies: {},
    reports: {},
    responses: {},
    respBits: {},
    memberResp: {},
    omitted: {},
    cash: {},
    overdueCursor: {},
    disputeAt: {},
    events: [],
  };
}

const ZERO32 = "00".repeat(32);
const k2 = (a: number | string, b: number | string): string => `${a}:${b}`;

function fail(name: ErrorName): never {
  throw new ContractError(name);
}

function toHexNode(n: SumNode): NodeHex {
  return { hash: n.hash.toString("hex"), dep: n.dep, loan: n.loan };
}

/** Caller context: the addresses whose authorisation is attached to the call. */
export type Auth = readonly string[];

export class RegisterModel {
  constructor(public state: ModelState = emptyState()) {}

  // ------------------------------------------------------------------ plumbing

  setTime(t: number): void {
    this.state.now = t;
  }

  get now(): number {
    return this.state.now;
  }

  /** All-or-nothing, like a failed transaction: state is restored on any throw. */
  private tx<T>(f: () => T): T {
    const snap = structuredClone(this.state);
    try {
      return f();
    } catch (e) {
      this.state = snap;
      if (e instanceof OverflowError) throw new ContractError("Overflow");
      if (e instanceof NegativeSumError) throw new ContractError("NegativeSum");
      throw e;
    }
  }

  private requireAuth(auth: Auth, addr: string): void {
    if (!auth.includes(addr)) throw new AuthError(addr);
  }

  private emit(name: string, topics: (string | number)[], data: unknown): void {
    this.state.events.push({ name, topics, data, at: this.state.now });
  }

  private cfg(): Config {
    return this.state.config ?? fail("NotInitialised");
  }

  private period_(id: number): Period {
    return this.state.periods[id] ?? fail("BadState");
  }

  private member_(no: number): Member {
    return this.state.members[no] ?? fail("UnknownMember");
  }

  private tally_(id: number): Tally {
    return this.state.tallies[id] ?? emptyTally();
  }

  private isCustodian(a: string): boolean {
    return this.state.custodianFlag[a] === true;
  }

  private isBoard(a: string): boolean {
    return this.state.boardIndex[a] !== undefined;
  }

  private checkBoardFree(cfg: Config, board: string): void {
    if (board === cfg.apex || board === cfg.registrar || this.isBoard(board) || this.isCustodian(board)) fail("RoleConflict");
  }

  // ------------------------------------------------------------------ setup and roles

  init(auth: Auth, c: Config): void {
    this.tx(() => {
      if (this.state.config) fail("AlreadyInitialised");
      this.requireAuth(auth, c.registrar);
      if (
        c.confirm_window_secs <= 0 ||
        c.attest_window_secs <= 0 ||
        c.max_period_gap_secs <= 0 ||
        c.attest_window_secs > c.confirm_window_secs ||
        c.alert_bps < 1 ||
        c.alert_bps > 20_000
      )
        fail("BadConfig");
      if (c.registrar === c.apex) fail("RoleConflict");
      this.state.config = { ...c };
    });
  }

  registerMember(auth: Auth, no: number, board: string, licenceHash: string): void {
    this.tx(() => {
      const cfg = this.cfg();
      this.requireAuth(auth, cfg.registrar);
      if (no < 1 || no > MAX_MEMBER_NO) fail("BadMemberNo");
      if (this.state.members[no]) fail("MemberExists");
      this.checkBoardFree(cfg, board);
      this.state.members[no] = {
        no,
        board,
        licence_hash: licenceHash,
        active: true,
        admitted_at: this.now,
        overdue_streak: 0,
        last_response_period: 0,
      };
      this.state.boardIndex[board] = no;
      this.state.memberCount += 1;
      this.state.maxMemberNo = Math.max(this.state.maxMemberNo, no);
      this.emit("member", [no], { board, active: true });
    });
  }

  setMemberActive(auth: Auth, no: number, active: boolean): void {
    this.tx(() => {
      this.requireAuth(auth, this.cfg().registrar);
      const m = this.member_(no);
      m.active = active;
      this.emit("member", [no], { board: m.board, active });
    });
  }

  rotateBoard(auth: Auth, no: number, newBoard: string): void {
    this.tx(() => {
      const cfg = this.cfg();
      this.requireAuth(auth, cfg.registrar);
      const m = this.member_(no);
      this.checkBoardFree(cfg, newBoard);
      delete this.state.boardIndex[m.board];
      m.board = newBoard;
      this.state.boardIndex[newBoard] = no;
      this.emit("member", [no], { board: newBoard, active: m.active });
    });
  }

  setCustodian(auth: Auth, custodian: string, active: boolean): void {
    this.tx(() => {
      const cfg = this.cfg();
      this.requireAuth(auth, cfg.registrar);
      const list = this.state.custodians;
      const pos = list.indexOf(custodian);
      if (active) {
        if (custodian === cfg.apex || custodian === cfg.registrar || this.isBoard(custodian)) fail("RoleConflict");
        if (pos < 0) {
          if (list.length >= MAX_CUSTODIANS) fail("TooManyCustodians");
          list.push(custodian);
        }
      } else if (pos >= 0) list.splice(pos, 1);
      this.state.custodianFlag[custodian] = active;
      this.emit("custodian", [custodian], active);
    });
  }

  setApex(auth: Auth, newApex: string): void {
    this.tx(() => {
      const cfg = this.cfg();
      this.requireAuth(auth, cfg.registrar);
      if (newApex === cfg.registrar || this.isBoard(newApex) || this.isCustodian(newApex)) fail("RoleConflict");
      cfg.apex = newApex;
    });
  }

  transferRegistrar(auth: Auth, newRegistrar: string): void {
    this.tx(() => {
      const cfg = this.cfg();
      this.requireAuth(auth, cfg.registrar);
      this.requireAuth(auth, newRegistrar);
      if (newRegistrar === cfg.apex || this.isBoard(newRegistrar) || this.isCustodian(newRegistrar)) fail("RoleConflict");
      cfg.registrar = newRegistrar;
    });
  }

  // ------------------------------------------------------------------ apex

  openPeriod(auth: Auth, asOf: number, supersedes: number): number {
    return this.tx(() => {
      const cfg = this.cfg();
      this.requireAuth(auth, cfg.apex);
      const cur = this.state.currentPeriod;
      if (cur > 0) {
        const prev = this.period_(cur);
        if (prev.state !== "Closed") fail("PreviousNotClosed");
        if (asOf < prev.as_of || (asOf === prev.as_of && supersedes !== cur)) fail("AsOfNotIncreasing");
      }
      if (asOf > this.now) fail("FutureAsOf");
      if (supersedes !== 0) {
        const p = this.state.periods[supersedes];
        if (!(supersedes <= cur && p && p.state === "Closed")) fail("BadSupersedes");
      }
      if (this.state.custodians.length === 0) fail("NoCustodian");
      const id = cur + 1;
      this.state.periods[id] = {
        id,
        as_of: asOf,
        opened_at: this.now,
        supersedes,
        root: { hash: ZERO32, dep: 0n, loan: 0n },
        leaf_count: 0,
        depth: 0,
        file_hash: ZERO32,
        posted_at: 0,
        confirm_by: 0,
        attest_by: 0,
        custodians: [...this.state.custodians],
        state: "Open",
      };
      this.state.tallies[id] = emptyTally();
      this.state.currentPeriod = id;
      this.state.apexStaleSince = 0;
      this.emit("open", [id], { as_of: asOf, supersedes });
      return id;
    });
  }

  postRoot(auth: Auth, period: number, root: SumNode, leafCount: number, fileHash: string): void {
    this.tx(() => {
      const cfg = this.cfg();
      this.requireAuth(auth, cfg.apex);
      const p = this.period_(period);
      if (p.state !== "Open") fail("BadState");
      if (leafCount < 1 || leafCount > MAX_LEAVES) fail("BadLeafCount");
      if (root.dep < 0n || root.loan < 0n) fail("NegativeSum");
      p.root = toHexNode(root);
      p.leaf_count = leafCount;
      p.depth = depthFor(leafCount);
      p.file_hash = fileHash;
      p.posted_at = this.now;
      p.confirm_by = this.now + cfg.confirm_window_secs;
      p.attest_by = this.now + cfg.attest_window_secs;
      p.state = "Posted";
      this.emit("post", [period], { hash: p.root.hash, dep: root.dep, loan: root.loan, leaf_count: leafCount, file_hash: fileHash });
    });
  }

  // ------------------------------------------------------------------ member boards

  private responder(auth: Auth, periodId: number, memberNo: number): { cfg: Config; p: Period; m: Member } {
    const cfg = this.cfg();
    const p = this.period_(periodId);
    if (p.state !== "Posted") fail("BadState");
    const m = this.member_(memberNo);
    this.requireAuth(auth, m.board);
    if (!m.active) fail("MemberInactive");
    return { cfg, p, m };
  }

  private checkLine(p: Period, memberNo: number, leaf: Leaf, proof: SumNode[]): void {
    if (leaf.period !== p.id) fail("WrongPeriod");
    if (leaf.index >= p.leaf_count) fail("BadIndex");
    if (leaf.cp !== memberNo) fail("NotYourLeaf");
    if ((leaf.kind !== KIND_DEPOSIT && leaf.kind !== KIND_LOAN) || leaf.balance < 0n) fail("BadLeaf");
    if (proof.length !== p.depth) fail("BadProof");
    const r = rootFromProof(leafNode(leaf), leaf.index, proof);
    if (!nodesEqual(r, { hash: Buffer.from(p.root.hash, "hex"), dep: p.root.dep, loan: p.root.loan })) fail("BadProof");
    if (this.state.respBits[k2(p.id, leaf.index)]) fail("AlreadyResponded");
  }

  private record(p: Period, t: Tally, r: Response): void {
    this.state.responses[k2(p.id, r.index)] = r;
    this.state.respBits[k2(p.id, r.index)] = true;
    t.responded += 1;
    if (r.late) t.late += 1;
    const mk = k2(p.id, r.member_no);
    this.state.memberResp[mk] = (this.state.memberResp[mk] ?? 0) + 1;
  }

  private doConfirm(cfg: Config, p: Period, t: Tally, memberNo: number, leaf: Leaf, proof: SumNode[]): void {
    this.checkLine(p, memberNo, leaf, proof);
    const late = this.now > p.confirm_by;
    if (leaf.kind === KIND_DEPOSIT) t.confirmed_dep = checkedAdd(t.confirmed_dep, leaf.balance);
    else {
      t.confirmed_loans = checkedAdd(t.confirmed_loans, leaf.balance);
      if (leaf.arrearsDays <= cfg.performing_max_days) t.recognised_loans = checkedAdd(t.recognised_loans, leaf.balance);
    }
    this.record(p, t, {
      index: leaf.index,
      member_no: memberNo,
      kind: leaf.kind,
      verdict: 1,
      booked: leaf.balance,
      claimed: leaf.balance,
      arrears_days: leaf.arrearsDays,
      claimed_arrears_days: leaf.arrearsDays,
      reason: 0,
      evidence_hash: ZERO32,
      at: this.now,
      late,
    });
    this.emit("confirm", [p.id], { index: leaf.index, member_no: memberNo, kind: leaf.kind, booked: leaf.balance, late });
  }

  confirm(auth: Auth, period: number, memberNo: number, leaf: Leaf, proof: SumNode[]): void {
    this.tx(() => {
      const { cfg, p } = this.responder(auth, period, memberNo);
      const t = this.tally_(period);
      this.doConfirm(cfg, p, t, memberNo, leaf, proof);
      this.state.tallies[period] = t;
    });
  }

  confirmBatch(auth: Auth, period: number, memberNo: number, items: { leaf: Leaf; proof: SumNode[] }[]): void {
    this.tx(() => {
      if (items.length > MAX_BATCH) fail("BatchTooLarge");
      const { cfg, p } = this.responder(auth, period, memberNo);
      const t = this.tally_(period);
      for (const it of items) this.doConfirm(cfg, p, t, memberNo, it.leaf, it.proof);
      this.state.tallies[period] = t;
    });
  }

  dispute(
    auth: Auth,
    period: number,
    memberNo: number,
    leaf: Leaf,
    proof: SumNode[],
    claimed: bigint,
    claimedArrears: number,
    reason: number,
    evidenceHash: string,
  ): void {
    this.tx(() => {
      const { cfg, p } = this.responder(auth, period, memberNo);
      this.checkLine(p, memberNo, leaf, proof);
      if (reason < REASON.BALANCE_WRONG || reason > REASON.OTHER) fail("BadReason");
      if (claimed < 0n || (reason === REASON.NOT_OURS && claimed !== 0n)) fail("BadClaim");
      if (claimed === leaf.balance && claimedArrears === leaf.arrearsDays) fail("NotADispute");
      const late = this.now > p.confirm_by;
      const t = this.tally_(period);
      if (leaf.kind === KIND_LOAN) {
        const ack = claimed < leaf.balance ? claimed : leaf.balance;
        t.disputed_loans_booked = checkedAdd(t.disputed_loans_booked, leaf.balance);
        t.disputed_loans_ack = checkedAdd(t.disputed_loans_ack, ack);
        if (claimedArrears <= cfg.performing_max_days) t.recognised_loans = checkedAdd(t.recognised_loans, ack);
      } else if (claimed > leaf.balance) {
        t.deposit_uplift = checkedAdd(t.deposit_uplift, claimed - leaf.balance);
      }
      this.state.disputeAt[k2(period, t.disputed_count)] = leaf.index;
      t.disputed_count += 1;
      this.record(p, t, {
        index: leaf.index,
        member_no: memberNo,
        kind: leaf.kind,
        verdict: 2,
        booked: leaf.balance,
        claimed,
        arrears_days: leaf.arrearsDays,
        claimed_arrears_days: claimedArrears,
        reason,
        evidence_hash: evidenceHash,
        at: this.now,
        late,
      });
      this.state.tallies[period] = t;
      this.emit("dispute", [period], { index: leaf.index, member_no: memberNo, kind: leaf.kind, booked: leaf.balance, claimed, reason });
    });
  }

  claimOmitted(auth: Auth, period: number, memberNo: number, claimedDeposit: bigint, evidenceHash: string): void {
    this.tx(() => {
      this.responder(auth, period, memberNo);
      const key = k2(period, memberNo);
      if (this.state.omitted[key]) fail("AlreadyClaimed");
      if (claimedDeposit < 0n) fail("BadClaim");
      const t = this.tally_(period);
      t.deposit_uplift = checkedAdd(t.deposit_uplift, claimedDeposit);
      t.omitted_count += 1;
      this.state.omitted[key] = { member_no: memberNo, claimed_deposit: claimedDeposit, evidence_hash: evidenceHash, at: this.now };
      this.state.tallies[period] = t;
      this.emit("omitted", [period], { member_no: memberNo, claimed_deposit: claimedDeposit });
    });
  }

  // ------------------------------------------------------------------ custodian

  attestCash(auth: Auth, period: number, custodian: string, balance: bigint, asOf: number, statementHash: string): void {
    this.tx(() => {
      this.requireAuth(auth, custodian);
      const p = this.period_(period);
      if (p.state === "Closed") fail("BadState");
      if (!p.custodians.includes(custodian)) fail("NotCustodian");
      if (asOf !== p.as_of) fail("AsOfMismatch");
      if (balance < 0n) fail("BadClaim");
      const key = k2(period, custodian);
      if (this.state.cash[key]) fail("AlreadyAttested");
      const late = p.state === "Posted" && this.now > p.attest_by;
      const t = this.tally_(period);
      t.cash = checkedAdd(t.cash, balance);
      t.cash_count += 1;
      t.cash_late = t.cash_late || late;
      this.state.cash[key] = { custodian, balance, as_of: asOf, statement_hash: statementHash, at: this.now, late };
      this.state.tallies[period] = t;
      this.emit("attest", [period], { custodian, balance, late });
    });
  }

  // ------------------------------------------------------------------ anyone

  closePeriod(period: number): Report {
    return this.tx(() => {
      const cfg = this.cfg();
      const p = this.period_(period);
      if (p.state !== "Posted") fail("BadState");
      const t = this.tally_(period);
      if (this.now < p.confirm_by && t.responded < p.leaf_count) fail("TooEarly");
      for (const c of p.custodians) if (!this.state.cash[k2(period, c)]) fail("CustodianMissing");
      const r = computeReport(period, cfg.alert_bps, p.root, p.leaf_count, t, this.now);
      this.state.reports[period] = r;
      p.state = "Closed";
      this.state.lastClosedAt = this.now;
      this.state.lastReport = period;
      this.emit("close", [period], { coverage_bps: r.coverage_bps, booked_coverage_bps: r.booked_coverage_bps, unconfirmed_loans: r.unconfirmed_loans, flags: r.flags });
      if (r.flags & FLAGS.BELOW_ALERT) this.emit("coverage_alert", [period], r.coverage_bps);
      return structuredClone(r);
    });
  }

  markOverdue(period: number, max: number): number {
    return this.tx(() => {
      if (max > MAX_OVERDUE_PAGE) fail("BatchTooLarge");
      const p = this.period_(period);
      if (p.state === "Open") fail("BadState");
      if (this.now <= p.confirm_by) fail("TooEarly");
      let cursor = this.state.overdueCursor[period] ?? 1;
      let flagged = 0;
      let steps = 0;
      while (cursor <= this.state.maxMemberNo && steps < max) {
        const m = this.state.members[cursor];
        if (m && m.active && m.admitted_at <= p.posted_at) {
          const responded = (this.state.memberResp[k2(period, cursor)] ?? 0) > 0 || this.state.omitted[k2(period, cursor)] !== undefined;
          if (responded) {
            m.overdue_streak = 0;
            m.last_response_period = period;
          } else {
            m.overdue_streak += 1;
            flagged += 1;
            this.emit("overdue", [cursor], { period, streak: m.overdue_streak });
          }
        }
        cursor += 1;
        steps += 1;
      }
      this.state.overdueCursor[period] = cursor;
      return flagged;
    });
  }

  flagStaleApex(): boolean {
    return this.tx(() => {
      const cfg = this.cfg();
      if (this.state.apexStaleSince > 0) return true;
      const cur = this.state.currentPeriod;
      if (cur === 0) return false;
      const p = this.period_(cur);
      let stale = false;
      if (p.state === "Closed") stale = this.state.lastClosedAt > 0 && this.now > this.state.lastClosedAt + cfg.max_period_gap_secs;
      else if (p.state === "Open") stale = this.now > p.opened_at + cfg.max_period_gap_secs;
      if (stale) {
        this.state.apexStaleSince = this.now;
        this.emit("apex_stale", [], this.now);
      }
      return stale;
    });
  }

  // ------------------------------------------------------------------ views

  config(): Config {
    return this.cfg();
  }
  member(no: number): Member | null {
    return this.state.members[no] ?? null;
  }
  memberByBoard(board: string): number | null {
    return this.state.boardIndex[board] ?? null;
  }
  period(id: number): Period | null {
    return this.state.periods[id] ?? null;
  }
  tally(id: number): Tally | null {
    return this.state.tallies[id] ?? null;
  }
  report(id: number): Report | null {
    return this.state.reports[id] ?? null;
  }
  latestReport(): Report | null {
    return this.state.lastReport ? (this.state.reports[this.state.lastReport] ?? null) : null;
  }
  reports(from: number, to: number): Report[] {
    if (to < from || to - from >= MAX_REPORT_RANGE) fail("RangeTooLarge");
    const out: Report[] = [];
    for (let i = from; i <= to; i++) if (this.state.reports[i]) out.push(this.state.reports[i]!);
    return out;
  }
  response(period: number, index: number): Response | null {
    return this.state.responses[k2(period, index)] ?? null;
  }
  unresponded(period: number, fromIndex: number, limit: number): number[] {
    if (limit > MAX_UNRESPONDED_PAGE) fail("RangeTooLarge");
    const p = this.period_(period);
    const out: number[] = [];
    for (let i = fromIndex; i < p.leaf_count && out.length < limit; i++) if (!this.state.respBits[k2(period, i)]) out.push(i);
    return out;
  }
  disputes(period: number, from: number, limit: number): Response[] {
    if (limit > MAX_DISPUTE_PAGE) fail("RangeTooLarge");
    const t = this.tally_(period);
    const out: Response[] = [];
    for (let n = from; n < Math.min(t.disputed_count, from + limit); n++) {
      const idx = this.state.disputeAt[k2(period, n)];
      if (idx !== undefined) out.push(this.state.responses[k2(period, idx)]!);
    }
    return out;
  }
  cashOf(period: number): CashAttestation[] {
    const p = this.state.periods[period];
    if (!p) return [];
    return p.custodians.map((c) => this.state.cash[k2(period, c)]).filter((x): x is CashAttestation => !!x);
  }
  omittedOf(period: number, memberNo: number): OmittedClaim | null {
    return this.state.omitted[k2(period, memberNo)] ?? null;
  }
  memberResponses(period: number, memberNo: number): number {
    return this.state.memberResp[k2(period, memberNo)] ?? 0;
  }
  apexStaleSince(): number {
    return this.state.apexStaleSince;
  }
  /** All responses of a period (offline convenience; on-chain this comes from events or `response`). */
  responsesOf(period: number): Response[] {
    return Object.entries(this.state.responses)
      .filter(([k]) => k.startsWith(`${period}:`))
      .map(([, v]) => v)
      .sort((a, b) => a.index - b.index);
  }
}

// ------------------------------------------------------------------ persistence

export function serializeState(s: ModelState): string {
  return JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), 2);
}

export function deserializeState(text: string): ModelState {
  return JSON.parse(text, (_k, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as ModelState;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { RegisterModel, deserializeState, serializeState } from "../src/register/model.js";
import { AuthError, ContractError, ERRORS, type ErrorName } from "../src/register/errors.js";
import type { Config } from "../src/register/types.js";
import { FLAGS } from "../src/report/flags.js";
import { type Spec, smallTree } from "./helpers.js";

const DAY = 86_400;
const AS_OF = 1_788_134_400; // 2026-08-31
const T_OPEN = 1_788_246_000; // 2026-09-01T07:00Z
const R = ["REGISTRAR"];
const A = ["APEX"];
const C = ["BANK"];
const KES = 100n;
const cfg: Config = {
  registrar: "REGISTRAR",
  apex: "APEX",
  currency: "KES",
  decimals: 2,
  confirm_window_secs: 10 * DAY,
  attest_window_secs: 5 * DAY,
  max_period_gap_secs: 45 * DAY,
  performing_max_days: 90,
  alert_bps: 10_000,
};
const board = (no: number) => [`BOARD-${no}`];
const Z = "00".repeat(32);

function world(members = 3): RegisterModel {
  const m = new RegisterModel();
  m.setTime(T_OPEN - DAY);
  m.init(R, cfg);
  for (let no = 1; no <= members; no++) m.registerMember(R, no, `BOARD-${no}`, Z);
  m.setCustodian(R, "BANK", true);
  return m;
}

const SEVEN: Spec[] = [
  [1, "D", 1_000_000n * KES],
  [2, "D", 500_000n * KES],
  [1, "L", 400_000n * KES, 0],
  [2, "L", 300_000n * KES, 120],
  [3, "L", 200_000n * KES, 10],
  [2, "L", 100_000n * KES, 0],
  [3, "D", 250_000n * KES],
];

function posted(specs: Spec[] = SEVEN, cash = 0n, members = 3) {
  const m = world(members);
  const t = smallTree(1, specs);
  m.setTime(T_OPEN);
  const p = m.openPeriod(A, AS_OF, 0);
  m.attestCash(C, p, "BANK", cash, AS_OF, Z);
  m.postRoot(A, p, t.root, specs.length, Z);
  return { m, t, p };
}

function expectErr(f: () => unknown, name: ErrorName): void {
  assert.throws(f, (e: unknown) => e instanceof ContractError && e.errorName === name && e.code === ERRORS[name], `expected ${name}`);
}

// Table-driven: every contract error the negative Rust tests cover, reproduced by the model.
const CASES: [string, ErrorName, () => void][] = [
  ["init twice", "AlreadyInitialised", () => world().init(R, cfg)],
  ["init registrar == apex", "RoleConflict", () => new RegisterModel().init(R, { ...cfg, apex: "REGISTRAR" })],
  ["init zero window", "BadConfig", () => new RegisterModel().init(R, { ...cfg, confirm_window_secs: 0 })],
  ["init attest > confirm", "BadConfig", () => new RegisterModel().init(R, { ...cfg, attest_window_secs: 11 * DAY })],
  ["view before init", "NotInitialised", () => new RegisterModel().config()],
  ["member 0", "BadMemberNo", () => world().registerMember(R, 0, "X", Z)],
  ["member 1025", "BadMemberNo", () => world().registerMember(R, 1025, "X", Z)],
  ["member exists", "MemberExists", () => world().registerMember(R, 1, "X", Z)],
  ["board already bound", "RoleConflict", () => world().registerMember(R, 9, "BOARD-1", Z)],
  ["apex as board", "RoleConflict", () => world().registerMember(R, 9, "APEX", Z)],
  ["unknown member", "UnknownMember", () => world().setMemberActive(R, 9, false)],
  ["fifth custodian", "TooManyCustodians", () => { const m = world(); for (const c of ["B2", "B3", "B4", "B5"]) m.setCustodian(R, c, true); }],
  ["custodian = apex", "RoleConflict", () => world().setCustodian(R, "APEX", true)],
  ["no custodian", "NoCustodian", () => { const m = world(); m.setCustodian(R, "BANK", false); m.setTime(T_OPEN); m.openPeriod(A, AS_OF, 0); }],
  ["future as_of", "FutureAsOf", () => { const m = world(); m.setTime(T_OPEN); m.openPeriod(A, T_OPEN + 1, 0); }],
  ["bad supersedes", "BadSupersedes", () => { const m = world(); m.setTime(T_OPEN); m.openPeriod(A, AS_OF, 1); }],
  ["previous not closed", "PreviousNotClosed", () => posted().m.openPeriod(A, AS_OF + DAY, 0)],
  ["as_of not increasing", "AsOfNotIncreasing", () => { const { m, t, p } = posted([[1, "D", 5n]], 5n); m.confirm(board(1), p, 1, t.leaves[0]!, t.proof(0)); m.closePeriod(p); m.openPeriod(A, AS_OF, 0); }],
  ["post twice", "BadState", () => { const { m, t, p } = posted(); m.postRoot(A, p, t.root, 7, Z); }],
  ["leaf_count 0", "BadLeafCount", () => { const m = world(); m.setTime(T_OPEN); const p = m.openPeriod(A, AS_OF, 0); m.postRoot(A, p, smallTree(1, SEVEN).root, 0, Z); }],
  ["leaf_count 4097", "BadLeafCount", () => { const m = world(); m.setTime(T_OPEN); const p = m.openPeriod(A, AS_OF, 0); m.postRoot(A, p, smallTree(1, SEVEN).root, 4097, Z); }],
  ["negative root", "NegativeSum", () => { const m = world(); m.setTime(T_OPEN); const p = m.openPeriod(A, AS_OF, 0); m.postRoot(A, p, { ...smallTree(1, SEVEN).root, dep: -1n }, 7, Z); }],
  ["inactive member", "MemberInactive", () => { const { m, t, p } = posted(); m.setMemberActive(R, 1, false); m.confirm(board(1), p, 1, t.leaves[0]!, t.proof(0)); }],
  ["wrong period", "WrongPeriod", () => { const { m, t, p } = posted(); m.confirm(board(1), p, 1, { ...t.leaves[0]!, period: 2 }, t.proof(0)); }],
  ["bad index", "BadIndex", () => { const { m, t, p } = posted(); m.confirm(board(1), p, 1, { ...t.leaves[0]!, index: 7 }, t.proof(0)); }],
  ["not your leaf", "NotYourLeaf", () => { const { m, t, p } = posted(); m.confirm(board(2), p, 2, t.leaves[0]!, t.proof(0)); }],
  ["bad leaf kind", "BadLeaf", () => { const { m, t, p } = posted(); m.confirm(board(1), p, 1, { ...t.leaves[0]!, kind: 3 }, t.proof(0)); }],
  ["tampered balance", "BadProof", () => { const { m, t, p } = posted(); m.confirm(board(1), p, 1, { ...t.leaves[0]!, balance: 1n }, t.proof(0)); }],
  ["short proof", "BadProof", () => { const { m, t, p } = posted(); m.confirm(board(1), p, 1, t.leaves[0]!, t.proof(0).slice(1)); }],
  ["negative sibling", "NegativeSum", () => { const { m, t, p } = posted(); const pr = t.proof(0); pr[0] = { ...pr[0]!, dep: -1n }; m.confirm(board(1), p, 1, t.leaves[0]!, pr); }],
  ["confirm twice", "AlreadyResponded", () => { const { m, t, p } = posted(); m.confirm(board(1), p, 1, t.leaves[0]!, t.proof(0)); m.confirm(board(1), p, 1, t.leaves[0]!, t.proof(0)); }],
  ["confirm then dispute", "AlreadyResponded", () => { const { m, t, p } = posted(); m.confirm(board(1), p, 1, t.leaves[0]!, t.proof(0)); m.dispute(board(1), p, 1, t.leaves[0]!, t.proof(0), 1n, 0, 1, Z); }],
  ["reason 0", "BadReason", () => { const { m, t, p } = posted(); m.dispute(board(3), p, 3, t.leaves[4]!, t.proof(4), 1n, 10, 0, Z); }],
  ["reason 5", "BadReason", () => { const { m, t, p } = posted(); m.dispute(board(3), p, 3, t.leaves[4]!, t.proof(4), 1n, 10, 5, Z); }],
  ["NOT_OURS non-zero", "BadClaim", () => { const { m, t, p } = posted(); m.dispute(board(3), p, 3, t.leaves[4]!, t.proof(4), 1n, 10, 2, Z); }],
  ["not a dispute", "NotADispute", () => { const { m, t, p } = posted(); m.dispute(board(3), p, 3, t.leaves[4]!, t.proof(4), t.leaves[4]!.balance, 10, 4, Z); }],
  ["batch of 17", "BatchTooLarge", () => { const { m, t, p } = posted(); m.confirmBatch(board(1), p, 1, Array.from({ length: 17 }, () => ({ leaf: t.leaves[0]!, proof: t.proof(0) }))); }],
  ["omitted twice", "AlreadyClaimed", () => { const { m, p } = posted(); m.claimOmitted(board(2), p, 2, 5n, Z); m.claimOmitted(board(2), p, 2, 5n, Z); }],
  ["omitted negative", "BadClaim", () => { const { m, p } = posted(); m.claimOmitted(board(2), p, 2, -5n, Z); }],
  ["custodian not in snapshot", "NotCustodian", () => { const m = world(); m.setTime(T_OPEN); const p = m.openPeriod(A, AS_OF, 0); m.setCustodian(R, "LATE-BANK", true); m.attestCash(["LATE-BANK"], p, "LATE-BANK", 1n, AS_OF, Z); }],
  ["as_of mismatch", "AsOfMismatch", () => { const m = world(); m.setTime(T_OPEN); const p = m.openPeriod(A, AS_OF, 0); m.attestCash(C, p, "BANK", 1n, AS_OF + 1, Z); }],
  ["attest twice", "AlreadyAttested", () => { const { m, p } = posted(); m.attestCash(C, p, "BANK", 1n, AS_OF, Z); }],
  ["close too early", "TooEarly", () => { const { m, p } = posted(); m.closePeriod(p); }],
  ["custodian missing", "CustodianMissing", () => { const m = world(); const t = smallTree(1, SEVEN); m.setTime(T_OPEN); const p = m.openPeriod(A, AS_OF, 0); m.postRoot(A, p, t.root, 7, Z); m.setTime(T_OPEN + 10 * DAY); m.closePeriod(p); }],
  ["mark_overdue too early", "TooEarly", () => { const { m, p } = posted(); m.setTime(T_OPEN + 10 * DAY); m.markOverdue(p, 25); }],
  ["mark_overdue page 26", "BatchTooLarge", () => { const { m, p } = posted(); m.markOverdue(p, 26); }],
  ["response after close", "BadState", () => { const { m, t, p } = posted(); m.setTime(T_OPEN + 10 * DAY); m.closePeriod(p); m.confirm(board(1), p, 1, t.leaves[0]!, t.proof(0)); }],
  ["reports range 25", "RangeTooLarge", () => world().reports(1, 25)],
  ["unresponded 513", "RangeTooLarge", () => { const { m, p } = posted(); m.unresponded(p, 0, 513); }],
  ["overflow", "Overflow", () => {
    const m = world(1);
    m.setTime(T_OPEN);
    const p = m.openPeriod(A, AS_OF, 0);
    const max = (1n << 127n) - 1n;
    m.postRoot(A, p, { hash: Buffer.alloc(32, 1), dep: max, loan: 0n }, 2, Z);
    const leaf = { period: 1, index: 0, cp: 1, kind: 1, lineRef: Buffer.alloc(32), balance: max, arrearsDays: 0, salt: Buffer.alloc(32) };
    m.confirm(board(1), p, 1, leaf, [{ hash: Buffer.alloc(32), dep: 1n, loan: 0n }]);
  }],
];

for (const [name, err, f] of CASES) {
  test(`model reproduces ${err} (#${ERRORS[err]}): ${name}`, () => expectErr(f, err));
}

test("auth: the apex cannot register members or set custodians; another board cannot confirm", () => {
  const m = world();
  assert.throws(() => m.registerMember(A, 9, "X", Z), AuthError);
  assert.throws(() => m.setCustodian(A, "B2", true), AuthError);
  const { m: m2, t, p } = posted();
  assert.throws(() => m2.confirm(board(2), p, 1, t.leaves[0]!, t.proof(0)), AuthError);
  m2.rotateBoard(R, 1, "NEW-BOARD");
  assert.throws(() => m2.confirm(board(1), p, 1, t.leaves[0]!, t.proof(0)), AuthError);
  m2.confirm(["NEW-BOARD"], p, 1, t.leaves[0]!, t.proof(0));
});

test("a failed batch leaves the state unchanged", () => {
  const { m, t, p } = posted();
  const before = serializeState(m.state);
  assert.throws(() => m.confirmBatch(board(1), p, 1, [{ leaf: t.leaves[0]!, proof: t.proof(0) }, { leaf: { ...t.leaves[2]!, balance: 1n }, proof: t.proof(2) }]));
  assert.equal(serializeState(m.state), before);
});

test("the 7-line hand-computed report, same as the Rust test", () => {
  const { m, t, p } = posted(SEVEN, 600_000n * KES);
  m.setTime(T_OPEN + 2 * DAY);
  for (const [no, i] of [[1, 0], [1, 2], [2, 1], [2, 3]] as const) m.confirm(board(no), p, no, t.leaves[i]!, t.proof(i));
  m.dispute(board(3), p, 3, t.leaves[4]!, t.proof(4), 150_000n * KES, 10, 1, Z);
  m.dispute(board(3), p, 3, t.leaves[6]!, t.proof(6), 280_000n * KES, 0, 1, Z);
  m.setTime(T_OPEN + 10 * DAY);
  const r = m.closePeriod(p);
  assert.equal(r.coverage_bps, 6460n);
  assert.equal(r.booked_coverage_bps, 9142n);
  assert.equal(r.liabilities, 1_780_000n * KES);
  assert.equal(r.unconfirmed_loans, 100_000n * KES);
  assert.equal(r.flags, FLAGS.BELOW_ALERT | FLAGS.UNCONFIRMED_LOANS | FLAGS.DISPUTES | FLAGS.GAP_WIDE);
  assert.deepEqual(m.unresponded(p, 0, 10), [5]);
});

test("overdue, late responses and stale apex", () => {
  const { m, t, p } = posted([[1, "D", 10n], [2, "D", 10n]], 20n, 2);
  m.confirm(board(1), p, 1, t.leaves[0]!, t.proof(0));
  m.setTime(T_OPEN + 10 * DAY + 1);
  assert.equal(m.markOverdue(p, 25), 1);
  m.confirm(board(2), p, 2, t.leaves[1]!, t.proof(1));
  assert.equal(m.response(p, 1)!.late, true);
  assert.equal(m.markOverdue(p, 25), 0);
  assert.equal(m.member(2)!.overdue_streak, 1);
  const r = m.closePeriod(p);
  assert.ok(r.flags & FLAGS.LATE_RESPONSES);
  m.setTime(r.closed_at + 45 * DAY);
  assert.equal(m.flagStaleApex(), false);
  m.setTime(r.closed_at + 45 * DAY + 1);
  assert.equal(m.flagStaleApex(), true);
  m.openPeriod(A, AS_OF + 30 * DAY, 0);
  assert.equal(m.apexStaleSince(), 0);
});

test("state survives serialisation with bigints", () => {
  const { m } = posted();
  const back = deserializeState(serializeState(m.state));
  assert.deepEqual(back, m.state);
});

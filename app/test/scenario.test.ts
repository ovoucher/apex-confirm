import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.js";
import { FLAGS } from "../src/report/flags.js";
import { journey } from "./journey-cache.js";
import { expected } from "./helpers.js";

const FIELDS = ["period", "liabilities", "cash", "recognised_loans", "booked_loans", "unconfirmed_loans", "coverage_bps", "booked_coverage_bps", "unresponded", "disputed", "late", "omitted", "flags"] as const;

test("apex simulate equals expected.json in every report field (period 1: 7807 vs 10251 bps)", () => {
  const j = journey();
  const e = expected();
  const r1 = j.periods[0]!.report as unknown as Record<string, unknown>;
  for (const f of FIELDS) assert.equal(String(r1[f]), String(e.period_1.report[f]), `period 1 ${f}`);
  assert.equal(j.periods[0]!.report.coverage_bps, 7807n);
  assert.equal(j.periods[0]!.report.booked_coverage_bps, 10251n);
  assert.equal(j.periods[0]!.report.flags, FLAGS.BELOW_ALERT | FLAGS.UNCONFIRMED_LOANS | FLAGS.DISPUTES | FLAGS.LATE_RESPONSES | FLAGS.OMITTED_CLAIMS | FLAGS.GAP_WIDE);
  assert.deepEqual(j.periods[0]!.overdueFlagged, e.period_1.overdue_flagged);
  const r2 = j.periods[1]!.report as unknown as Record<string, unknown>;
  for (const f of FIELDS) assert.equal(String(r2[f]), String(e.period_2.report[f]), `period 2 ${f}`);
});

test("planted loans: non-members and the dormant member are never confirmed; overstatements cut to the acknowledged figure", () => {
  const j = journey();
  const p1 = j.periods[0]!;
  const e = expected();
  const idx = (ref: string) => p1.tree.refs.indexOf(ref);
  for (const tag of ["L-F1", "L-F2", "L-F3", "L-F4", "L-F5"]) {
    assert.equal(j.model.response(1, idx(e.planted[tag].ref)), null, `${tag} unconfirmed`);
  }
  const f6 = j.model.response(1, idx(e.planted["L-F6"].ref))!;
  assert.equal(f6.verdict, 2);
  assert.equal(f6.claimed, 2_500_000_000n);
  const f7 = j.model.response(1, idx(e.planted["L-F7"].ref))!;
  assert.equal(f7.claimed, 1_500_000_000n);
});

test("the colluding loan is confirmed and counted: the known limitation", () => {
  const j = journey();
  const p1 = j.periods[0]!;
  const e = expected().period_1.colluding_loan;
  const r = j.model.response(1, p1.tree.refs.indexOf(e.ref))!;
  assert.equal(r.verdict, 1);
  assert.equal(r.member_no, 37);
  assert.equal(r.booked.toString(), e.booked);
  assert.ok(r.arrears_days <= 90);
});

test("period 2: the stale-apex flag appears and member 22's overdue streak reaches 2", () => {
  const j = journey();
  const p2 = j.periods[1]!;
  assert.equal(p2.staleFlag, true);
  assert.deepEqual(p2.staleChecks.map((c) => [c.expect, c.got]), [[false, false], [true, true]]);
  assert.equal(p2.streak22, 2);
  assert.equal(expected().period_2.member_22_overdue_streak, 2);
  // every active member ends the period responded, omitted-claimed or flagged overdue
  for (const m of j.members.filter((x) => x.active)) {
    const responded = j.model.memberResponses(2, m.no) > 0 || j.model.omittedOf(2, m.no) !== null;
    const flagged = p2.overdueFlagged.includes(m.no);
    assert.ok(responded !== flagged, `member ${m.no}`);
  }
});

test("the CLI simulate command exits 0", async () => {
  const lines: string[] = [];
  assert.equal(await main(["simulate"], (s) => lines.push(s)), 0);
  const out = lines.join("\n");
  assert.match(out, /coverage 7807 bps \(78\.07%\) vs booked 10251 bps \(102\.51%\)/);
  assert.match(out, /CONFIRMED and counted as recognised/);
});

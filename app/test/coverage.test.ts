import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReport } from "../src/report/coverage.js";
import { flagNames } from "../src/report/flags.js";
import type { Tally } from "../src/register/types.js";
import { vector } from "./helpers.js";

function tallyOf(j: any): Tally {
  return {
    responded: j.responded,
    late: j.late,
    confirmed_dep: BigInt(j.confirmed_dep),
    confirmed_loans: BigInt(j.confirmed_loans),
    recognised_loans: BigInt(j.recognised_loans),
    disputed_loans_booked: BigInt(j.disputed_loans_booked),
    disputed_loans_ack: BigInt(j.disputed_loans_ack),
    disputed_count: j.disputed_count,
    deposit_uplift: BigInt(j.deposit_uplift),
    omitted_count: j.omitted_count,
    cash: BigInt(j.cash),
    cash_count: j.cash_count,
    cash_late: j.cash_late,
  };
}

test("coverage.ts reproduces every report exported by the Rust property test", () => {
  const v = vector("coverage.json");
  assert.ok(v.cases.length >= 60);
  for (const c of v.cases) {
    const r = computeReport(c.report.period, c.alert_bps, { dep: BigInt(c.root.dep), loan: BigInt(c.root.loan) }, c.leaf_count, tallyOf(c.tally), c.report.closed_at);
    const want = c.report;
    assert.equal(r.liabilities.toString(), want.liabilities, `case ${c.case}`);
    assert.equal(r.unconfirmed_loans.toString(), want.unconfirmed_loans, `case ${c.case}`);
    assert.equal(r.coverage_bps.toString(), want.coverage_bps, `case ${c.case}`);
    assert.equal(r.booked_coverage_bps.toString(), want.booked_coverage_bps, `case ${c.case}`);
    assert.equal(r.recognised_loans.toString(), want.recognised_loans);
    assert.equal(r.booked_loans.toString(), want.booked_loans);
    assert.equal(r.cash.toString(), want.cash);
    assert.equal(r.unresponded, want.unresponded);
    assert.equal(r.disputed, want.disputed);
    assert.equal(r.late, want.late);
    assert.equal(r.omitted, want.omitted);
    assert.equal(r.flags, want.flags, `case ${c.case}`);
  }
});

test("edge cases: zero divisor gives -1 and NO_LIABILITIES; late responses and custodian flags", () => {
  const v = vector("coverage.json");
  const e0 = v.cases.find((c: any) => c.case === "edge-0");
  assert.equal(e0.report.coverage_bps, "-1");
  assert.ok(flagNames(e0.report.flags).includes("NO_LIABILITIES"));
  const e2 = v.cases.find((c: any) => c.case === "edge-2");
  assert.deepEqual(flagNames(e2.report.flags).sort(), ["BELOW_ALERT", "CUSTODIAN_LATE", "GAP_WIDE", "LATE_RESPONSES", "UNCONFIRMED_LOANS"].sort());
});

test("the seed's headline numbers: 7807 vs 10251 bps", () => {
  const t: Tally = {
    responded: 149, late: 8, confirmed_dep: 0n, confirmed_loans: 0n, recognised_loans: 165_460_000_000n,
    disputed_loans_booked: 0n, disputed_loans_ack: 0n, disputed_count: 3, deposit_uplift: 3_050_000_000n,
    omitted_count: 1, cash: 30_541_231_855n, cash_count: 1, cash_late: false,
  };
  const r = computeReport(1, 10_000, { dep: 248_000_000_000n, loan: 223_690_000_000n }, 159, t, 0);
  assert.equal(r.coverage_bps, 7807n);
  assert.equal(r.booked_coverage_bps, 10251n);
});

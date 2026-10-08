/**
 * The coverage formulas, reproduced exactly from `compute_report` in the contract.
 * Integer arithmetic only; division rounds toward zero (all operands are non-negative
 * in a valid period, so this is rounding down). Checked against vectors exported by the
 * Rust property test (contracts/vectors/coverage.json).
 */
import { FLAGS } from "./flags.js";
import { I128_MAX, I128_MIN, OverflowError } from "../util/hash.js";
import type { Report, Tally } from "../register/types.js";

export const GAP_WIDE_BPS = 1000n;
const BPS = 10_000n;

function chk(v: bigint): bigint {
  if (v < I128_MIN || v > I128_MAX) throw new OverflowError();
  return v;
}

export interface RootSums {
  dep: bigint;
  loan: bigint;
}

export function computeReport(period: number, alertBps: number, root: RootSums, leafCount: number, t: Tally, closedAt: number): Report {
  const liabilities = chk(root.dep + t.deposit_uplift);
  const unconfirmed = chk(chk(root.loan - t.confirmed_loans) - t.disputed_loans_booked);
  let flags = 0;
  const coverage = liabilities > 0n ? chk(chk(t.cash + t.recognised_loans) * BPS) / liabilities : -1n;
  const booked = root.dep > 0n ? chk(chk(t.cash + root.loan) * BPS) / root.dep : -1n;
  if (liabilities <= 0n || root.dep <= 0n) flags |= FLAGS.NO_LIABILITIES;
  if (liabilities > 0n && coverage < BigInt(alertBps)) flags |= FLAGS.BELOW_ALERT;
  if (unconfirmed > 0n) flags |= FLAGS.UNCONFIRMED_LOANS;
  if (t.disputed_count > 0) flags |= FLAGS.DISPUTES;
  if (t.late > 0) flags |= FLAGS.LATE_RESPONSES;
  if (t.cash_late) flags |= FLAGS.CUSTODIAN_LATE;
  if (t.omitted_count > 0) flags |= FLAGS.OMITTED_CLAIMS;
  if (coverage >= 0n && booked >= 0n && booked - coverage >= GAP_WIDE_BPS) flags |= FLAGS.GAP_WIDE;
  return {
    period,
    liabilities,
    cash: t.cash,
    recognised_loans: t.recognised_loans,
    booked_loans: root.loan,
    unconfirmed_loans: unconfirmed,
    coverage_bps: coverage,
    booked_coverage_bps: booked,
    unresponded: leafCount - t.responded,
    disputed: t.disputed_count,
    late: t.late,
    omitted: t.omitted_count,
    flags,
    closed_at: closedAt,
  };
}

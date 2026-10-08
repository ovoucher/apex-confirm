/** Per-period series for the public and regulator pages. */
import type { Report } from "../register/types.js";

export interface HistoryPoint {
  period: number;
  coverage_bps: bigint;
  booked_coverage_bps: bigint;
  gap_bps: bigint;
  unconfirmed_loans: bigint;
  flags: number;
}

export function history(reports: Report[]): HistoryPoint[] {
  return reports
    .slice()
    .sort((a, b) => a.period - b.period)
    .map((r) => ({
      period: r.period,
      coverage_bps: r.coverage_bps,
      booked_coverage_bps: r.booked_coverage_bps,
      gap_bps: r.coverage_bps >= 0n && r.booked_coverage_bps >= 0n ? r.booked_coverage_bps - r.coverage_bps : -1n,
      unconfirmed_loans: r.unconfirmed_loans,
      flags: r.flags,
    }));
}

/** Overdue streaks per member, from the model's member records. */
export function streaks(members: { no: number; overdue_streak: number; active: boolean }[]): { no: number; streak: number }[] {
  return members.filter((m) => m.overdue_streak > 0).map((m) => ({ no: m.no, streak: m.overdue_streak }));
}

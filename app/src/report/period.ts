/**
 * Audience views of the register state. Three audiences, three views:
 *   public    ratios, flags, counts, custodian attestation time, apex staleness; no member data
 *   member    that member's lines (from its own pack), its responses and overdue streak, the public ratios
 *   regulator everything, including the off-chain mapping of unresponded indexes to lines,
 *             disputes with evidence hashes, the concentration heuristic and verify-tree result
 */
import type { RegisterModel } from "../register/model.js";
import type { Report, Response } from "../register/types.js";
import type { MemberPack, TreeFile } from "../tree/build.js";
import type { ConcentrationFlag } from "./concentration.js";
import type { VerifyTreeResult } from "../tree/verifyTree.js";
import { flagNames } from "./flags.js";
import { formatBps, formatKes } from "../util/amounts.js";
import { isoTime } from "../util/time.js";
import { REASON_NAMES } from "../register/errors.js";

export interface PublicPeriod {
  period: number;
  as_of: string;
  state: string;
  supersedes: number;
  coverage_bps: string | null;
  booked_coverage_bps: string | null;
  gap_bps: string | null;
  flags: string[];
  lines: number;
  unresponded: number | null;
  disputed: number | null;
  late: number | null;
  omitted: number | null;
  custodian_attested_at: string[];
  closed_at: string | null;
}

export interface PublicView {
  generated_at: string;
  apex_stale_since: string | null;
  periods: PublicPeriod[];
}

export function publicView(model: RegisterModel): PublicView {
  const periods: PublicPeriod[] = [];
  for (let id = 1; id <= model.state.currentPeriod; id++) {
    const p = model.period(id)!;
    const r = model.report(id);
    periods.push({
      period: id,
      as_of: isoTime(p.as_of).slice(0, 10),
      state: p.state,
      supersedes: p.supersedes,
      coverage_bps: r ? r.coverage_bps.toString() : null,
      booked_coverage_bps: r ? r.booked_coverage_bps.toString() : null,
      gap_bps: r && r.coverage_bps >= 0n && r.booked_coverage_bps >= 0n ? (r.booked_coverage_bps - r.coverage_bps).toString() : null,
      flags: r ? flagNames(r.flags) : [],
      lines: p.leaf_count,
      unresponded: r ? r.unresponded : null,
      disputed: r ? r.disputed : null,
      late: r ? r.late : null,
      omitted: r ? r.omitted : null,
      custodian_attested_at: model.cashOf(id).map((c) => isoTime(c.at)),
      closed_at: r ? isoTime(r.closed_at) : null,
    });
  }
  return {
    generated_at: isoTime(model.now),
    apex_stale_since: model.apexStaleSince() ? isoTime(model.apexStaleSince()) : null,
    periods,
  };
}

export interface MemberLineView {
  index: number;
  ref: string;
  kind: "DEP" | "LOAN";
  booked: string;
  arrears_days: number;
  proof_ok: boolean;
  response: null | { verdict: "CONFIRMED" | "DISPUTED"; claimed: string; reason: string; at: string; late: boolean };
}

export interface MemberView {
  member: number;
  name: string;
  overdue_streak: number;
  last_response_period: number;
  periods: { period: number; lines: MemberLineView[]; omitted: string | null; report: Report | null }[];
}

export function memberView(
  model: RegisterModel,
  no: number,
  name: string,
  packs: { pack: MemberPack; proofOk: Map<number, boolean> }[],
): MemberView {
  const m = model.member(no);
  return {
    member: no,
    name,
    overdue_streak: m?.overdue_streak ?? 0,
    last_response_period: m?.last_response_period ?? 0,
    periods: packs.map(({ pack, proofOk }) => ({
      period: pack.period,
      lines: pack.lines.map((l) => {
        const r = model.response(pack.period, l.leaf.index);
        return {
          index: l.leaf.index,
          ref: l.ref,
          kind: l.leaf.kind === 1 ? ("DEP" as const) : ("LOAN" as const),
          booked: formatKes(BigInt(l.leaf.balance)),
          arrears_days: l.leaf.arrears_days,
          proof_ok: proofOk.get(l.leaf.index) ?? false,
          response: r
            ? { verdict: r.verdict === 1 ? ("CONFIRMED" as const) : ("DISPUTED" as const), claimed: formatKes(r.claimed), reason: REASON_NAMES[r.reason] ?? "?", at: isoTime(r.at), late: r.late }
            : null,
        };
      }),
      omitted: model.omittedOf(pack.period, no) ? formatKes(model.omittedOf(pack.period, no)!.claimed_deposit) : null,
      report: model.report(pack.period),
    })),
  };
}

export interface RegulatorPeriod {
  period: number;
  report: Report | null;
  unresponded: { index: number; ref: string; cp: number; cp_name: string; kind: string; booked: string; registered: boolean; active: boolean }[];
  disputes: (Response & { ref: string })[];
  concentration: ConcentrationFlag[];
  verify: VerifyTreeResult | null;
  overdue: { no: number; streak: number }[];
}

export function regulatorPeriod(
  model: RegisterModel,
  period: number,
  tree: TreeFile,
  concentration: ConcentrationFlag[],
  verify: VerifyTreeResult | null,
): RegulatorPeriod {
  const unresp = model.period(period) ? model.unresponded(period, 0, 512) : [];
  // pages of 512 for large trees
  for (let from = 512; model.period(period) && from < model.period(period)!.leaf_count; from += 512) unresp.push(...model.unresponded(period, from, 512));
  const disputes: (Response & { ref: string })[] = [];
  const t = model.tally(period);
  for (let from = 0; t && from < t.disputed_count; from += 32) {
    for (const d of model.disputes(period, from, 32)) disputes.push({ ...d, ref: tree.leaves[d.index]?.ref ?? "?" });
  }
  return {
    period,
    report: model.report(period),
    unresponded: [...new Set(unresp)].map((i) => {
      const l = tree.leaves[i]!;
      const m = model.member(l.cp);
      return { index: i, ref: l.ref, cp: l.cp, cp_name: l.cp_name, kind: l.kind === 1 ? "DEP" : "LOAN", booked: formatKes(BigInt(l.balance)), registered: !!m, active: !!m?.active };
    }),
    disputes,
    concentration,
    verify,
    overdue: Object.values(model.state.members)
      .filter((m) => m.overdue_streak > 0)
      .map((m) => ({ no: m.no, streak: m.overdue_streak })),
  };
}

/** Plain-text summary used by `apex report` and `apex simulate`. */
export function reportText(r: Report): string[] {
  return [
    `period ${r.period}: coverage ${r.coverage_bps} bps (${formatBps(r.coverage_bps)}) vs booked ${r.booked_coverage_bps} bps (${formatBps(r.booked_coverage_bps)})`,
    `  liabilities ${formatKes(r.liabilities)}  cash ${formatKes(r.cash)}  recognised loans ${formatKes(r.recognised_loans)}`,
    `  booked loans ${formatKes(r.booked_loans)}  unconfirmed loans ${formatKes(r.unconfirmed_loans)}`,
    `  unresponded ${r.unresponded}  disputed ${r.disputed}  late ${r.late}  omitted ${r.omitted}`,
    `  flags ${r.flags} = ${flagNames(r.flags).join(" | ") || "none"}`,
  ];
}

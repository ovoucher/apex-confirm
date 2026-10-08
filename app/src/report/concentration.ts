/**
 * Off-chain, regulator-only heuristic for insider-style loans. Confirmation cannot catch a
 * loan booked to a colluding member (its board confirms it), so this labels members whose
 * confirmed positions look like the pattern. The output is a pattern for supervisory
 * follow-up, NOT evidence. Thresholds are assumptions read from concentration.json:
 *   (i)   confirmed loans > multiple x confirmed deposits with the apex
 *   (ii)  any single confirmed loan > single_loan_share_bps of total booked loans
 *   (iii) a loan opened within recent_days before as_of above recent_loan_share_bps of booked loans
 */
import { KIND_DEPOSIT, KIND_LOAN } from "../tree/leaf.js";
import type { Response } from "../register/types.js";

export interface ConcentrationConfig {
  loan_to_deposit_multiple: number;
  single_loan_share_bps: number;
  recent_days: number;
  recent_loan_share_bps: number;
}

export interface LineInfo {
  index: number;
  cp: number;
  kind: number;
  booked: bigint;
  opened: string;
  ref: string;
}

export interface ConcentrationFlag {
  member: number;
  rules: ("i" | "ii" | "iii")[];
  confirmedLoans: bigint;
  confirmedDeposits: bigint;
  details: string[];
  label: "pattern for supervisory follow-up, not evidence";
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.floor((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export function concentrationFlags(
  lines: LineInfo[],
  responses: Response[],
  omitted: { member_no: number; claimed_deposit: bigint }[],
  totalBookedLoans: bigint,
  asOfIso: string,
  cfg: ConcentrationConfig,
): ConcentrationFlag[] {
  const byIndex = new Map(lines.map((l) => [l.index, l]));
  const acc = new Map<number, { loans: bigint; deps: bigint; items: { line: LineInfo; ack: bigint }[] }>();
  const get = (m: number) => {
    let a = acc.get(m);
    if (!a) acc.set(m, (a = { loans: 0n, deps: 0n, items: [] }));
    return a;
  };
  for (const r of responses) {
    const line = byIndex.get(r.index);
    if (!line) continue;
    const a = get(r.member_no);
    if (r.kind === KIND_LOAN) {
      const ack = r.verdict === 1 ? r.booked : r.claimed < r.booked ? r.claimed : r.booked;
      a.loans += ack;
      if (ack > 0n) a.items.push({ line, ack });
    } else if (r.kind === KIND_DEPOSIT) {
      a.deps += r.verdict === 1 ? r.booked : r.claimed;
    }
  }
  for (const o of omitted) get(o.member_no).deps += o.claimed_deposit;
  const out: ConcentrationFlag[] = [];
  for (const [member, a] of [...acc.entries()].sort((x, y) => x[0] - y[0])) {
    const rules: ConcentrationFlag["rules"] = [];
    const details: string[] = [];
    if (a.loans > 0n && a.loans > BigInt(cfg.loan_to_deposit_multiple) * a.deps) {
      rules.push("i");
      details.push(`confirmed loans ${a.loans} > ${cfg.loan_to_deposit_multiple} x confirmed deposits ${a.deps} (cents)`);
    }
    for (const it of a.items) {
      if (it.ack * 10_000n > BigInt(cfg.single_loan_share_bps) * totalBookedLoans) {
        if (!rules.includes("ii")) rules.push("ii");
        details.push(`loan ${it.line.ref} is over ${cfg.single_loan_share_bps} bps of booked loans`);
      }
      const age = daysBetween(it.line.opened, asOfIso);
      if (age >= 0 && age <= cfg.recent_days && it.ack * 10_000n > BigInt(cfg.recent_loan_share_bps) * totalBookedLoans) {
        if (!rules.includes("iii")) rules.push("iii");
        details.push(`loan ${it.line.ref} opened ${age} days before the balance date and over ${cfg.recent_loan_share_bps} bps of booked loans`);
      }
    }
    if (rules.length) out.push({ member, rules, confirmedLoans: a.loans, confirmedDeposits: a.deps, details, label: "pattern for supervisory follow-up, not evidence" });
  }
  return out;
}

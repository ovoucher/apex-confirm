/** TypeScript mirrors of the contract's `#[contracttype]` structs (hashes as hex strings). */

export interface Config {
  registrar: string;
  apex: string;
  currency: string;
  decimals: number;
  confirm_window_secs: number;
  attest_window_secs: number;
  max_period_gap_secs: number;
  performing_max_days: number;
  alert_bps: number;
}

export interface Member {
  no: number;
  board: string;
  licence_hash: string;
  active: boolean;
  admitted_at: number;
  overdue_streak: number;
  last_response_period: number;
}

export interface NodeHex {
  hash: string;
  dep: bigint;
  loan: bigint;
}

export type PeriodState = "Open" | "Posted" | "Closed";

export interface Period {
  id: number;
  as_of: number;
  opened_at: number;
  supersedes: number;
  root: NodeHex;
  leaf_count: number;
  depth: number;
  file_hash: string;
  posted_at: number;
  confirm_by: number;
  attest_by: number;
  custodians: string[];
  state: PeriodState;
}

export interface Tally {
  responded: number;
  late: number;
  confirmed_dep: bigint;
  confirmed_loans: bigint;
  recognised_loans: bigint;
  disputed_loans_booked: bigint;
  disputed_loans_ack: bigint;
  disputed_count: number;
  deposit_uplift: bigint;
  omitted_count: number;
  cash: bigint;
  cash_count: number;
  cash_late: boolean;
}

export interface Report {
  period: number;
  liabilities: bigint;
  cash: bigint;
  recognised_loans: bigint;
  booked_loans: bigint;
  unconfirmed_loans: bigint;
  coverage_bps: bigint;
  booked_coverage_bps: bigint;
  unresponded: number;
  disputed: number;
  late: number;
  omitted: number;
  flags: number;
  closed_at: number;
}

export interface Response {
  index: number;
  member_no: number;
  kind: number;
  verdict: number;
  booked: bigint;
  claimed: bigint;
  arrears_days: number;
  claimed_arrears_days: number;
  reason: number;
  evidence_hash: string;
  at: number;
  late: boolean;
}

export interface CashAttestation {
  custodian: string;
  balance: bigint;
  as_of: number;
  statement_hash: string;
  at: number;
  late: boolean;
}

export interface OmittedClaim {
  member_no: number;
  claimed_deposit: bigint;
  evidence_hash: string;
  at: number;
}

export function emptyTally(): Tally {
  return {
    responded: 0,
    late: 0,
    confirmed_dep: 0n,
    confirmed_loans: 0n,
    recognised_loans: 0n,
    disputed_loans_booked: 0n,
    disputed_loans_ack: 0n,
    disputed_count: 0,
    deposit_uplift: 0n,
    omitted_count: 0,
    cash: 0n,
    cash_count: 0,
    cash_late: false,
  };
}

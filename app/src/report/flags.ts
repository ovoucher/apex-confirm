/** Report flag bits, identical to the contract's FLAG_* constants. */
export const FLAGS = {
  BELOW_ALERT: 1,
  UNCONFIRMED_LOANS: 2,
  DISPUTES: 4,
  LATE_RESPONSES: 8,
  CUSTODIAN_LATE: 16,
  OMITTED_CLAIMS: 32,
  GAP_WIDE: 64,
  NO_LIABILITIES: 128,
} as const;

export type FlagName = keyof typeof FLAGS;

const TEXT: Record<FlagName, string> = {
  BELOW_ALERT: "confirmed coverage is below the alert level",
  UNCONFIRMED_LOANS: "some booked loans had no response from any counterparty",
  DISPUTES: "at least one line was disputed",
  LATE_RESPONSES: "at least one response came after the window",
  CUSTODIAN_LATE: "the custodian attested after its window",
  OMITTED_CLAIMS: "a member claimed a deposit the apex did not book",
  GAP_WIDE: "booked coverage exceeds confirmed coverage by 10 points or more",
  NO_LIABILITIES: "no deposit liabilities: ratios undefined",
};

export function flagNames(bits: number): FlagName[] {
  return (Object.keys(FLAGS) as FlagName[]).filter((k) => (bits & FLAGS[k]) !== 0);
}

export function flagText(bits: number): string[] {
  return flagNames(bits).map((k) => `${k}: ${TEXT[k]}`);
}

export function flagsFromNames(names: string[]): number {
  return names.reduce((a, n) => a | (FLAGS[n as FlagName] ?? 0), 0);
}

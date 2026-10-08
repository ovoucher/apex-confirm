/** Contract error codes, identical to `#[contracterror] enum Error` in apex_register. */
export const ERRORS = {
  AlreadyInitialised: 1,
  NotInitialised: 2,
  BadConfig: 3,
  RoleConflict: 4,
  BadMemberNo: 5,
  MemberExists: 6,
  UnknownMember: 7,
  MemberInactive: 8,
  TooManyCustodians: 9,
  NotCustodian: 10,
  NoCustodian: 11,
  PreviousNotClosed: 12,
  AsOfNotIncreasing: 13,
  FutureAsOf: 14,
  BadSupersedes: 15,
  BadState: 16,
  BadLeafCount: 17,
  NegativeSum: 18,
  WrongPeriod: 19,
  BadIndex: 20,
  NotYourLeaf: 21,
  BadLeaf: 22,
  BadProof: 23,
  AlreadyResponded: 24,
  BadReason: 25,
  BadClaim: 26,
  NotADispute: 27,
  BatchTooLarge: 28,
  AlreadyClaimed: 29,
  AsOfMismatch: 30,
  AlreadyAttested: 31,
  TooEarly: 32,
  CustodianMissing: 33,
  Overflow: 34,
  RangeTooLarge: 35,
} as const;

export type ErrorName = keyof typeof ERRORS;

export const ERROR_NAMES: Record<number, ErrorName> = Object.fromEntries(
  Object.entries(ERRORS).map(([k, v]) => [v, k as ErrorName]),
) as Record<number, ErrorName>;

export class ContractError extends Error {
  readonly code: number;
  constructor(public readonly errorName: ErrorName) {
    super(`contract error ${ERRORS[errorName]} ${errorName}`);
    this.code = ERRORS[errorName];
  }
}

/** A require_auth that was not satisfied (the host rejects the transaction). */
export class AuthError extends Error {
  constructor(public readonly address: string) {
    super(`authorisation missing for ${address}`);
  }
}

export const REASON = { NONE: 0, BALANCE_WRONG: 1, NOT_OURS: 2, ARREARS_WRONG: 3, OTHER: 4 } as const;
export const REASON_NAMES: Record<number, string> = { 0: "NONE", 1: "BALANCE_WRONG", 2: "NOT_OURS", 3: "ARREARS_WRONG", 4: "OTHER" };

/** Parse "Error(Contract, #23)" style host messages into the error name. */
export function errorFromHostMessage(msg: string): ErrorName | null {
  const m = /Error\(Contract, #(\d+)\)/.exec(msg);
  return m ? (ERROR_NAMES[Number(m[1])] ?? null) : null;
}

/**
 * KES amounts as integer cents (`bigint`). No floats anywhere: parsing works on the
 * decimal string, and ratios elsewhere are integer basis points.
 */

export class AmountError extends Error {}

/**
 * Parse "1,234,567.89", "1234567.9", "KES 1,234,567.89", "KES1234567" or a decimal-comma
 * value such as "48250,75" into cents. Rejects anything else.
 */
export function parseKes(raw: string): bigint {
  let s = raw.trim().replace(/ /g, " ");
  s = s.replace(/^KES\s*/i, "").replace(/^KSH\s*/i, "").trim();
  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1).trim();
  }
  if (s === "") throw new AmountError(`empty amount "${raw}"`);
  // A decimal comma: no dot, and the last comma is followed by exactly one or two digits.
  if (!s.includes(".") && /^\d[\d ]*,\d{1,2}$/.test(s)) {
    s = s.replace(/ /g, "").replace(",", ".");
  }
  s = s.replace(/[ ,](?=\d{3}(\D|$))/g, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new AmountError(`unparseable amount "${raw}"`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(2, "0"));
  const v = whole * 100n + frac;
  return neg ? -v : v;
}

/** 248000000000n -> "2,480,000,000.00" */
export function formatKes(cents: bigint): string {
  const neg = cents < 0n;
  const a = neg ? -cents : cents;
  const whole = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (a % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** Basis points as a percentage string with two decimals, integer arithmetic only. 7807n -> "78.07%" */
export function formatBps(bps: bigint | number): string {
  const b = BigInt(bps);
  if (b < 0n) return "n/a";
  return `${b / 100n}.${(b % 100n).toString().padStart(2, "0")}%`;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Deterministic xorshift64* generator (fixed seed) for the seed generator and tests. */
export class Rng {
  private s: bigint;
  constructor(seed: bigint) {
    this.s = seed === 0n ? 0x9e3779b97f4a7c15n : seed & 0xffffffffffffffffn;
  }
  next(): bigint {
    let x = this.s;
    x ^= x >> 12n;
    x ^= (x << 25n) & 0xffffffffffffffffn;
    x ^= x >> 27n;
    this.s = x;
    return (x * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
  }
  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Number(this.next() % BigInt(hi - lo + 1));
  }
  big(lo: bigint, hi: bigint): bigint {
    return lo + (this.next() % (hi - lo + 1n));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)]!;
  }
  chance(pct: number): boolean {
    return this.int(1, 100) <= pct;
  }
}

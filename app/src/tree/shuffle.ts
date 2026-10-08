/**
 * Deterministic Fisher-Yates shuffle driven by a SHA-256 counter stream, so the index
 * order of a period's tree does not reveal the order of the apex's book, and the apex
 * can reproduce it from its salt key.
 */
import { sha256, u32be } from "../util/hash.js";

export function shuffleSeed(saltKey: Buffer, period: number): Buffer {
  return sha256("APEX-SHUFFLE-v1", u32be(period), saltKey);
}

export function shuffle<T>(items: readonly T[], seed: Buffer): T[] {
  const out = items.slice();
  let counter = 0;
  let pool = Buffer.alloc(0);
  const nextU32 = (): number => {
    if (pool.length < 4) {
      pool = Buffer.concat([pool, sha256(seed, u32be(counter++))]);
    }
    const v = pool.readUInt32BE(0);
    pool = pool.subarray(4);
    return v;
  };
  for (let i = out.length - 1; i > 0; i--) {
    // rejection sampling for an unbiased index in [0, i]
    const bound = i + 1;
    const limit = Math.floor(0x100000000 / bound) * bound;
    let r = nextU32();
    while (r >= limit) r = nextU32();
    const j = r % bound;
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

import { createHash, createHmac } from "node:crypto";

export function sha256(...parts: (Buffer | Uint8Array | string)[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(typeof p === "string" ? Buffer.from(p, "utf8") : p);
  return h.digest();
}

export function hmacSha256(key: Buffer, ...parts: (Buffer | string)[]): Buffer {
  const h = createHmac("sha256", key);
  for (const p of parts) h.update(typeof p === "string" ? Buffer.from(p, "utf8") : p);
  return h.digest();
}

export const hex = (b: Buffer | Uint8Array): string => Buffer.from(b).toString("hex");

export function fromHex(s: string, len?: number): Buffer {
  if (!/^([0-9a-f]{2})*$/i.test(s)) throw new Error(`not hex: ${s.slice(0, 20)}`);
  const b = Buffer.from(s, "hex");
  if (len !== undefined && b.length !== len) throw new Error(`expected ${len} bytes, got ${b.length}`);
  return b;
}

/** Big-endian u32. */
export function u32be(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`not a u32: ${n}`);
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;

/** Big-endian two's-complement i128 (16 bytes), as Rust's `i128::to_be_bytes`. */
export function i128be(v: bigint): Buffer {
  if (v < I128_MIN || v > I128_MAX) throw new Error(`i128 overflow: ${v}`);
  let x = v < 0n ? (1n << 128n) + v : v;
  const b = Buffer.alloc(16);
  for (let i = 15; i >= 0; i--) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}

export function checkedAdd(a: bigint, b: bigint): bigint {
  const r = a + b;
  if (r < I128_MIN || r > I128_MAX) throw new OverflowError();
  return r;
}

export class OverflowError extends Error {
  constructor() {
    super("i128 overflow");
  }
}

export { I128_MAX, I128_MIN };

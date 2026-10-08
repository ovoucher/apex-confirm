/** JSON with bigint support: bigints are written as decimal strings. */
export function toJson(v: unknown, indent = 2): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : Buffer.isBuffer(x) ? x.toString("hex") : x), indent);
}

/** Canonical JSON: sorted keys, no whitespace, bigints as strings. Used for file hashes. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") {
    return typeof v === "bigint" ? JSON.stringify(v.toString()) : JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

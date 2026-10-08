import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seedDir, vectorsDir } from "../src/util/paths.js";
import { KIND_DEPOSIT, KIND_LOAN, type Leaf } from "../src/tree/leaf.js";
import { buildLevels } from "../src/tree/build.js";
import { sha256 } from "../src/util/hash.js";

export const seed = (rel: string): string => readFileSync(join(seedDir(), rel), "utf8");
export const seedPath = (rel: string): string => join(seedDir(), rel);
export const vector = <T = any>(name: string): T => JSON.parse(readFileSync(join(vectorsDir(), name), "utf8")) as T;
export const expected = (): any => JSON.parse(seed("expected.json"));

export type Spec = [cp: number, kind: "D" | "L", balance: bigint, arrears?: number];

/** Small tree with deterministic refs and salts, like the Rust test harness builds. */
export function smallTree(period: number, specs: Spec[]) {
  const leaves: Leaf[] = specs.map(([cp, k, balance, arrears], index) => ({
    period,
    index,
    cp,
    kind: k === "D" ? KIND_DEPOSIT : KIND_LOAN,
    lineRef: sha256(`REF-${period}-${index}`),
    balance,
    arrearsDays: arrears ?? 0,
    salt: sha256(`SALT-${period}-${index}`),
  }));
  const levels = buildLevels(period, leaves);
  const root = levels[levels.length - 1]![0]!;
  const proof = (i: number) => {
    const out = [];
    let x = i;
    for (let k = 0; k < levels.length - 1; k++) {
      out.push(levels[k]![x ^ 1]!);
      x >>= 1;
    }
    return out;
  };
  return { leaves, levels, root, depth: levels.length - 1, proof };
}

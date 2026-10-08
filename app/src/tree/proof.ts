/**
 * Inclusion proofs: the sibling path from a leaf to the root. The direction at level k
 * is bit k of the leaf index, exactly as `merkle::root_from_proof` in the contract.
 */
import { OverflowError } from "../util/hash.js";
import { type Leaf, leafNode } from "./leaf.js";
import { type SumNode, nodesEqual, parentNode } from "./node.js";

export type ProofResult = { ok: true } | { ok: false; reason: "BadProof" | "NegativeSum" | "Overflow" };

export function proofFor(levels: SumNode[][], index: number): SumNode[] {
  const out: SumNode[] = [];
  let i = index;
  for (let k = 0; k < levels.length - 1; k++) {
    out.push(levels[k]![i ^ 1]!);
    i >>= 1;
  }
  return out;
}

export function rootFromProof(start: SumNode, index: number, proof: SumNode[]): SumNode {
  let cur = start;
  let i = index;
  for (const sib of proof) {
    if (sib.dep < 0n || sib.loan < 0n) throw new NegativeSumError();
    cur = (i & 1) === 0 ? parentNode(cur, sib) : parentNode(sib, cur);
    i >>= 1;
  }
  return cur;
}

export class NegativeSumError extends Error {
  constructor() {
    super("negative sibling sum");
  }
}

/** Member-side check of one line against the on-chain root (and expected depth). */
export function verifyProof(leaf: Leaf, proof: SumNode[], root: SumNode, depth: number): ProofResult {
  if (proof.length !== depth) return { ok: false, reason: "BadProof" };
  try {
    const r = rootFromProof(leafNode(leaf), leaf.index, proof);
    return nodesEqual(r, root) ? { ok: true } : { ok: false, reason: "BadProof" };
  } catch (e) {
    if (e instanceof NegativeSumError) return { ok: false, reason: "NegativeSum" };
    if (e instanceof OverflowError) return { ok: false, reason: "Overflow" };
    throw e;
  }
}

/**
 * Merkle sum tree nodes. Byte layout identical to `contracts/apex_register/src/merkle.rs`
 * (see docs/LEAF-FORMAT.md): parent = sha256("APEX-NODE-v1" ‖ L.hash ‖ L.dep ‖ L.loan ‖ R.hash ‖ R.dep ‖ R.loan).
 */
import { checkedAdd, fromHex, hex, i128be, sha256 } from "../util/hash.js";

export const NODE_TAG = "APEX-NODE-v1";
export const MAX_LEAVES = 4096;

export interface SumNode {
  hash: Buffer;
  dep: bigint;
  loan: bigint;
}

export interface SumNodeJson {
  hash: string;
  dep: string;
  loan: string;
}

export function parentNode(l: SumNode, r: SumNode): SumNode {
  const dep = checkedAdd(l.dep, r.dep);
  const loan = checkedAdd(l.loan, r.loan);
  const hash = sha256(NODE_TAG, l.hash, i128be(l.dep), i128be(l.loan), r.hash, i128be(r.dep), i128be(r.loan));
  return { hash, dep, loan };
}

/** ceil(log2(max(leafCount, 2))) */
export function depthFor(leafCount: number): number {
  const n = Math.max(leafCount, 2);
  let d = 0;
  while (1 << d < n) d++;
  return d;
}

export function nodeToJson(n: SumNode): SumNodeJson {
  return { hash: hex(n.hash), dep: n.dep.toString(), loan: n.loan.toString() };
}

export function nodeFromJson(j: SumNodeJson): SumNode {
  return { hash: fromHex(j.hash, 32), dep: BigInt(j.dep), loan: BigInt(j.loan) };
}

export function nodesEqual(a: SumNode, b: SumNode): boolean {
  return a.hash.equals(b.hash) && a.dep === b.dep && a.loan === b.loan;
}

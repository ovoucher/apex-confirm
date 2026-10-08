/**
 * Regulator-side check of the full salted line file against the on-chain root.
 * Only this full-file check closes the Merkle-sum-tree gap where a negative or omitted
 * liability sits in a subtree that no member's proof touches.
 */
import { sha256 } from "../util/hash.js";
import { OverflowError } from "../util/hash.js";
import { type RootJson, type TreeFile, buildLevels, fileHashOf } from "./build.js";
import { KIND_DEPOSIT, KIND_LOAN, type Leaf, leafFromJson } from "./leaf.js";
import { nodeToJson } from "./node.js";

export interface TreeIssue {
  index: number | null;
  code:
    | "NEGATIVE_BALANCE"
    | "DUPLICATE_REF"
    | "BAD_KIND"
    | "BAD_CP"
    | "BAD_INDEX"
    | "WRONG_PERIOD"
    | "REF_HASH_MISMATCH"
    | "ROOT_MISMATCH"
    | "FILE_HASH_MISMATCH"
    | "LEAF_COUNT_MISMATCH"
    | "OVERFLOW";
  message: string;
}

export interface VerifyTreeResult {
  ok: boolean;
  issues: TreeIssue[];
  recomputed: { hash: string; dep: string; loan: string } | null;
}

export function verifyTreeFile(file: TreeFile, onChain: RootJson | null): VerifyTreeResult {
  const issues: TreeIssue[] = [];
  const leaves: Leaf[] = [];
  const refs = new Map<string, number>();
  file.leaves.forEach((j, i) => {
    const l = leafFromJson(j);
    leaves.push(l);
    if (l.index !== i) issues.push({ index: i, code: "BAD_INDEX", message: `leaf at position ${i} carries index ${l.index}` });
    if (l.period !== file.period) issues.push({ index: i, code: "WRONG_PERIOD", message: `leaf period ${l.period} != ${file.period}` });
    if (l.balance < 0n) issues.push({ index: i, code: "NEGATIVE_BALANCE", message: `negative balance ${l.balance} at index ${i}` });
    if (l.kind !== KIND_DEPOSIT && l.kind !== KIND_LOAN) issues.push({ index: i, code: "BAD_KIND", message: `kind ${l.kind}` });
    if (l.cp < 1) issues.push({ index: i, code: "BAD_CP", message: `counterparty ${l.cp}` });
    const key = l.lineRef.toString("hex");
    const prev = refs.get(key);
    if (prev !== undefined) issues.push({ index: i, code: "DUPLICATE_REF", message: `line_ref of index ${i} repeats index ${prev}` });
    else refs.set(key, i);
    if (j.ref !== undefined && !sha256(j.ref.trim()).equals(l.lineRef)) {
      issues.push({ index: i, code: "REF_HASH_MISMATCH", message: `sha256("${j.ref}") != line_ref at index ${i}` });
    }
  });
  if (leaves.length !== file.leaf_count) {
    issues.push({ index: null, code: "LEAF_COUNT_MISMATCH", message: `${leaves.length} leaves, header says ${file.leaf_count}` });
  }
  let recomputed: VerifyTreeResult["recomputed"] = null;
  try {
    const levels = buildLevels(file.period, leaves);
    const root = nodeToJson(levels[levels.length - 1]![0]!);
    recomputed = root;
    const fh = fileHashOf(leaves).toString("hex");
    const target = onChain ?? { hash: file.root.hash, dep: file.root.dep, loan: file.root.loan, file_hash: file.file_hash, leaf_count: file.leaf_count };
    if (root.hash !== target.hash || root.dep !== target.dep || root.loan !== target.loan) {
      issues.push({ index: null, code: "ROOT_MISMATCH", message: `recomputed root ${root.hash.slice(0, 16)}… (dep ${root.dep}, loan ${root.loan}) != posted ${target.hash.slice(0, 16)}… (dep ${target.dep}, loan ${target.loan})` });
    }
    if (fh !== target.file_hash) issues.push({ index: null, code: "FILE_HASH_MISMATCH", message: `file hash ${fh} != ${target.file_hash}` });
    if (onChain && onChain.leaf_count !== leaves.length) {
      issues.push({ index: null, code: "LEAF_COUNT_MISMATCH", message: `${leaves.length} leaves, on-chain leaf_count ${onChain.leaf_count}` });
    }
  } catch (e) {
    if (e instanceof OverflowError) issues.push({ index: null, code: "OVERFLOW", message: "sum overflow" });
    else throw e;
  }
  return { ok: issues.length === 0, issues, recomputed };
}

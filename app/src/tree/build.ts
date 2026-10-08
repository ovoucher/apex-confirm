/**
 * Build a period's Merkle sum tree from a validated apex book:
 *   1. shuffle lines with a per-period seed (index order does not reveal book order)
 *   2. salt each line: HMAC-SHA256(apex_salt_key, period ‖ line_ref); never published
 *   3. leaf nodes, padding to 2^depth, parents
 * and produce the three outputs: tree.json (full, for the apex and the regulator),
 * root.json (what is posted on-chain) and one pack per member (its lines and proofs).
 */
import type { BookLine } from "../book/parseBook.js";
import { hmacSha256, sha256, u32be } from "../util/hash.js";
import { canonicalJson } from "../util/json.js";
import { KIND_DEPOSIT, KIND_LOAN, type Leaf, type LeafJson, emptyNode, leafNode, leafToJson, lineRefHash } from "./leaf.js";
import { MAX_LEAVES, type SumNode, type SumNodeJson, depthFor, nodeToJson, parentNode } from "./node.js";
import { proofFor } from "./proof.js";
import { shuffle, shuffleSeed } from "./shuffle.js";

export interface BuiltTree {
  period: number;
  leafCount: number;
  depth: number;
  leaves: Leaf[];
  /** the apex's account/loan number for each index (private; delivered to the regulator) */
  refs: string[];
  /** counterparty names as booked (private) */
  names: string[];
  levels: SumNode[][];
  root: SumNode;
  fileHash: Buffer;
}

export interface RootJson {
  period: number;
  hash: string;
  dep: string;
  loan: string;
  leaf_count: number;
  depth: number;
  file_hash: string;
}

export interface TreeFileLine extends LeafJson {
  ref: string;
  cp_name: string;
}

export interface TreeFile {
  format: "apex-confirm/tree-v1";
  period: number;
  leaf_count: number;
  depth: number;
  root: SumNodeJson;
  file_hash: string;
  leaves: TreeFileLine[];
}

export interface PackLine {
  ref: string;
  leaf: LeafJson;
  proof: SumNodeJson[];
}

export interface MemberPack {
  format: "apex-confirm/pack-v1";
  period: number;
  member_no: number;
  leaf_count: number;
  depth: number;
  /** informational only: members must check against the on-chain root */
  root: SumNodeJson;
  lines: PackLine[];
}

export function lineSalt(saltKey: Buffer, period: number, lineRef: string): Buffer {
  return hmacSha256(saltKey, u32be(period), lineRef.trim());
}

/** file_hash = sha256 of the canonical JSON (sorted keys, no whitespace) of all leaves in index order. */
export function fileHashOf(leaves: Leaf[]): Buffer {
  return sha256(canonicalJson(leaves.map(leafToJson)));
}

/** Build levels from leaves already in index order. */
export function buildLevels(period: number, leaves: Leaf[]): SumNode[][] {
  if (leaves.length < 1 || leaves.length > MAX_LEAVES) throw new Error(`leaf count ${leaves.length} outside 1..${MAX_LEAVES}`);
  const depth = depthFor(leaves.length);
  const width = 1 << depth;
  const level0: SumNode[] = [];
  for (let i = 0; i < width; i++) level0.push(i < leaves.length ? leafNode(leaves[i]!) : emptyNode(period, i));
  const levels = [level0];
  while (levels[levels.length - 1]!.length > 1) {
    const prev = levels[levels.length - 1]!;
    const next: SumNode[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(parentNode(prev[i]!, prev[i + 1]!));
    levels.push(next);
  }
  return levels;
}

export function buildTree(period: number, lines: BookLine[], saltKey: Buffer): BuiltTree {
  const order = shuffle(lines, shuffleSeed(saltKey, period));
  const leaves: Leaf[] = order.map((l, index) => ({
    period,
    index,
    cp: l.cpNo,
    kind: l.kind === "DEP" ? KIND_DEPOSIT : KIND_LOAN,
    lineRef: lineRefHash(l.lineRef),
    balance: l.balance,
    arrearsDays: l.arrearsDays,
    salt: lineSalt(saltKey, period, l.lineRef),
  }));
  const levels = buildLevels(period, leaves);
  return {
    period,
    leafCount: leaves.length,
    depth: levels.length - 1,
    leaves,
    refs: order.map((l) => l.lineRef.trim()),
    names: order.map((l) => l.cpName),
    levels,
    root: levels[levels.length - 1]![0]!,
    fileHash: fileHashOf(leaves),
  };
}

export function rootJson(t: BuiltTree): RootJson {
  return {
    period: t.period,
    ...nodeToJson(t.root),
    leaf_count: t.leafCount,
    depth: t.depth,
    file_hash: t.fileHash.toString("hex"),
  };
}

export function treeFile(t: BuiltTree): TreeFile {
  return {
    format: "apex-confirm/tree-v1",
    period: t.period,
    leaf_count: t.leafCount,
    depth: t.depth,
    root: nodeToJson(t.root),
    file_hash: t.fileHash.toString("hex"),
    leaves: t.leaves.map((l, i) => ({ ...leafToJson(l), ref: t.refs[i]!, cp_name: t.names[i]! })),
  };
}

export function memberPack(t: BuiltTree, memberNo: number): MemberPack {
  const lines: PackLine[] = [];
  t.leaves.forEach((l, i) => {
    if (l.cp === memberNo) {
      lines.push({ ref: t.refs[i]!, leaf: leafToJson(l), proof: proofFor(t.levels, i).map(nodeToJson) });
    }
  });
  return {
    format: "apex-confirm/pack-v1",
    period: t.period,
    member_no: memberNo,
    leaf_count: t.leafCount,
    depth: t.depth,
    root: nodeToJson(t.root),
    lines,
  };
}

/** Every counterparty number that has at least one line. */
export function counterparties(t: BuiltTree): number[] {
  return [...new Set(t.leaves.map((l) => l.cp))].sort((a, b) => a - b);
}

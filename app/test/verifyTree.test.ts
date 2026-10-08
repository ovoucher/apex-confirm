import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, rootJson, treeFile } from "../src/tree/build.js";
import { verifyTreeFile } from "../src/tree/verifyTree.js";
import { parseBook } from "../src/book/parseBook.js";
import { leafFromJson } from "../src/tree/leaf.js";
import { buildLevels, fileHashOf } from "../src/tree/build.js";
import { nodeToJson } from "../src/tree/node.js";
import { sha256 } from "../src/util/hash.js";
import { seed } from "./helpers.js";

const built = () => buildTree(1, parseBook(seed("apex-book-2026-08.csv")), sha256("k"));

test("a correct file passes against the on-chain root", () => {
  const t = built();
  const r = verifyTreeFile(treeFile(t), rootJson(t));
  assert.equal(r.ok, true, JSON.stringify(r.issues));
});

test("an injected negative leaf is detected even though no member proof touches it", () => {
  const t = built();
  const f = treeFile(t);
  // The apex hides a negative deposit on a non-member counterparty (no member ever gets
  // that line) and posts the resulting root. Every member's proof still verifies.
  const idx = f.leaves.findIndex((l) => l.cp === 901);
  f.leaves[idx] = { ...f.leaves[idx]!, kind: 1, balance: (-50_000_000_00n).toString() };
  const leaves = f.leaves.map(leafFromJson);
  const levels = buildLevels(1, leaves);
  const root = levels[levels.length - 1]![0]!;
  f.root = nodeToJson(root);
  f.file_hash = fileHashOf(leaves).toString("hex");
  const onChain = { period: 1, ...nodeToJson(root), leaf_count: f.leaf_count, depth: f.depth, file_hash: f.file_hash };
  const r = verifyTreeFile(f, onChain);
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues.map((i) => i.code), ["NEGATIVE_BALANCE"]);
  assert.equal(r.issues[0]!.index, idx);
});

test("a duplicate line_ref and a root mismatch are detected", () => {
  const t = built();
  const f = treeFile(t);
  f.leaves[3] = { ...f.leaves[3]!, line_ref: f.leaves[7]!.line_ref, ref: f.leaves[7]!.ref };
  const r = verifyTreeFile(f, rootJson(t));
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes("DUPLICATE_REF"));
  assert.ok(codes.includes("ROOT_MISMATCH"));
  assert.ok(codes.includes("FILE_HASH_MISMATCH"));
});

test("a file whose root differs from the posted root is rejected", () => {
  const t = built();
  const other = buildTree(1, parseBook(seed("apex-book-2026-08.csv")).slice(1), sha256("k"));
  const r = verifyTreeFile(treeFile(t), rootJson(other));
  assert.ok(r.issues.some((i) => i.code === "ROOT_MISMATCH"));
  assert.ok(r.issues.some((i) => i.code === "LEAF_COUNT_MISMATCH"));
});

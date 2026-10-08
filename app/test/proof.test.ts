import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, memberPack } from "../src/tree/build.js";
import { leafFromJson } from "../src/tree/leaf.js";
import { nodeFromJson } from "../src/tree/node.js";
import { verifyProof } from "../src/tree/proof.js";
import { shuffle, shuffleSeed } from "../src/tree/shuffle.js";
import { parseBook } from "../src/book/parseBook.js";
import { sha256 } from "../src/util/hash.js";
import { seed, vector } from "./helpers.js";

test("shared vector proofs verify, and a proof never verifies at another index", () => {
  const v = vector("tree5.json");
  const root = nodeFromJson(v.root);
  v.leaves.forEach((lj: any, i: number) => {
    const leaf = leafFromJson(lj);
    const proof = v.proofs[i].map(nodeFromJson);
    assert.deepEqual(verifyProof(leaf, proof, root, v.depth), { ok: true });
    for (let j = 0; j < v.leaves.length; j++) {
      if (j === i) continue;
      assert.equal(verifyProof({ ...leaf, index: j }, proof, root, v.depth).ok, false);
    }
    // one level short or long
    assert.equal(verifyProof(leaf, proof.slice(1), root, v.depth).ok, false);
    assert.equal(verifyProof(leaf, [...proof, root], root, v.depth).ok, false);
  });
});

test("a tampered pack fails: balance, arrears, sibling hash, sibling sum, negative sibling", () => {
  const lines = parseBook(seed("apex-book-2026-08.csv"));
  const tree = buildTree(1, lines, sha256("test-salt-key"));
  const pack = memberPack(tree, 5);
  assert.ok(pack.lines.length >= 2);
  const pl = pack.lines[0]!;
  const leaf = leafFromJson(pl.leaf);
  const proof = pl.proof.map(nodeFromJson);
  assert.equal(verifyProof(leaf, proof, tree.root, tree.depth).ok, true);
  assert.equal(verifyProof({ ...leaf, balance: leaf.balance + 1n }, proof, tree.root, tree.depth).ok, false);
  assert.equal(verifyProof({ ...leaf, arrearsDays: leaf.arrearsDays + 1 }, proof, tree.root, tree.depth).ok, false);
  const bad1 = proof.map((n, k) => (k === 2 ? { ...n, hash: sha256("x") } : n));
  assert.equal(verifyProof(leaf, bad1, tree.root, tree.depth).ok, false);
  const bad2 = proof.map((n, k) => (k === 0 ? { ...n, loan: n.loan + 1n } : n));
  assert.equal(verifyProof(leaf, bad2, tree.root, tree.depth).ok, false);
  const bad3 = proof.map((n, k) => (k === 0 ? { ...n, dep: -1n } : n));
  assert.deepEqual(verifyProof(leaf, bad3, tree.root, tree.depth), { ok: false, reason: "NegativeSum" });
});

test("the shuffle is deterministic per period seed and differs between periods", () => {
  const xs = Array.from({ length: 50 }, (_, i) => i);
  const key = sha256("k");
  const a = shuffle(xs, shuffleSeed(key, 1));
  assert.deepEqual(a, shuffle(xs, shuffleSeed(key, 1)));
  assert.notDeepEqual(a, shuffle(xs, shuffleSeed(key, 2)));
  assert.notDeepEqual(a, xs);
  assert.deepEqual([...a].sort((x, y) => x - y), xs);
});

test("building twice gives the same root; salts are never in the root file", () => {
  const lines = parseBook(seed("apex-book-2026-08.csv"));
  const t1 = buildTree(1, lines, sha256("k"));
  const t2 = buildTree(1, lines, sha256("k"));
  assert.ok(t1.root.hash.equals(t2.root.hash));
  const t3 = buildTree(1, lines, sha256("other key"));
  assert.ok(!t1.root.hash.equals(t3.root.hash), "a different salt key gives a different root");
  assert.equal(t1.root.dep, t3.root.dep);
});

test("the seed tree root equals the vector the Rust scenario reads", () => {
  const v = vector("seed-period-1.json");
  const keys = JSON.parse(seed("keys.test.json"));
  const tree = buildTree(1, parseBook(seed("apex-book-2026-08.csv")), Buffer.from(keys.apex_salt_key, "hex"));
  assert.equal(tree.root.hash.toString("hex"), v.root.hash);
  assert.equal(tree.fileHash.toString("hex"), v.file_hash);
});

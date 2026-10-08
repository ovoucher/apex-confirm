import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyNode, leafBytes, leafFromJson, leafHash, leafNode, lineRefHash } from "../src/tree/leaf.js";
import { nodeFromJson, nodeToJson } from "../src/tree/node.js";
import { hex, i128be, u32be } from "../src/util/hash.js";
import { vector } from "./helpers.js";

test("shared vector tree5.json: every leaf hash and leaf node (the Rust test checks the same file)", () => {
  const v = vector("tree5.json");
  for (const lj of v.leaves) {
    const l = leafFromJson(lj);
    assert.equal(hex(leafHash(l)), lj.leaf_hash);
    assert.deepEqual(nodeToJson(leafNode(l)), lj.node);
    assert.equal(hex(l.lineRef), hex(lineRefHash(lj.ref)));
  }
});

test("leaf byte layout: tag, u32 BE fields, 32-byte ref, i128 BE balance, salt", () => {
  const v = vector("tree5.json");
  const l = leafFromJson(v.leaves[1]);
  const b = leafBytes(l);
  assert.equal(b.length, 12 + 4 * 4 + 32 + 16 + 4 + 32);
  assert.equal(b.subarray(0, 12).toString(), "APEX-LEAF-v1");
  assert.deepEqual(b.subarray(12, 16), u32be(7));
  assert.deepEqual(b.subarray(60, 76), i128be(1_840_000_050n));
});

test("padding leaves: sha256(APEX-EMPTY-v1 || period || index), zero sums", () => {
  const v = vector("tree5.json");
  assert.equal(v.padding.length, 3);
  for (const pj of v.padding) {
    assert.deepEqual(nodeToJson(emptyNode(v.period, pj.index)), pj.node);
    assert.equal(nodeFromJson(pj.node).dep, 0n);
  }
});

test("i128 big-endian encoding matches Rust to_be_bytes, including negatives", () => {
  assert.equal(hex(i128be(1n)), "00".repeat(15) + "01");
  assert.equal(hex(i128be(-1n)), "ff".repeat(16));
  assert.equal(hex(i128be((1n << 127n) - 1n)), "7f" + "ff".repeat(15));
  assert.throws(() => i128be(1n << 127n));
});

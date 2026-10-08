import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLevels } from "../src/tree/build.js";
import { leafFromJson } from "../src/tree/leaf.js";
import { depthFor, nodeToJson, parentNode } from "../src/tree/node.js";
import { OverflowError } from "../src/util/hash.js";
import { vector } from "./helpers.js";

test("shared vector tree5.json: every level and the root", () => {
  const v = vector("tree5.json");
  const levels = buildLevels(v.period, v.leaves.map(leafFromJson));
  assert.equal(levels.length - 1, v.depth);
  assert.deepEqual(levels.map((lv) => lv.map(nodeToJson)), v.levels);
  assert.deepEqual(nodeToJson(levels[levels.length - 1]![0]!), v.root);
  assert.equal(v.root.dep, (6_125_000_000n + 1n).toString());
});

test("one-leaf tree has depth 1 and is padded", () => {
  const v = vector("tree1.json");
  assert.equal(v.depth, 1);
  assert.equal(v.padding.length, 1);
  const levels = buildLevels(1, v.leaves.map(leafFromJson));
  assert.deepEqual(nodeToJson(levels[1]![0]!), v.root);
});

test("depth formula", () => {
  assert.deepEqual([1, 2, 3, 5, 159, 4095, 4096].map(depthFor), [1, 1, 2, 3, 8, 12, 12]);
});

test("parent sums are checked for i128 overflow", () => {
  const h = Buffer.alloc(32);
  const max = (1n << 127n) - 1n;
  assert.throws(() => parentNode({ hash: h, dep: max, loan: 0n }, { hash: h, dep: 1n, loan: 0n }), OverflowError);
  const p = parentNode({ hash: h, dep: 2n, loan: 3n }, { hash: h, dep: 5n, loan: 7n });
  assert.equal(p.dep, 7n);
  assert.equal(p.loan, 10n);
});

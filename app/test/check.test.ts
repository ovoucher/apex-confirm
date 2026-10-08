import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBook } from "../src/book/parseBook.js";
import { parseLedger } from "../src/book/parseLedger.js";
import { buildTree, memberPack } from "../src/tree/build.js";
import { checkPack } from "../src/member/check.js";
import { expected, seed } from "./helpers.js";

const keys = JSON.parse(seed("keys.test.json"));
const tree = buildTree(1, parseBook(seed("apex-book-2026-08.csv")), Buffer.from(keys.apex_salt_key, "hex"));
const onChain = { root: tree.root, depth: tree.depth };
const check = (no: number) => checkPack(memberPack(tree, no), onChain, parseLedger(seed(`member-ledgers/${no}.csv`)));

test("members 5, 14, 19 and 33: proposals match expected.json", () => {
  const exp = expected().period_1.proposals;
  for (const no of [5, 14, 19, 33]) {
    const c = check(no);
    assert.equal(c.proofsOk, true);
    const nonConfirm = c.proposals.filter((p) => p.action !== "confirm");
    const want = exp[String(no)];
    assert.equal(nonConfirm.length, want.length, `member ${no}: ${JSON.stringify(nonConfirm, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    want.forEach((w: any, i: number) => {
      const got = nonConfirm[i]! as any;
      assert.equal(got.action, w.action);
      assert.equal(got.claimed.toString(), w.claimed);
      if (w.ref) assert.equal(got.ref, w.ref);
      if (w.reason) assert.equal(got.reason, w.reason);
    });
  }
});

test("a matching line proposes confirm; member 37 (colluding) confirms everything", () => {
  const c = check(37);
  assert.ok(c.proposals.length >= 2);
  assert.ok(c.proposals.every((p) => p.action === "confirm"));
  const c1 = check(1);
  assert.ok(c1.proposals.every((p) => p.action === "confirm"));
});

test("a line the member does not recognise is disputed NOT_OURS with claim 0", () => {
  const pack = memberPack(tree, 12);
  const ledger = parseLedger(seed("member-ledgers/12.csv")).slice(0, -1); // drop one line from our side
  const c = checkPack(pack, onChain, ledger);
  const d = c.proposals.find((p) => p.action === "dispute");
  assert.ok(d && d.action === "dispute");
  assert.equal(d.reason, "NOT_OURS");
  assert.equal(d.claimed, 0n);
});

test("a tampered pack is not confirmed: proposal is do-not-respond", () => {
  const pack = memberPack(tree, 5);
  pack.lines[0]!.leaf.balance = (BigInt(pack.lines[0]!.leaf.balance) - 1n).toString();
  const c = checkPack(pack, onChain, parseLedger(seed("member-ledgers/5.csv")));
  assert.equal(c.proofsOk, false);
  assert.equal(c.proposals[0]!.action, "do-not-respond");
});

test("a member with no lines and nothing in its ledger claims 0 (counts as its response)", () => {
  const empty = { ...memberPack(tree, 5), member_no: 5, lines: [] };
  const c = checkPack(empty, onChain, []);
  assert.deepEqual(c.proposals, [{ action: "claim-omitted", claimed: 0n, refs: [] }]);
});

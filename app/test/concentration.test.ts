import { test } from "node:test";
import assert from "node:assert/strict";
import { concentrationFlags } from "../src/report/concentration.js";
import { journey } from "./journey-cache.js";
import { expected, seed } from "./helpers.js";

const cfg = JSON.parse(seed("concentration.json"));

function lineInfo(p: ReturnType<typeof journey>["periods"][number]) {
  return p.tree.leaves.map((l, i) => ({ index: i, cp: l.cp, kind: l.kind, booked: l.balance, opened: p.bookOpened.get(p.tree.refs[i]!) ?? "", ref: p.tree.refs[i]! }));
}

test("member 37 (the colluding member) is flagged by rule (i); no honest member is flagged", () => {
  const p1 = journey().periods[0]!;
  const flags = p1.concentration;
  assert.deepEqual(flags.map((f) => f.member), [37]);
  assert.ok(flags[0]!.rules.includes("i"));
  assert.deepEqual(flags[0]!.rules, expected().period_1.concentration_flagged[0].rules);
  assert.equal(flags[0]!.label, "pattern for supervisory follow-up, not evidence");
  // period 2 as well
  assert.deepEqual(journey().periods[1]!.concentration.map((f) => f.member), []);
});

test("thresholds are read from config: loosening rule (i) clears member 37, tightening rule (ii) flags others", () => {
  const p1 = journey().periods[0]!;
  const omitted = [{ member_no: 33, claimed_deposit: 1_200_000_000n }];
  const loose = concentrationFlags(lineInfo(p1), p1.responses, omitted, p1.tree.root.loan, p1.asOfIso, { ...cfg, loan_to_deposit_multiple: 4, recent_loan_share_bps: 10_000 });
  assert.deepEqual(loose.map((f) => f.member), []);
  const tight = concentrationFlags(lineInfo(p1), p1.responses, omitted, p1.tree.root.loan, p1.asOfIso, { ...cfg, single_loan_share_bps: 100 });
  assert.ok(tight.length > 1);
  assert.ok(tight.some((f) => f.rules.includes("ii")));
});

test("config file carries the assumption note", () => {
  assert.match(cfg.note, /assumptions/);
  assert.equal(cfg.loan_to_deposit_multiple, 3);
  assert.equal(cfg.single_loan_share_bps, 500);
  assert.equal(cfg.recent_days, 30);
  assert.equal(cfg.recent_loan_share_bps, 100);
});

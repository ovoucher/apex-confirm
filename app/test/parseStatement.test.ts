import { test } from "node:test";
import assert from "node:assert/strict";
import { StatementError, parseStatement } from "../src/book/parseStatement.js";
import { seed } from "./helpers.js";

test("custodian statement: closing balance, 214 movements, reconciles", () => {
  const s = parseStatement(seed("custodian-statement-2026-08-31.csv"));
  assert.equal(s.closing, 30_541_231_855n);
  assert.equal(s.closingDate, "2026-08-31");
  assert.equal(s.movements.length, 214);
  assert.equal(s.reconciles, true);
  assert.equal(s.computedClosing, s.closing);
  assert.match(s.bank, /SIM CUSTODIAN BANK \(simulated\)/);
});

test("reversals, value-date differences and the decimal-comma line", () => {
  const text = seed("custodian-statement-2026-08-31.csv");
  const s = parseStatement(text);
  assert.ok(s.reversals >= 1);
  for (const r of s.movements.filter((m) => m.reversal)) {
    const orig = s.movements.find((m) => r.reference === `${m.reference}-REV`);
    assert.ok(orig, `reversal ${r.reference} has an original`);
    assert.equal(orig!.amount, -r.amount);
  }
  assert.ok(s.valueDateDiffers.length >= 2);
  assert.ok(s.valueDateDiffers.some((m) => m.valueDate > "2026-08-31"), "a movement value-dated after the balance date");
  const commaRow = text.split("\n").find((l) => /,"\d+,\d\d",/.test(l))!;
  const [whole, cents] = /"(\d+),(\d\d)"/.exec(commaRow)!.slice(1);
  const m = s.movements.find((x) => x.reference === commaRow.split(",")[2])!;
  assert.equal(m.amount, BigInt(whole!) * 100n + BigInt(cents!));
});

test("a missing closing-balance row is rejected", () => {
  const text = seed("custodian-statement-2026-08-31.csv").split("\n").filter((l) => !l.includes("CLOSING BALANCE")).join("\n");
  assert.throws(() => parseStatement(text), (e: unknown) => e instanceof StatementError && /CLOSING BALANCE/.test((e as Error).message));
});

test("a tampered movement no longer reconciles", () => {
  const text = seed("custodian-statement-2026-08-31.csv").replace("BANK CHARGES,", "BANK CHARGES,1");
  const s = parseStatement(text);
  assert.equal(s.reconciles, false);
});

test("the September statement parses", () => {
  const s = parseStatement(seed("period-2026-09/custodian-statement-2026-09-30.csv"));
  assert.equal(s.closing, 29_877_490_510n);
  assert.equal(s.reconciles, true);
});

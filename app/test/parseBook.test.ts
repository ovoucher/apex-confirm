import { test } from "node:test";
import assert from "node:assert/strict";
import { BookParseError, parseBook } from "../src/book/parseBook.js";
import { validateBook } from "../src/book/validate.js";
import { parseKes, formatKes } from "../src/util/amounts.js";
import { seed } from "./helpers.js";

test("amounts: separators, KES prefix, one decimal digit, decimal comma", () => {
  assert.equal(parseKes("1,234,567.89"), 123456789n);
  assert.equal(parseKes("1234567.9"), 123456790n);
  assert.equal(parseKes("KES 1,234,567.89"), 123456789n);
  assert.equal(parseKes("KES1234567"), 123456700n);
  assert.equal(parseKes("  45,000,000.00 "), 4_500_000_000n);
  assert.equal(parseKes("48250,75"), 4825075n);
  assert.equal(parseKes("(1,000.00)"), -100000n);
  for (const bad of ["", "abc", "1.234", "12,34,567", "1,2345.00", "--5"]) assert.throws(() => parseKes(bad), /amount/);
  assert.equal(formatKes(248_000_000_000n), "2,480,000,000.00");
  assert.equal(formatKes(-5n), "-0.05");
});

test("the seed book parses: 159 lines, separators, prefix, one-decimal balance, blank line", () => {
  const text = seed("apex-book-2026-08.csv");
  assert.ok(text.includes('"KES '), "some balances carry a KES prefix");
  assert.ok(/,"\d{1,3}(,\d{3})+\.\d\d",/.test(text), "some balances carry thousands separators");
  assert.ok(/\n\n/.test(text), "a blank line");
  assert.ok(/ +\n/.test(text), "trailing whitespace");
  const lines = parseBook(text);
  assert.equal(lines.length, 159);
  assert.equal(lines.filter((l) => l.kind === "DEP").length, 39);
  assert.equal(lines.filter((l) => l.kind === "LOAN").length, 120);
  assert.equal(lines.reduce((a, l) => a + (l.kind === "DEP" ? l.balance : 0n), 0n), 248_000_000_000n);
  assert.equal(lines.reduce((a, l) => a + (l.kind === "LOAN" ? l.balance : 0n), 0n), 223_690_000_000n);
  const oneDecimal = lines.find((l) => l.balance % 100n === 50n && text.includes(`${l.balance / 100n}.5,`));
  assert.ok(oneDecimal, "the one-decimal balance is read as .50");
  // line numbers survive the blank line
  const last = lines[lines.length - 1]!;
  assert.equal(text.split("\n")[last.line - 1]!.split(",")[0], last.lineRef);
});

test("the dirty book is rejected by validation with line numbers", () => {
  const lines = parseBook(seed("apex-book-2026-08-dirty.csv"));
  const members = Array.from({ length: 40 }, (_, i) => ({ no: i + 1, active: i + 1 !== 38 }));
  const v = validateBook(lines, members);
  assert.equal(v.ok, false);
  const dup = v.issues.filter((i) => i.code === "DUPLICATE_REF");
  assert.equal(dup.length, 1);
  assert.match(dup[0]!.message, /already used on line \d+/);
  assert.ok(dup[0]!.line > 100);
});

test("validation levels: non-member loans are info, deposits to non-members warn, arrears on deposits error", () => {
  const members = Array.from({ length: 40 }, (_, i) => ({ no: i + 1, active: i + 1 !== 38 }));
  const v = validateBook(parseBook(seed("apex-book-2026-08.csv")), members);
  assert.equal(v.ok, true);
  assert.equal(v.issues.filter((i) => i.code === "LOAN_TO_NON_MEMBER").length, 3);
  assert.equal(v.issues.filter((i) => i.code === "LOAN_TO_INACTIVE").length, 2);
  const bad = parseBook(
    "line_ref,cp_no,cp_name,kind,balance_kes,arrears_days,product,opened,notes\nD1,99,X,DEP,10.00,5,,,\nL1,1,Y,LOAN,(5.00),0,,,\n",
  );
  const v2 = validateBook(bad, members);
  assert.deepEqual(v2.issues.map((i) => i.code).sort(), ["ARREARS_ON_DEPOSIT", "DEPOSIT_TO_NON_MEMBER", "NEGATIVE_BALANCE"]);
  assert.equal(v2.ok, false);
});

test("unparseable rows are all reported with their line numbers", () => {
  const text = "line_ref,cp_no,cp_name,kind,balance_kes,arrears_days,product,opened,notes\nA,1,X,DEP,12.00,,,,\n\nB,x,Y,LOAN,1.00,0,,,\nC,2,Z,BOND,1.00,0,,,\nD,3,W,LOAN,one million,0,,,\nE,4,V,LOAN,1.00,-3,,,\n";
  try {
    parseBook(text);
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof BookParseError);
    assert.deepEqual(e.issues.map((i) => i.line), [4, 5, 6, 7]);
    assert.match(e.message, /line 6: unparseable amount "one million"/);
  }
});

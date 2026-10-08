/**
 * Parse the custodian bank's account statement CSV. Metadata lines ("Bank,...",
 * "Account,...") may precede the header row
 *   posting_date,value_date,reference,narrative,debit_kes,credit_kes,balance_kes
 * The OPENING BALANCE and CLOSING BALANCE rows carry `balance_kes`; movement rows carry a
 * debit or a credit. The closing balance on the balance date is what the custodian attests.
 */
import { parseKes } from "../util/amounts.js";
import { parseCsv } from "../util/csv.js";

export interface Movement {
  line: number;
  postingDate: string;
  valueDate: string;
  reference: string;
  narrative: string;
  /** signed: credit positive, debit negative (cents) */
  amount: bigint;
  reversal: boolean;
}

export interface Statement {
  bank: string;
  account: string;
  opening: bigint;
  closing: bigint;
  closingDate: string;
  movements: Movement[];
  reversals: number;
  /** movements whose value date differs from the posting date */
  valueDateDiffers: Movement[];
  computedClosing: bigint;
  reconciles: boolean;
}

export class StatementError extends Error {}

export function parseStatement(text: string): Statement {
  const rows = parseCsv(text);
  let bank = "";
  let account = "";
  let h = -1;
  for (let i = 0; i < rows.length; i++) {
    const first = rows[i]!.cells[0]!.toLowerCase();
    if (first === "posting_date") {
      h = i;
      break;
    }
    if (first === "bank") bank = rows[i]!.cells[1] ?? "";
    if (first === "account") account = rows[i]!.cells[1] ?? "";
  }
  if (h < 0) throw new StatementError("no header row starting with posting_date");
  const header = rows[h]!.cells.map((c) => c.toLowerCase());
  const col = (n: string): number => {
    const i = header.indexOf(n);
    if (i < 0) throw new StatementError(`missing column ${n}`);
    return i;
  };
  const [cPost, cVal, cRef, cNarr, cDr, cCr, cBal] = [
    col("posting_date"),
    col("value_date"),
    col("reference"),
    col("narrative"),
    col("debit_kes"),
    col("credit_kes"),
    col("balance_kes"),
  ];
  let opening: bigint | undefined;
  let closing: bigint | undefined;
  let closingDate = "";
  const movements: Movement[] = [];
  for (const r of rows.slice(h + 1)) {
    const cell = (i: number): string => r.cells[i] ?? "";
    const ref = cell(cRef).toUpperCase();
    try {
      if (ref === "OPENING BALANCE") {
        opening = parseKes(cell(cBal));
        continue;
      }
      if (ref === "CLOSING BALANCE") {
        closing = parseKes(cell(cBal));
        closingDate = cell(cPost);
        continue;
      }
      const dr = cell(cDr) === "" ? 0n : parseKes(cell(cDr));
      const cr = cell(cCr) === "" ? 0n : parseKes(cell(cCr));
      if (dr !== 0n && cr !== 0n) throw new StatementError("both debit and credit set");
      movements.push({
        line: r.line,
        postingDate: cell(cPost),
        valueDate: cell(cVal),
        reference: cell(cRef),
        narrative: cell(cNarr),
        amount: cr - dr,
        reversal: /^(REV|REVERSAL)\b/i.test(cell(cNarr)) || /-REV$/i.test(cell(cRef)),
      });
    } catch (e) {
      throw new StatementError(`line ${r.line}: ${(e as Error).message}`);
    }
  }
  if (opening === undefined) throw new StatementError("missing OPENING BALANCE row");
  if (closing === undefined) throw new StatementError("missing CLOSING BALANCE row");
  const computedClosing = movements.reduce((a, m) => a + m.amount, opening);
  return {
    bank,
    account,
    opening,
    closing,
    closingDate,
    movements,
    reversals: movements.filter((m) => m.reversal).length,
    valueDateDiffers: movements.filter((m) => m.valueDate !== m.postingDate),
    computedClosing,
    reconciles: computedClosing === closing,
  };
}

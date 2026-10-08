/**
 * A member SACCO's own ledger of positions with the apex:
 *   line_ref, kind, balance_kes, arrears_days
 * `kind` is from the apex's point of view (DEP = our deposit placed with the apex,
 * LOAN = our borrowing from the apex), so rows line up with the apex book.
 */
import { parseKes } from "../util/amounts.js";
import { headerIndex, parseCsv } from "../util/csv.js";
import { type LineKind, parseKind } from "./parseBook.js";

export interface LedgerLine {
  line: number;
  lineRef: string;
  kind: LineKind;
  balance: bigint;
  arrearsDays: number;
}

export function parseLedger(text: string): LedgerLine[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const idx = headerIndex(rows[0]!, ["line_ref", "kind", "balance_kes", "arrears_days"]);
  return rows.slice(1).map((r) => {
    const kind = parseKind(r.cells[idx["kind"]!] ?? "");
    if (!kind) throw new Error(`line ${r.line}: bad kind`);
    const arr = (r.cells[idx["arrears_days"]!] ?? "").trim();
    if (arr !== "" && !/^\d+$/.test(arr)) throw new Error(`line ${r.line}: bad arrears_days "${arr}"`);
    return {
      line: r.line,
      lineRef: (r.cells[idx["line_ref"]!] ?? "").trim(),
      kind,
      balance: parseKes(r.cells[idx["balance_kes"]!] ?? ""),
      arrearsDays: arr === "" ? 0 : Number(arr),
    };
  });
}

/**
 * Parse the apex book CSV exported by the apex's core banking:
 *   line_ref, cp_no, cp_name, kind (DEP|LOAN), balance_kes, arrears_days, product, opened, notes
 * Balances may carry thousands separators, a "KES " prefix or a single decimal digit.
 * Every unparseable row is reported with its source line number; nothing is guessed.
 */
import { AmountError, parseKes } from "../util/amounts.js";
import { headerIndex, parseCsv } from "../util/csv.js";

export type LineKind = "DEP" | "LOAN";

export interface BookLine {
  /** 1-based source line number. */
  line: number;
  lineRef: string;
  cpNo: number;
  cpName: string;
  kind: LineKind;
  balance: bigint;
  arrearsDays: number;
  product: string;
  opened: string;
  notes: string;
}

export interface ParseIssue {
  line: number;
  message: string;
}

export class BookParseError extends Error {
  constructor(public readonly issues: ParseIssue[]) {
    super(`book rejected:\n${issues.map((i) => `  line ${i.line}: ${i.message}`).join("\n")}`);
  }
}

const COLUMNS = ["line_ref", "cp_no", "cp_name", "kind", "balance_kes", "arrears_days", "product", "opened", "notes"];

export function parseKind(raw: string): LineKind | undefined {
  const k = raw.trim().toUpperCase();
  if (k === "DEP" || k === "DEPOSIT") return "DEP";
  if (k === "LOAN" || k === "LN") return "LOAN";
  return undefined;
}

/** Parse; throws `BookParseError` listing every bad row. */
export function parseBook(text: string): BookLine[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new BookParseError([{ line: 1, message: "empty file" }]);
  const idx = headerIndex(rows[0]!, COLUMNS.slice(0, 6));
  const out: BookLine[] = [];
  const issues: ParseIssue[] = [];
  for (const r of rows.slice(1)) {
    const c = (name: string): string => (idx[name] === undefined ? "" : (r.cells[idx[name]!] ?? "").trim());
    const lineRef = c("line_ref");
    if (!lineRef) {
      issues.push({ line: r.line, message: "missing line_ref" });
      continue;
    }
    const cpRaw = c("cp_no");
    const cpNo = Number(cpRaw);
    if (!/^\d+$/.test(cpRaw) || cpNo < 1 || cpNo > 0xffffffff) {
      issues.push({ line: r.line, message: `bad cp_no "${cpRaw}"` });
      continue;
    }
    const kind = parseKind(c("kind"));
    if (!kind) {
      issues.push({ line: r.line, message: `bad kind "${c("kind")}" (want DEP or LOAN)` });
      continue;
    }
    let balance: bigint;
    try {
      balance = parseKes(c("balance_kes"));
    } catch (e) {
      issues.push({ line: r.line, message: e instanceof AmountError ? e.message : String(e) });
      continue;
    }
    const arrRaw = c("arrears_days");
    if (arrRaw !== "" && !/^\d+$/.test(arrRaw)) {
      issues.push({ line: r.line, message: `bad arrears_days "${arrRaw}"` });
      continue;
    }
    out.push({
      line: r.line,
      lineRef,
      cpNo,
      cpName: c("cp_name"),
      kind,
      balance,
      arrearsDays: arrRaw === "" ? 0 : Number(arrRaw),
      product: c("product"),
      opened: c("opened"),
      notes: c("notes"),
    });
  }
  if (issues.length) throw new BookParseError(issues);
  return out;
}

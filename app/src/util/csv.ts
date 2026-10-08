/** Minimal RFC-4180-style CSV reader that keeps source line numbers for error messages. */

export interface CsvRow {
  /** 1-based line number in the source file. */
  line: number;
  cells: string[];
}

/** Split text into rows. Quoted fields may contain commas and doubled quotes. Blank lines are skipped. */
export function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "") continue;
    rows.push({ line: i + 1, cells: splitLine(raw) });
  }
  return rows;
}

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Quote a cell when needed. */
export function csvCell(v: string | number | bigint): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Map header names to column indexes; throws when a required column is missing. */
export function headerIndex(header: CsvRow, required: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  header.cells.forEach((c, i) => (idx[c.toLowerCase()] = i));
  for (const r of required) {
    if (!(r in idx)) throw new Error(`line ${header.line}: missing column "${r}"`);
  }
  return idx;
}

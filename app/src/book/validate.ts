/**
 * Validation of a parsed apex book before a tree is built:
 *   error    duplicate line_ref, negative balance, arrears on a deposit line
 *   warning  deposit line to an unregistered cp_no (a liability to a non-member)
 *   info     loan to an unregistered or inactive number (listed in the regulator report;
 *            such lines can never be confirmed)
 */
import type { BookLine } from "./parseBook.js";

export type Level = "error" | "warning" | "info";

export interface Issue {
  level: Level;
  line: number;
  code: "DUPLICATE_REF" | "NEGATIVE_BALANCE" | "ARREARS_ON_DEPOSIT" | "DEPOSIT_TO_NON_MEMBER" | "LOAN_TO_NON_MEMBER" | "LOAN_TO_INACTIVE" | "TOO_MANY_LINES";
  message: string;
}

export interface MemberStatus {
  no: number;
  active: boolean;
}

export interface ValidationResult {
  ok: boolean;
  issues: Issue[];
}

export function validateBook(lines: BookLine[], members: MemberStatus[]): ValidationResult {
  const issues: Issue[] = [];
  const reg = new Map(members.map((m) => [m.no, m]));
  const seen = new Map<string, number>();
  if (lines.length > 4096) {
    issues.push({ level: "error", line: 0, code: "TOO_MANY_LINES", message: `${lines.length} lines; a period holds at most 4096` });
  }
  for (const l of lines) {
    const prev = seen.get(l.lineRef);
    if (prev !== undefined) {
      issues.push({ level: "error", line: l.line, code: "DUPLICATE_REF", message: `line_ref ${l.lineRef} already used on line ${prev}` });
    } else seen.set(l.lineRef, l.line);
    if (l.balance < 0n) {
      issues.push({ level: "error", line: l.line, code: "NEGATIVE_BALANCE", message: `negative balance on ${l.lineRef}` });
    }
    if (l.kind === "DEP" && l.arrearsDays > 0) {
      issues.push({ level: "error", line: l.line, code: "ARREARS_ON_DEPOSIT", message: `deposit ${l.lineRef} carries ${l.arrearsDays} arrears days` });
    }
    const m = reg.get(l.cpNo);
    if (l.kind === "DEP" && !m) {
      issues.push({ level: "warning", line: l.line, code: "DEPOSIT_TO_NON_MEMBER", message: `deposit ${l.lineRef} is owed to unregistered counterparty ${l.cpNo}` });
    }
    if (l.kind === "LOAN" && !m) {
      issues.push({ level: "info", line: l.line, code: "LOAN_TO_NON_MEMBER", message: `loan ${l.lineRef} to unregistered counterparty ${l.cpNo} (${l.cpName}) can never be confirmed` });
    }
    if (l.kind === "LOAN" && m && !m.active) {
      issues.push({ level: "info", line: l.line, code: "LOAN_TO_INACTIVE", message: `loan ${l.lineRef} to inactive member ${l.cpNo} can never be confirmed` });
    }
  }
  return { ok: !issues.some((i) => i.level === "error"), issues };
}

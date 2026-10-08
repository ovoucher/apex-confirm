/**
 * Member-side pack check. For each line in the member's pack: verify the inclusion proof
 * against the on-chain root, then compare with the member's own ledger export and
 * PROPOSE confirm, dispute (with the member's figure) or claim-omitted. The board decides;
 * nothing here signs or submits anything.
 */
import { formatKes } from "../util/amounts.js";
import type { MemberPack } from "../tree/build.js";
import type { LedgerLine } from "../book/parseLedger.js";
import { KIND_DEPOSIT, leafFromJson, lineRefHash } from "../tree/leaf.js";
import { type SumNode, nodeFromJson } from "../tree/node.js";
import { type ProofResult, verifyProof } from "../tree/proof.js";
import { REASON } from "../register/errors.js";

export type Proposal =
  | { action: "confirm"; index: number; ref: string }
  | {
      action: "dispute";
      index: number;
      ref: string;
      claimed: bigint;
      claimedArrears: number;
      reason: keyof typeof REASON;
      note: string;
    }
  | { action: "claim-omitted"; claimed: bigint; refs: string[] }
  | { action: "do-not-respond"; index: number; ref: string; note: string }
  | { action: "note"; ref: string; note: string };

export interface CheckedLine {
  index: number;
  ref: string;
  kind: number;
  booked: bigint;
  arrearsDays: number;
  proof: ProofResult;
  ledger: LedgerLine | null;
}

export interface CheckResult {
  member: number;
  period: number;
  lines: CheckedLine[];
  proposals: Proposal[];
  proofsOk: boolean;
}

export function checkPack(pack: MemberPack, onChain: { root: SumNode; depth: number }, ledger: LedgerLine[]): CheckResult {
  const byRef = new Map(ledger.map((l) => [l.lineRef.trim(), l]));
  const used = new Set<string>();
  const lines: CheckedLine[] = [];
  const proposals: Proposal[] = [];
  for (const pl of pack.lines) {
    const leaf = leafFromJson(pl.leaf);
    let proof = verifyProof(leaf, pl.proof.map(nodeFromJson), onChain.root, onChain.depth);
    if (proof.ok && !lineRefHash(pl.ref).equals(leaf.lineRef)) proof = { ok: false, reason: "BadProof" };
    if (proof.ok && (leaf.cp !== pack.member_no || leaf.period !== pack.period)) proof = { ok: false, reason: "BadProof" };
    const led = byRef.get(pl.ref.trim()) ?? null;
    if (led) used.add(led.lineRef.trim());
    lines.push({ index: leaf.index, ref: pl.ref, kind: leaf.kind, booked: leaf.balance, arrearsDays: leaf.arrearsDays, proof, ledger: led });
    if (!proof.ok) {
      proposals.push({ action: "do-not-respond", index: leaf.index, ref: pl.ref, note: `proof check failed (${proof.reason}); report the pack to the registrar` });
      continue;
    }
    const kindName = leaf.kind === KIND_DEPOSIT ? "DEP" : "LOAN";
    if (!led) {
      proposals.push({ action: "dispute", index: leaf.index, ref: pl.ref, claimed: 0n, claimedArrears: 0, reason: "NOT_OURS", note: `no ${kindName} ${pl.ref} in our ledger` });
    } else if (led.kind !== kindName) {
      proposals.push({ action: "dispute", index: leaf.index, ref: pl.ref, claimed: led.balance, claimedArrears: led.arrearsDays, reason: "OTHER", note: `apex books ${pl.ref} as ${kindName}, our ledger as ${led.kind}` });
    } else if (led.balance !== leaf.balance) {
      proposals.push({ action: "dispute", index: leaf.index, ref: pl.ref, claimed: led.balance, claimedArrears: led.arrearsDays, reason: "BALANCE_WRONG", note: `apex KES ${formatKes(leaf.balance)} vs ours KES ${formatKes(led.balance)}` });
    } else if (led.arrearsDays !== leaf.arrearsDays) {
      proposals.push({ action: "dispute", index: leaf.index, ref: pl.ref, claimed: led.balance, claimedArrears: led.arrearsDays, reason: "ARREARS_WRONG", note: `apex ${leaf.arrearsDays} vs ours ${led.arrearsDays} arrears days` });
    } else {
      proposals.push({ action: "confirm", index: leaf.index, ref: pl.ref });
    }
  }
  const missingDeposits = ledger.filter((l) => !used.has(l.lineRef.trim()) && l.kind === "DEP");
  for (const l of ledger.filter((l) => !used.has(l.lineRef.trim()) && l.kind === "LOAN")) {
    proposals.push({ action: "note", ref: l.lineRef, note: "loan in our ledger has no apex line (apex under-reports its own asset); raise off-chain" });
  }
  if (missingDeposits.length > 0) {
    proposals.push({ action: "claim-omitted", claimed: missingDeposits.reduce((a, l) => a + l.balance, 0n), refs: missingDeposits.map((l) => l.lineRef) });
  } else if (pack.lines.length === 0) {
    proposals.push({ action: "claim-omitted", claimed: 0n, refs: [] });
  }
  return { member: pack.member_no, period: pack.period, lines, proposals, proofsOk: lines.every((l) => l.proof.ok) };
}

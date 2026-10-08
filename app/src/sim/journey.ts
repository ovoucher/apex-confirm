/**
 * The full seeded journey in offline mode (the model mirrors the contract): two periods,
 * forty member SACCOs, one custodian. Used by `apex simulate`, by the scenario test and by
 * the seed generator (to export the action log the Rust scenario test replays).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseBook } from "../book/parseBook.js";
import { parseLedger } from "../book/parseLedger.js";
import { parseStatement } from "../book/parseStatement.js";
import { validateBook, type ValidationResult } from "../book/validate.js";
import { type BuiltTree, buildTree, memberPack } from "../tree/build.js";
import { leafFromJson } from "../tree/leaf.js";
import { nodeFromJson } from "../tree/node.js";
import { type CheckResult, checkPack } from "../member/check.js";
import { RegisterModel } from "../register/model.js";
import { REASON } from "../register/errors.js";
import type { Report, Response } from "../register/types.js";
import { type ConcentrationConfig, type ConcentrationFlag, concentrationFlags } from "../report/concentration.js";
import { parseCsv } from "../util/csv.js";
import { fromHex, sha256 } from "../util/hash.js";
import { DAY, dateToAsOf, parseIso } from "../util/time.js";

export interface SeedMember {
  no: number;
  name: string;
  licence: string;
  board: string;
  active: boolean;
}

export interface SeedKeys {
  apex_salt_key: string;
  registrar_salt: string;
  registrar: { public: string; secret: string };
  apex: { public: string; secret: string };
  custodian: { public: string; secret: string; name: string };
  boards: { no: number; board: string; threshold: number; officers: { role: string; public_hex: string; secret: string }[] }[];
}

export interface SeedConfig {
  apex_name: string;
  currency: string;
  decimals: number;
  confirm_window_secs: number;
  attest_window_secs: number;
  max_period_gap_secs: number;
  performing_max_days: number;
  alert_bps: number;
}

export function loadMembers(file: string): SeedMember[] {
  const rows = parseCsv(readFileSync(file, "utf8"));
  return rows.slice(1).map((r) => ({
    no: Number(r.cells[0]),
    name: r.cells[1]!,
    licence: r.cells[2]!,
    board: r.cells[3]!,
    active: r.cells[4] === "true",
  }));
}

export function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function licenceHash(licence: string, registrarSalt: Buffer): string {
  return sha256(licence, registrarSalt).toString("hex");
}

export type Action =
  | { at: number; member: number; type: "confirm"; indexes: number[] }
  | { at: number; member: number; type: "dispute"; index: number; claimed: string; claimed_arrears: number; reason: number; evidence: string }
  | { at: number; member: number; type: "omitted"; claimed: string; evidence: string };

export interface PeriodResult {
  period: number;
  asOf: number;
  asOfIso: string;
  openAt: number;
  postAt: number;
  tree: BuiltTree;
  validation: ValidationResult;
  cash: bigint;
  cashAt: number;
  statementHash: string;
  actions: Action[];
  staleChecks: { at: number; expect: boolean; got: boolean }[];
  staleFlag: boolean;
  watchAt: number;
  closeAt: number;
  report: Report;
  overdueFlagged: number[];
  streak22: number;
  checks: Map<number, CheckResult>;
  concentration: ConcentrationFlag[];
  responses: Response[];
  bookOpened: Map<string, string>;
}

export interface JourneyResult {
  model: RegisterModel;
  members: SeedMember[];
  keys: SeedKeys;
  config: SeedConfig;
  periods: PeriodResult[];
}

interface Plan1 {
  init_at: string;
  as_of: string;
  open_at: string;
  post_at: string;
  custodian: { day: number; hour: number };
  members: { no: number; day: number; hour: number }[];
  watch_day: number;
  close_day: number;
}

interface Plan2 {
  as_of: string;
  open_at: string;
  custodian: { day: number; hour: number };
  watch_checks: { day: number; expect_stale: boolean }[];
  post_day: number;
  members_confirm_all: { no: number; day: number; hour: number }[];
  watch_day: number;
  close_day: number;
}

export interface JourneyOptions {
  seedDir: string;
  /** unused by the journey; lets the generator pass its expectations through for logging */
  expectedOverride?: unknown;
  log?: (line: string) => void;
}

const evidenceHash = (s: string): string => sha256(`evidence/${s}`).toString("hex");

export function runJourney(opts: JourneyOptions): JourneyResult {
  const dir = opts.seedDir;
  const log = opts.log ?? (() => {});
  const members = loadMembers(join(dir, "members.csv"));
  const keys = loadJson<SeedKeys>(join(dir, "keys.test.json"));
  const config = loadJson<SeedConfig>(join(dir, "config.json"));
  const conc = loadJson<ConcentrationConfig>(join(dir, "concentration.json"));
  const saltKey = fromHex(keys.apex_salt_key, 32);
  const regSalt = fromHex(keys.registrar_salt, 32);
  const registrar = keys.registrar.public;
  const apex = keys.apex.public;
  const custodian = keys.custodian.public;
  const boardOf = new Map(members.map((m) => [m.no, m.board]));

  const plan1 = loadJson<Plan1>(join(dir, "responses-plan.json"));
  const plan2 = loadJson<Plan2>(join(dir, "period-2026-09", "responses-plan.json"));
  const model = new RegisterModel();

  // ---------------------------------------------------------------- setup (registrar, never the apex)
  model.setTime(parseIso(plan1.init_at));
  model.init([registrar], {
    registrar,
    apex,
    currency: config.currency,
    decimals: config.decimals,
    confirm_window_secs: config.confirm_window_secs,
    attest_window_secs: config.attest_window_secs,
    max_period_gap_secs: config.max_period_gap_secs,
    performing_max_days: config.performing_max_days,
    alert_bps: config.alert_bps,
  });
  for (const m of members) model.registerMember([registrar], m.no, m.board, licenceHash(m.licence, regSalt));
  model.setCustodian([registrar], custodian, true);
  for (const m of members) if (!m.active) model.setMemberActive([registrar], m.no, false);
  log(`registered ${members.length} members (inactive: member ${members.filter((m) => !m.active).map((m) => m.no).join(", member ")}) and 1 custodian`);

  const periods: PeriodResult[] = [];

  // ---------------------------------------------------------------- helpers
  const statusList = () => members.map((m) => ({ no: m.no, active: model.member(m.no)?.active ?? false }));

  function prepare(period: number, bookFile: string): { tree: BuiltTree; validation: ValidationResult; opened: Map<string, string> } {
    const lines = parseBook(readFileSync(bookFile, "utf8"));
    const validation = validateBook(lines, statusList());
    if (!validation.ok) throw new Error(`book ${bookFile} failed validation`);
    const tree = buildTree(period, lines, saltKey);
    return { tree, validation, opened: new Map(lines.map((l) => [l.lineRef, l.opened])) };
  }

  function respondFromCheck(period: number, tree: BuiltTree, no: number, at: number, check: CheckResult, actions: Action[]): void {
    model.setTime(at);
    const auth = [boardOf.get(no)!];
    const confirms: number[] = [];
    for (const p of check.proposals) if (p.action === "confirm") confirms.push(p.index);
    for (let i = 0; i < confirms.length; i += 16) {
      const chunk = confirms.slice(i, i + 16);
      model.confirmBatch(auth, period, no, chunk.map((idx) => itemFor(tree, idx)));
    }
    if (confirms.length) actions.push({ at, member: no, type: "confirm", indexes: confirms });
    for (const p of check.proposals) {
      if (p.action === "dispute") {
        const it = itemFor(tree, p.index);
        const ev = evidenceHash(`${period}/${no}/${p.ref}`);
        model.dispute(auth, period, no, it.leaf, it.proof, p.claimed, p.claimedArrears, REASON[p.reason], ev);
        actions.push({ at, member: no, type: "dispute", index: p.index, claimed: p.claimed.toString(), claimed_arrears: p.claimedArrears, reason: REASON[p.reason], evidence: ev });
      } else if (p.action === "claim-omitted") {
        const ev = evidenceHash(`${period}/${no}/omitted`);
        model.claimOmitted(auth, period, no, p.claimed, ev);
        actions.push({ at, member: no, type: "omitted", claimed: p.claimed.toString(), evidence: ev });
      }
    }
  }

  function watchAndClose(period: number, at: number): { flagged: number[]; report: Report } {
    model.setTime(at);
    const before = model.state.events.length;
    let rounds = 0;
    while ((model.state.overdueCursor[period] ?? 1) <= model.state.maxMemberNo && rounds++ < 100) model.markOverdue(period, 25);
    model.flagStaleApex();
    const flagged = model.state.events
      .slice(before)
      .filter((e) => e.name === "overdue")
      .map((e) => Number(e.topics[0]));
    const report = model.closePeriod(period);
    return { flagged, report };
  }

  // ---------------------------------------------------------------- period 1 (August)
  {
    const asOfIso = plan1.as_of;
    const asOf = dateToAsOf(asOfIso);
    const openAt = parseIso(plan1.open_at);
    const postAt = parseIso(plan1.post_at);
    model.setTime(openAt);
    const period = model.openPeriod([apex], asOf, 0);
    const { tree, validation, opened } = prepare(period, join(dir, "apex-book-2026-08.csv"));
    model.setTime(postAt);
    model.postRoot([apex], period, tree.root, tree.leafCount, tree.fileHash.toString("hex"));
    log(`period ${period}: posted root over ${tree.leafCount} lines (depth ${tree.depth})`);
    const stmtText = readFileSync(join(dir, "custodian-statement-2026-08-31.csv"), "utf8");
    const stmt = parseStatement(stmtText);
    const statementHash = sha256(stmtText).toString("hex");
    const cashAt = postAt + plan1.custodian.day * DAY + (plan1.custodian.hour - 8) * 3600;
    type Ev = { at: number; kind: "cash" } | { at: number; kind: "member"; no: number };
    const evs: Ev[] = [{ at: cashAt, kind: "cash" }, ...plan1.members.map((m) => ({ at: postAt + m.day * DAY + (m.hour - 8) * 3600, kind: "member" as const, no: m.no }))];
    evs.sort((a, b) => a.at - b.at || (a.kind === "cash" ? -1 : 1));
    const actions: Action[] = [];
    const checks = new Map<number, CheckResult>();
    const onChain = { root: tree.root, depth: tree.depth };
    for (const e of evs) {
      if (e.kind === "cash") {
        model.setTime(e.at);
        model.attestCash([custodian], period, custodian, stmt.closing, asOf, statementHash);
        continue;
      }
      const ledgerFile = join(dir, "member-ledgers", `${e.no}.csv`);
      const ledger = existsSync(ledgerFile) ? parseLedger(readFileSync(ledgerFile, "utf8")) : [];
      const check = checkPack(memberPack(tree, e.no), onChain, ledger);
      checks.set(e.no, check);
      respondFromCheck(period, tree, e.no, e.at, check, actions);
    }
    const watchAt = postAt + plan1.watch_day * DAY + 2 * 3600;
    const { flagged, report } = watchAndClose(period, watchAt);
    const responses = model.responsesOf(period);
    periods.push({
      period,
      asOf,
      asOfIso,
      openAt,
      postAt,
      tree,
      validation,
      cash: stmt.closing,
      cashAt,
      statementHash,
      actions,
      staleChecks: [],
      staleFlag: model.apexStaleSince() > 0,
      watchAt,
      closeAt: watchAt,
      report,
      overdueFlagged: flagged,
      streak22: model.member(22)?.overdue_streak ?? 0,
      checks,
      concentration: concentrationFlags(
        tree.leaves.map((l, i) => ({ index: i, cp: l.cp, kind: l.kind, booked: l.balance, opened: opened.get(tree.refs[i]!) ?? "", ref: tree.refs[i]! })),
        responses,
        Object.values(model.state.omitted).filter((o) => model.omittedOf(period, o.member_no) === o),
        tree.root.loan,
        asOfIso,
        conc,
      ),
      responses,
      bookOpened: opened,
    });
    log(`period ${period}: closed with coverage ${report.coverage_bps} bps vs booked ${report.booked_coverage_bps} bps`);
  }

  // ---------------------------------------------------------------- period 2 (September): the apex stalls
  {
    const asOfIso = plan2.as_of;
    const asOf = dateToAsOf(asOfIso);
    const openAt = parseIso(plan2.open_at);
    model.setTime(openAt);
    const period = model.openPeriod([apex], asOf, 0);
    const stmtText = readFileSync(join(dir, "period-2026-09", "custodian-statement-2026-09-30.csv"), "utf8");
    const stmt = parseStatement(stmtText);
    const statementHash = sha256(stmtText).toString("hex");
    const cashAt = openAt + plan2.custodian.day * DAY + (plan2.custodian.hour - 7) * 3600;
    model.setTime(cashAt);
    model.attestCash([custodian], period, custodian, stmt.closing, asOf, statementHash);
    const staleChecks: PeriodResult["staleChecks"] = [];
    for (const c of plan2.watch_checks) {
      const at = openAt + c.day * DAY + 2 * 3600;
      model.setTime(at);
      staleChecks.push({ at, expect: c.expect_stale, got: model.flagStaleApex() });
    }
    const { tree, validation, opened } = prepare(period, join(dir, "period-2026-09", "apex-book-2026-09.csv"));
    const postAt = openAt + plan2.post_day * DAY + 2 * 3600;
    model.setTime(postAt);
    model.postRoot([apex], period, tree.root, tree.leafCount, tree.fileHash.toString("hex"));
    const actions: Action[] = [];
    const checks = new Map<number, CheckResult>();
    const order = plan2.members_confirm_all.map((m) => ({ no: m.no, at: openAt + m.day * DAY + (m.hour - 7) * 3600 })).sort((a, b) => a.at - b.at);
    for (const m of order) {
      const pack = memberPack(tree, m.no);
      // Period 2's plan confirms every line as delivered (the member ledgers agree).
      const check = checkPack(pack, { root: tree.root, depth: tree.depth }, pack.lines.map((pl, i) => ({ line: i + 2, lineRef: pl.ref, kind: pl.leaf.kind === 1 ? "DEP" : "LOAN", balance: BigInt(pl.leaf.balance), arrearsDays: pl.leaf.arrears_days })));
      checks.set(m.no, check);
      respondFromCheck(period, tree, m.no, m.at, check, actions);
    }
    const watchAt = openAt + plan2.watch_day * DAY + 2 * 3600;
    const { flagged, report } = watchAndClose(period, watchAt);
    const responses = model.responsesOf(period);
    periods.push({
      period,
      asOf,
      asOfIso,
      openAt,
      postAt,
      tree,
      validation,
      cash: stmt.closing,
      cashAt,
      statementHash,
      actions,
      staleChecks,
      staleFlag: model.apexStaleSince() > 0,
      watchAt,
      closeAt: watchAt,
      report,
      overdueFlagged: flagged,
      streak22: model.member(22)?.overdue_streak ?? 0,
      checks,
      concentration: concentrationFlags(
        tree.leaves.map((l, i) => ({ index: i, cp: l.cp, kind: l.kind, booked: l.balance, opened: opened.get(tree.refs[i]!) ?? "", ref: tree.refs[i]! })),
        responses,
        [],
        tree.root.loan,
        asOfIso,
        conc,
      ),
      responses,
      bookOpened: opened,
    });
    log(`period ${period}: apex stale since ${model.apexStaleSince()}; closed with coverage ${report.coverage_bps} bps`);
  }

  return { model, members, keys, config, periods };
}

/** Leaf and proof for index `idx` of a built tree. */
export function itemFor(tree: BuiltTree, idx: number): { leaf: ReturnType<typeof leafFromJson>; proof: ReturnType<typeof nodeFromJson>[] } {
  const leaf = tree.leaves[idx]!;
  const proof: ReturnType<typeof nodeFromJson>[] = [];
  let i = idx;
  for (let k = 0; k < tree.levels.length - 1; k++) {
    proof.push(tree.levels[k]![i ^ 1]!);
    i >>= 1;
  }
  return { leaf, proof };
}

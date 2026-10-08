#!/usr/bin/env node
/**
 * apex: the Apex Confirm command-line tool.
 *
 * Every command runs either --offline (against the offline model in --data-dir, default
 * var/) or live (Soroban RPC from the environment; see .env.example). Exit codes:
 * 0 ok, 1 usage, 2 validation failure, 3 contract error (the error name is printed).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Account, Keypair } from "@stellar/stellar-sdk";
import { type Parsed, UsageError, flagInt, flagStr, parseArgs, parseAudience, parseLines, posInt, posStr } from "./cli-args.js";
import { BookParseError, parseBook } from "./book/parseBook.js";
import { parseLedger } from "./book/parseLedger.js";
import { StatementError, parseStatement } from "./book/parseStatement.js";
import { validateBook } from "./book/validate.js";
import { type MemberPack, type RootJson, type TreeFile, buildTree, counterparties, memberPack, rootJson, treeFile } from "./tree/build.js";
import { leafFromJson } from "./tree/leaf.js";
import { nodeFromJson, nodesEqual } from "./tree/node.js";
import { verifyProof } from "./tree/proof.js";
import { verifyTreeFile } from "./tree/verifyTree.js";
import { checkPack } from "./member/check.js";
import { RegisterModel, deserializeState, emptyState, serializeState } from "./register/model.js";
import { AuthError, ContractError, REASON } from "./register/errors.js";
import { type Invocation, LiveError, LiveRegister, buildTransaction, call, enc } from "./register/client.js";
import type { Period, Report } from "./register/types.js";
import { publicView, memberView, regulatorPeriod, reportText } from "./report/period.js";
import type { concentrationFlags } from "./report/concentration.js";
import { memberPage, publicPage, regulatorPage } from "./pages/pages.js";
import { parseKes, formatKes } from "./util/amounts.js";
import { fromHex, sha256 } from "./util/hash.js";
import { toJson } from "./util/json.js";
import { dateToAsOf, isoTime, parseIso } from "./util/time.js";
import { runJourney } from "./sim/journey.js";
import { seedDir } from "./util/paths.js";

class ValidationFailure extends Error {}

type Out = (s: string) => void;

// ------------------------------------------------------------------ offline workspace

class Workspace {
  model: RegisterModel;
  constructor(public readonly dir: string, at: number | null) {
    const f = join(dir, "state.json");
    this.model = new RegisterModel(existsSync(f) ? deserializeState(readFileSync(f, "utf8")) : emptyState());
    this.model.setTime(at ?? Math.max(this.model.now, Math.floor(Date.now() / 1000)));
  }
  save(): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "state.json"), serializeState(this.model.state));
  }
  periodDir(id: number): string {
    return join(this.dir, `period-${id}`);
  }
  registrar(): string[] {
    return [this.model.config().registrar];
  }
  apex(): string[] {
    return [this.model.config().apex];
  }
  board(no: number): string[] {
    const m = this.model.member(no);
    return m ? [m.board] : [];
  }
}

function addrOf(keyOrAddr: string): string {
  return keyOrAddr.startsWith("S") ? Keypair.fromSecret(keyOrAddr).publicKey() : keyOrAddr;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function liveFromEnv(): LiveRegister {
  const rpcUrl = process.env.STELLAR_RPC_URL;
  const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE;
  const contractId = process.env.APEX_REGISTER_CONTRACT_ID;
  if (!rpcUrl || !networkPassphrase || !contractId) {
    throw new UsageError("live mode needs STELLAR_RPC_URL, STELLAR_NETWORK_PASSPHRASE and APEX_REGISTER_CONTRACT_ID (or pass --offline)");
  }
  return new LiveRegister({ rpcUrl, networkPassphrase, contractId });
}

function secretFromEnv(name: string): Keypair {
  const s = process.env[name];
  if (!s) throw new UsageError(`live mode needs ${name}`);
  return Keypair.fromSecret(s);
}

function boardOfficers(no: number): { address: string; officers: Keypair[] }[] {
  const f = process.env.BOARD_KEYS_FILE;
  if (!f) throw new UsageError("live board commands need BOARD_KEYS_FILE (officer keys; see data/seed/keys.test.json for the format)");
  const k = readJson<{ boards: { no: number; board: string; threshold: number; officers: { secret: string }[] }[] }>(f);
  const b = k.boards.find((x) => x.no === no);
  if (!b) throw new UsageError(`no board keys for member ${no} in ${f}`);
  return [{ address: b.board, officers: b.officers.slice(0, b.threshold).map((o) => Keypair.fromSecret(o.secret)) }];
}

function loadPack(file: string): MemberPack {
  const p = readJson<MemberPack>(file);
  if (p.format !== "apex-confirm/pack-v1") throw new ValidationFailure(`${file} is not a member pack`);
  return p;
}

function evidenceHash(file: string | undefined): Buffer {
  // The evidence file is hashed locally and never uploaded.
  return file ? sha256(readFileSync(file)) : Buffer.alloc(32);
}

// ------------------------------------------------------------------ main

export async function main(argv: string[], out: Out = (s) => console.log(s)): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (e) {
    out((e as Error).message);
    return 1;
  }
  try {
    await run(p, out);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      out(e.message);
      return 1;
    }
    if (e instanceof ValidationFailure || e instanceof BookParseError || e instanceof StatementError) {
      out(`validation failed: ${e.message}`);
      return 2;
    }
    if (e instanceof ContractError) {
      out(`contract error: ${e.errorName} (#${e.code})`);
      return 3;
    }
    if (e instanceof AuthError) {
      out(`contract error: authorisation missing for ${e.address}`);
      return 3;
    }
    if (e instanceof LiveError) {
      out(`contract error: ${e.contractError ?? "unknown"}: ${e.message}`);
      return 3;
    }
    throw e;
  }
}

async function run(p: Parsed, out: Out): Promise<void> {
  if (p.command === "simulate") return simulate(p, out);
  const offline = p.flags["offline"] === true;
  const dataDir = resolve(typeof p.flags["data-dir"] === "string" ? p.flags["data-dir"] : process.env.APEX_DATA_DIR ?? "var");
  const at = typeof p.flags["at"] === "string" ? parseIso(p.flags["at"]) : null;
  const dryRun = p.flags["dry-run"] === true;
  if (offline) return runOffline(p, new Workspace(dataDir, at), out);
  return runLive(p, dataDir, dryRun, out);
}

// ------------------------------------------------------------------ offline

function runOffline(p: Parsed, ws: Workspace, out: Out): void {
  const m = ws.model;
  switch (p.command) {
    case "init": {
      const registrar = addrOf(flagStr(p, "registrar")!);
      const apex = addrOf(flagStr(p, "apex")!);
      const cfgFile = flagStr(p, "config", false);
      const c = cfgFile ? readJson<Record<string, number | string>>(cfgFile) : {};
      m.init([registrar], {
        registrar,
        apex,
        currency: String(c.currency ?? "KES"),
        decimals: Number(c.decimals ?? 2),
        confirm_window_secs: Number(c.confirm_window_secs ?? 864_000),
        attest_window_secs: Number(c.attest_window_secs ?? 432_000),
        max_period_gap_secs: Number(c.max_period_gap_secs ?? 3_888_000),
        performing_max_days: Number(c.performing_max_days ?? 90),
        alert_bps: Number(c.alert_bps ?? 10_000),
      });
      out(`initialised: registrar ${registrar}, apex ${apex}`);
      break;
    }
    case "member": {
      const no = posInt(p, 0, "member number");
      if (p.sub === "add") {
        const board = posStr(p, 1, "board address");
        const licence = posStr(p, 2, "licence number");
        const salt = process.env.REGISTRAR_SALT ? fromHex(process.env.REGISTRAR_SALT) : Buffer.alloc(0);
        m.registerMember(ws.registrar(), no, board, sha256(licence, salt).toString("hex"));
        out(`member ${no} registered with board ${board}`);
      } else if (p.sub === "deactivate" || p.sub === "activate") {
        m.setMemberActive(ws.registrar(), no, p.sub === "activate");
        out(`member ${no} ${p.sub}d`);
      } else {
        m.rotateBoard(ws.registrar(), no, posStr(p, 1, "new board address"));
        out(`member ${no} board rotated`);
      }
      break;
    }
    case "custodian": {
      const c = addrOf(posStr(p, 0, "custodian address"));
      const active = p.flags["inactive"] !== true;
      m.setCustodian(ws.registrar(), c, active);
      out(`custodian ${c} ${active ? "active" : "inactive"}`);
      break;
    }
    case "open": {
      const asOf = dateToAsOf(flagStr(p, "as-of")!);
      const id = m.openPeriod(ws.apex(), asOf, flagInt(p, "supersedes", false) ?? 0);
      out(`opened period ${id} for balance date ${flagStr(p, "as-of")}`);
      break;
    }
    case "build": {
      const id = flagInt(p, "period")!;
      const bookFile = flagStr(p, "book")!;
      const saltHex = flagStr(p, "salt-key", false) ?? process.env.APEX_SALT_KEY;
      if (!saltHex) throw new UsageError("build needs APEX_SALT_KEY (hex) or --salt-key");
      const lines = parseBook(readFileSync(bookFile, "utf8"));
      const members = Object.values(m.state.members).map((x) => ({ no: x.no, active: x.active }));
      const v = validateBook(lines, members);
      for (const i of v.issues) out(`${i.level.padEnd(7)} line ${i.line}: ${i.code} ${i.message}`);
      if (!v.ok) throw new ValidationFailure(`${v.issues.filter((i) => i.level === "error").length} error(s) in ${bookFile}`);
      const tree = buildTree(id, lines, fromHex(saltHex, 32));
      const dir = ws.periodDir(id);
      mkdirSync(join(dir, "packs"), { recursive: true });
      writeFileSync(join(dir, "tree.json"), toJson(treeFile(tree)) + "\n");
      writeFileSync(join(dir, "root.json"), toJson(rootJson(tree)) + "\n");
      for (const no of counterparties(tree)) writeFileSync(join(dir, "packs", `${no}.json`), toJson(memberPack(tree, no)) + "\n");
      out(`built period ${id}: ${tree.leafCount} lines, depth ${tree.depth}, root ${tree.root.hash.toString("hex").slice(0, 16)}...`);
      out(`  booked deposits KES ${formatKes(tree.root.dep)}, booked loans KES ${formatKes(tree.root.loan)}`);
      out(`  wrote ${dir}/tree.json (private), root.json, packs/ (${counterparties(tree).length} counterparties)`);
      break;
    }
    case "post": {
      const id = flagInt(p, "period")!;
      const r = readJson<RootJson>(join(ws.periodDir(id), "root.json"));
      m.postRoot(ws.apex(), id, nodeFromJson(r), r.leaf_count, r.file_hash);
      const per = m.period(id)!;
      out(`posted root for period ${id}; confirm by ${isoTime(per.confirm_by)}, attest by ${isoTime(per.attest_by)}`);
      break;
    }
    case "check": {
      const no = flagInt(p, "member")!;
      const pack = loadPack(flagStr(p, "pack")!);
      const per = m.period(pack.period);
      if (!per || per.state === "Open") throw new ValidationFailure(`period ${pack.period} has no posted root`);
      const ledger = parseLedger(readFileSync(flagStr(p, "ledger")!, "utf8"));
      if (pack.member_no !== no) throw new ValidationFailure(`pack is for member ${pack.member_no}, not ${no}`);
      printCheck(checkPack(pack, { root: { hash: Buffer.from(per.root.hash, "hex"), dep: per.root.dep, loan: per.root.loan }, depth: per.depth }, ledger), out);
      break;
    }
    case "confirm": {
      const no = flagInt(p, "member")!;
      const pack = loadPack(flagStr(p, "pack")!);
      const sel = parseLines(flagStr(p, "lines", false));
      const items = pack.lines.filter((l) => sel === "all" || sel.includes(l.leaf.index)).map((l) => ({ leaf: leafFromJson(l.leaf), proof: l.proof.map(nodeFromJson) }));
      if (!items.length) throw new ValidationFailure("no matching lines in the pack");
      for (let i = 0; i < items.length; i += 16) m.confirmBatch(ws.board(no), pack.period, no, items.slice(i, i + 16));
      out(`member ${no} confirmed ${items.length} line(s) in period ${pack.period}`);
      break;
    }
    case "dispute": {
      const no = flagInt(p, "member")!;
      const pack = loadPack(flagStr(p, "pack")!);
      const idx = flagInt(p, "line")!;
      const line = pack.lines.find((l) => l.leaf.index === idx);
      if (!line) throw new ValidationFailure(`line ${idx} is not in the pack`);
      const reasonName = flagStr(p, "reason")!;
      const reason = REASON[reasonName as keyof typeof REASON];
      if (reason === undefined) throw new UsageError(`unknown reason ${reasonName}`);
      const claimed = parseKes(flagStr(p, "claimed")!);
      const arr = flagInt(p, "claimed-arrears", false) ?? line.leaf.arrears_days;
      m.dispute(ws.board(no), pack.period, no, leafFromJson(line.leaf), line.proof.map(nodeFromJson), claimed, arr, reason, evidenceHash(flagStr(p, "evidence", false)).toString("hex"));
      out(`member ${no} disputed line ${idx}: booked ${formatKes(BigInt(line.leaf.balance))}, ours ${formatKes(claimed)} (${reasonName})`);
      break;
    }
    case "omitted": {
      const no = flagInt(p, "member")!;
      const period = flagInt(p, "period", false) ?? m.state.currentPeriod;
      const claimed = parseKes(flagStr(p, "claimed")!);
      m.claimOmitted(ws.board(no), period, no, claimed, evidenceHash(flagStr(p, "evidence", false)).toString("hex"));
      out(`member ${no} claimed an omitted deposit of KES ${formatKes(claimed)} in period ${period}`);
      break;
    }
    case "attest": {
      const custodian = addrOf(flagStr(p, "custodian")!);
      const id = flagInt(p, "period")!;
      const text = readFileSync(flagStr(p, "statement")!, "utf8");
      const s = parseStatement(text);
      if (!s.reconciles) throw new ValidationFailure(`statement does not reconcile: opening + movements = ${formatKes(s.computedClosing)}, closing row says ${formatKes(s.closing)}`);
      m.attestCash([custodian], id, custodian, s.closing, dateToAsOf(s.closingDate), sha256(text).toString("hex"));
      out(`custodian attested KES ${formatKes(s.closing)} as of ${s.closingDate} for period ${id} (${s.movements.length} movements, ${s.reversals} reversals)`);
      break;
    }
    case "close": {
      const r = m.closePeriod(flagInt(p, "period")!);
      for (const l of reportText(r)) out(l);
      break;
    }
    case "watch": {
      const id = m.state.currentPeriod;
      const per = id ? m.period(id) : null;
      let flagged = 0;
      for (const cand of [id - 1, id]) {
        const pc = cand > 0 ? m.period(cand) : null;
        if (pc && pc.state !== "Open" && m.now > pc.confirm_by) {
          let rounds = 0;
          while ((m.state.overdueCursor[cand] ?? 1) <= m.state.maxMemberNo && rounds++ < 50) flagged += m.markOverdue(cand, 25);
        }
      }
      const stale = m.flagStaleApex();
      out(`watch: ${flagged} member(s) newly flagged overdue; apex stale: ${stale ? `yes, since ${isoTime(m.apexStaleSince())}` : "no"}${per ? ` (current period ${id}: ${per.state})` : ""}`);
      break;
    }
    case "verify-tree": {
      const id = flagInt(p, "period")!;
      const file = readJson<TreeFile>(flagStr(p, "tree")!);
      const per = m.period(id);
      const onChain: RootJson | null = per && per.state !== "Open" ? { period: id, hash: per.root.hash, dep: per.root.dep.toString(), loan: per.root.loan.toString(), leaf_count: per.leaf_count, depth: per.depth, file_hash: per.file_hash } : null;
      const v = verifyTreeFile(file, onChain);
      if (v.ok) out(`verify-tree: OK (${file.leaf_count} lines recompute to the ${onChain ? "on-chain" : "file's own"} root)`);
      else {
        for (const i of v.issues) out(`  ${i.code}${i.index !== null ? ` [${i.index}]` : ""}: ${i.message}`);
        throw new ValidationFailure(`${v.issues.length} issue(s) in the tree file`);
      }
      break;
    }
    case "report": {
      const id = flagInt(p, "period")!;
      const aud = parseAudience(flagStr(p, "as", false));
      const json = p.flags["json"] === true;
      const r = m.report(id);
      if (aud.kind === "public") {
        const v = publicView(m).periods.find((x) => x.period === id);
        if (!v) throw new ContractError("BadState");
        if (json) out(toJson(v));
        else if (r) for (const l of reportText(r)) out(l);
        else out(`period ${id}: ${v.state}; no report until close`);
      } else if (aud.kind === "member") {
        const pf = join(ws.periodDir(id), "packs", `${aud.no}.json`);
        const packs = existsSync(pf) ? [packProof(loadPack(pf), m.period(id))] : [];
        const v = memberView(m, aud.no, `member ${aud.no}`, packs);
        out(json ? toJson(v) : v.periods.flatMap((pp) => pp.lines.map((l) => `  [${l.index}] ${l.ref} ${l.kind} ${l.booked} proof=${l.proof_ok ? "ok" : "FAILED"} ${l.response ? l.response.verdict : "no response"}`)).join("\n") || "no lines");
      } else {
        const tf = join(ws.periodDir(id), "tree.json");
        if (!existsSync(tf)) throw new ValidationFailure(`regulator report needs ${tf}`);
        const v = regulatorPeriod(m, id, readJson<TreeFile>(tf), [], null);
        out(json ? toJson(v) : [...(r ? reportText(r) : []), `unresponded lines: ${v.unresponded.map((u) => `${u.index}:${u.ref}`).join(", ")}`].join("\n"));
      }
      break;
    }
    case "pages": {
      const dir = resolve(flagStr(p, "out")!);
      writePages(m, dir, "SIM APEX UNION (simulated)", (id) => {
        const tf = join(ws.periodDir(id), "tree.json");
        return existsSync(tf) ? readJson<TreeFile>(tf) : null;
      }, (id, no) => {
        const pf = join(ws.periodDir(id), "packs", `${no}.json`);
        return existsSync(pf) ? loadPack(pf) : null;
      }, new Map(), null);
      out(`pages written to ${dir}`);
      break;
    }
    default:
      throw new UsageError(`unknown command ${p.command}`);
  }
  ws.save();
}

function packProof(pack: MemberPack, per: Period | null): { pack: MemberPack; proofOk: Map<number, boolean> } {
  const ok = new Map<number, boolean>();
  for (const l of pack.lines) {
    const res = per && per.state !== "Open" ? verifyProof(leafFromJson(l.leaf), l.proof.map(nodeFromJson), { hash: Buffer.from(per.root.hash, "hex"), dep: per.root.dep, loan: per.root.loan }, per.depth) : { ok: false };
    ok.set(l.leaf.index, res.ok);
  }
  return { pack, proofOk: ok };
}

function printCheck(c: ReturnType<typeof checkPack>, out: Out): void {
  out(`member ${c.member}, period ${c.period}: ${c.lines.length} line(s); proofs ${c.proofsOk ? "all verify against the on-chain root" : "DO NOT all verify"}`);
  for (const l of c.lines) {
    out(`  [${l.index}] ${l.ref} ${l.kind === 1 ? "DEP " : "LOAN"} booked ${formatKes(l.booked)} arrears ${l.arrearsDays} proof=${l.proof.ok ? "ok" : l.proof.reason} ours=${l.ledger ? formatKes(l.ledger.balance) : "none"}`);
  }
  out("proposals (the board decides; nothing has been signed):");
  for (const pr of c.proposals) {
    if (pr.action === "confirm") out(`  confirm      [${pr.index}] ${pr.ref}`);
    else if (pr.action === "dispute") out(`  dispute      [${pr.index}] ${pr.ref} claimed ${formatKes(pr.claimed)} arrears ${pr.claimedArrears} reason ${pr.reason}: ${pr.note}`);
    else if (pr.action === "claim-omitted") out(`  claim-omitted KES ${formatKes(pr.claimed)} (${pr.refs.join(", ") || "we hold nothing with the apex"})`);
    else if (pr.action === "do-not-respond") out(`  do-not-respond [${pr.index}] ${pr.ref}: ${pr.note}`);
    else out(`  note         ${pr.ref}: ${pr.note}`);
  }
}

// ------------------------------------------------------------------ pages

export function writePages(
  m: RegisterModel,
  dir: string,
  apexName: string,
  treeOf: (id: number) => TreeFile | null,
  packOf: (id: number, no: number) => MemberPack | null,
  concentration: Map<number, ReturnType<typeof concentrationFlags>>,
  names: Map<number, string> | null,
): void {
  const pub = publicView(m);
  mkdirSync(join(dir, "public"), { recursive: true });
  writeFileSync(join(dir, "public", "index.html"), publicPage(pub, apexName));
  writeFileSync(join(dir, "public", "data.json"), toJson(pub) + "\n");
  for (const mem of Object.values(m.state.members)) {
    const packs: { pack: MemberPack; proofOk: Map<number, boolean> }[] = [];
    for (let id = 1; id <= m.state.currentPeriod; id++) {
      const pk = packOf(id, mem.no);
      if (pk) packs.push(packProof(pk, m.period(id)));
    }
    const d = join(dir, "member", String(mem.no));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "index.html"), memberPage(memberView(m, mem.no, names?.get(mem.no) ?? `member ${mem.no}`, packs), pub));
  }
  const regs = [];
  for (let id = 1; id <= m.state.currentPeriod; id++) {
    const tf = treeOf(id);
    const per = m.period(id)!;
    if (!tf) continue;
    const onChain = per.state !== "Open" ? { period: id, hash: per.root.hash, dep: per.root.dep.toString(), loan: per.root.loan.toString(), leaf_count: per.leaf_count, depth: per.depth, file_hash: per.file_hash } : null;
    regs.push(regulatorPeriod(m, id, tf, concentration.get(id) ?? [], verifyTreeFile(tf, onChain)));
  }
  mkdirSync(join(dir, "regulator"), { recursive: true });
  writeFileSync(join(dir, "regulator", "index.html"), regulatorPage(regs, apexName, m.now));
}

// ------------------------------------------------------------------ live

async function runLive(p: Parsed, dataDir: string, dryRun: boolean, out: Out): Promise<void> {
  const contractId = process.env.APEX_REGISTER_CONTRACT_ID ?? "";
  const pass = process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
  // Build the invocation first (pure), so --dry-run works with no network at all.
  let inv;
  let signer = "";
  let explicitKey: Keypair | null = null;
  const more: Invocation[] = [];
  let board: number | null = null;
  switch (p.command) {
    case "init": {
      const c = flagStr(p, "config", false) ? readJson<Record<string, number | string>>(flagStr(p, "config")!) : {};
      inv = call.init(contractId, {
        registrar: addrOf(flagStr(p, "registrar")!),
        apex: addrOf(flagStr(p, "apex")!),
        currency: String(c.currency ?? "KES"),
        decimals: Number(c.decimals ?? 2),
        confirm: Number(process.env.CONFIRM_WINDOW_SECS ?? c.confirm_window_secs ?? 864_000),
        attest: Number(process.env.ATTEST_WINDOW_SECS ?? c.attest_window_secs ?? 432_000),
        gap: Number(c.max_period_gap_secs ?? 3_888_000),
        performing: Number(c.performing_max_days ?? 90),
        alertBps: Number(c.alert_bps ?? 10_000),
      });
      signer = "REGISTRAR_SECRET";
      break;
    }
    case "member": {
      const no = posInt(p, 0, "member number");
      const salt = process.env.REGISTRAR_SALT ? fromHex(process.env.REGISTRAR_SALT) : Buffer.alloc(0);
      if (p.sub === "add") inv = call.registerMember(contractId, no, posStr(p, 1, "board address"), sha256(posStr(p, 2, "licence number"), salt));
      else if (p.sub === "rotate") inv = call.rotateBoard(contractId, no, posStr(p, 1, "new board address"));
      else inv = call.setMemberActive(contractId, no, p.sub === "activate");
      signer = "REGISTRAR_SECRET";
      break;
    }
    case "custodian":
      inv = call.setCustodian(contractId, addrOf(posStr(p, 0, "custodian address")), p.flags["inactive"] !== true);
      signer = "REGISTRAR_SECRET";
      break;
    case "open":
      inv = call.openPeriod(contractId, dateToAsOf(flagStr(p, "as-of")!), flagInt(p, "supersedes", false) ?? 0);
      signer = "APEX_SECRET";
      break;
    case "post": {
      const id = flagInt(p, "period")!;
      const r = readJson<RootJson>(join(dataDir, `period-${id}`, "root.json"));
      inv = call.postRoot(contractId, id, nodeFromJson(r), r.leaf_count, fromHex(r.file_hash, 32));
      signer = "APEX_SECRET";
      break;
    }
    case "confirm": {
      const no = flagInt(p, "member")!;
      const pack = loadPack(flagStr(p, "pack")!);
      const sel = parseLines(flagStr(p, "lines", false));
      const items = pack.lines.filter((l) => sel === "all" || sel.includes(l.leaf.index)).map((l) => ({ leaf: leafFromJson(l.leaf), proof: l.proof.map(nodeFromJson) }));
      if (!items.length) throw new ValidationFailure("no matching lines in the pack");
      // confirm_batch takes at most 16 lines; larger selections go out as several transactions.
      inv = call.confirmBatch(contractId, pack.period, no, items.slice(0, 16));
      for (let i = 16; i < items.length; i += 16) more.push(call.confirmBatch(contractId, pack.period, no, items.slice(i, i + 16)));
      signer = "SOURCE_SECRET";
      board = no;
      break;
    }
    case "dispute": {
      const no = flagInt(p, "member")!;
      const pack = loadPack(flagStr(p, "pack")!);
      const line = pack.lines.find((l) => l.leaf.index === flagInt(p, "line"));
      if (!line) throw new ValidationFailure("line not in pack");
      const reason = REASON[flagStr(p, "reason")! as keyof typeof REASON];
      if (reason === undefined) throw new UsageError("unknown reason");
      inv = call.dispute(contractId, pack.period, no, leafFromJson(line.leaf), line.proof.map(nodeFromJson), parseKes(flagStr(p, "claimed")!), flagInt(p, "claimed-arrears", false) ?? line.leaf.arrears_days, reason, evidenceHash(flagStr(p, "evidence", false)));
      signer = "SOURCE_SECRET";
      board = no;
      break;
    }
    case "omitted": {
      const no = flagInt(p, "member")!;
      inv = call.claimOmitted(contractId, flagInt(p, "period")!, no, parseKes(flagStr(p, "claimed")!), evidenceHash(flagStr(p, "evidence", false)));
      signer = "SOURCE_SECRET";
      board = no;
      break;
    }
    case "attest": {
      const text = readFileSync(flagStr(p, "statement")!, "utf8");
      const s = parseStatement(text);
      if (!s.reconciles) throw new ValidationFailure("statement does not reconcile");
      const key = flagStr(p, "custodian")!;
      inv = call.attestCash(contractId, flagInt(p, "period")!, addrOf(key), s.closing, dateToAsOf(s.closingDate), sha256(text));
      signer = "CUSTODIAN_SECRET";
      if (key.startsWith("S")) explicitKey = Keypair.fromSecret(key);
      break;
    }
    case "close":
      inv = call.closePeriod(contractId, flagInt(p, "period")!);
      signer = "SOURCE_SECRET";
      break;
    case "watch":
      inv = call.flagStaleApex(contractId);
      signer = "SOURCE_SECRET";
      break;
    case "report": {
      const live = liveFromEnv();
      const r = (await live.view("report", [enc.u32(flagInt(p, "period")!)])) as Report | null;
      out(r ? toJson(r) : "no report (period not closed)");
      return;
    }
    default:
      throw new UsageError(`${p.command} works offline only (pass --offline); see README`);
  }
  if (dryRun) {
    for (const i of [inv, ...more]) {
      const tx = buildTransaction(new Account(Keypair.random().publicKey(), "0"), i, pass);
      out(`dry run: ${i.method}(${i.args.length} args) on ${contractId || "<APEX_REGISTER_CONTRACT_ID>"}`);
      out(tx.toXDR());
    }
    return;
  }
  const live = liveFromEnv();
  const source = explicitKey ?? secretFromEnv(signer);
  for (const i of [inv, ...more]) {
    const res = await live.submit(i, source, board !== null ? boardOfficers(board) : []);
    out(`submitted ${i.method}: ${res.hash}`);
    if (res.returnValue !== null && res.returnValue !== undefined) out(toJson(res.returnValue));
  }
  if (p.command === "watch") {
    // Page mark_overdue through the current and previous period once their window has passed.
    // Pages assume member numbers are dense (1..N), as the registrar assigns them.
    const current = Number(await live.view("current_period"));
    const pages = Math.ceil(Number(await live.view("member_count")) / 25) + 1;
    for (const id of [current - 1, current].filter((x) => x > 0)) {
      for (let page = 0; page < pages; page++) {
        try {
          const r = await live.submit(call.markOverdue(contractId, id, 25), source);
          out(`mark_overdue(${id}): ${toJson(r.returnValue)} newly flagged`);
        } catch (e) {
          if (e instanceof LiveError) {
            out(`mark_overdue(${id}): ${e.contractError ?? e.message}`);
            break;
          }
          throw e;
        }
      }
    }
  }
}

// ------------------------------------------------------------------ simulate

async function simulate(p: Parsed, out: Out): Promise<void> {
  const quiet = p.flags["quiet"] === true;
  const dir = typeof p.flags["seed-dir"] === "string" ? resolve(p.flags["seed-dir"]) : seedDir();
  const res = runJourney({ seedDir: dir, log: quiet ? undefined : (s) => out(s) });
  const outDir = typeof p.flags["out"] === "string" ? resolve(p.flags["out"]) : null;
  if (p.flags["json"] === true) {
    out(toJson({ periods: res.periods.map((x) => ({ period: x.period, report: x.report, stale: x.staleFlag, overdue_flagged: x.overdueFlagged, streak_22: x.streak22, concentration: x.concentration })) }));
  } else if (!quiet) {
    for (const per of res.periods) {
      out("");
      for (const l of reportText(per.report)) out(l);
      out(`  overdue flagged: ${per.overdueFlagged.join(", ") || "none"}; member 22 streak ${per.streak22}; apex stale: ${per.staleFlag ? "yes" : "no"}`);
      for (const c of per.concentration) out(`  concentration (pattern for supervisory follow-up, not evidence): member ${c.member} rules ${c.rules.join(",")}`);
    }
    const p1 = res.periods[0]!;
    const ci = p1.tree.refs.findIndex((r) => r === "APX/LN/2026/0101");
    const cr = p1.responses.find((r) => r.index === ci);
    out("");
    out(`known limitation: the colluding member's loan [${ci}] was ${cr?.verdict === 1 ? "CONFIRMED and counted as recognised" : "not confirmed"}; confirmation cannot catch collusion.`);
  }
  if (outDir) {
    for (const per of res.periods) {
      const d = join(outDir, `period-${per.period}`);
      mkdirSync(join(d, "packs"), { recursive: true });
      writeFileSync(join(d, "tree.json"), toJson(treeFile(per.tree)) + "\n");
      writeFileSync(join(d, "root.json"), toJson(rootJson(per.tree)) + "\n");
      for (const no of counterparties(per.tree)) writeFileSync(join(d, "packs", `${no}.json`), toJson(memberPack(per.tree, no)) + "\n");
    }
    writeFileSync(join(outDir, "state.json"), serializeState(res.model.state));
    const web = typeof p.flags["web"] === "string" ? resolve(p.flags["web"]) : join(outDir, "web");
    writePages(
      res.model,
      web,
      res.config.apex_name,
      (id) => (res.periods[id - 1] ? treeFile(res.periods[id - 1]!.tree) : null),
      (id, no) => (res.periods[id - 1] ? memberPack(res.periods[id - 1]!.tree, no) : null),
      new Map(res.periods.map((x) => [x.period, x.concentration])),
      new Map(res.members.map((mm) => [mm.no, mm.name])),
    );
    if (!quiet) out(`wrote trees, packs and state.json to ${outDir}; pages to ${web}`);
  }
  // Consistency guard: the root the model holds equals the built tree's root.
  for (const per of res.periods) {
    const onChain = res.model.period(per.period)!;
    if (!nodesEqual(per.tree.root, { hash: Buffer.from(onChain.root.hash, "hex"), dep: onChain.root.dep, loan: onChain.root.loan })) throw new ValidationFailure("root mismatch");
  }
}

// Run when executed directly.
const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry.endsWith(join("dist", "src", "cli.js")) || entry.endsWith("/apex")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.stack : e);
      process.exit(4);
    },
  );
}

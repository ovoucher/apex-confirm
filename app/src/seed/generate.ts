/**
 * Deterministic seed generator (fixed seed). Writes every file under data/seed/ and the
 * shared vectors under contracts/vectors/ (except coverage.json, which the Rust property
 * test exports). All entities are fictitious and marked "(simulated)".
 *
 * Targets (asserted here and in expected.json):
 *   booked deposits  2,480,000,000.00   booked loans 2,236,900,000.00
 *   liabilities      2,510,500,000.00   recognised   1,654,600,000.00
 *   cash               305,412,318.55
 *   coverage_bps 7807 vs booked_coverage_bps 10251
 *
 * Run: npm run seed   (from app/)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatKes } from "../util/amounts.js";
import { csvCell } from "../util/csv.js";
import { hex, sha256 } from "../util/hash.js";
import { toJson } from "../util/json.js";
import { seedDir, vectorsDir } from "../util/paths.js";
import { Rng } from "../util/rng.js";
import { boardContractAddress, testKeypair } from "../util/keys.js";
import { KIND_DEPOSIT, KIND_LOAN, type Leaf, emptyNode, leafHash, leafNode, leafToJson } from "../tree/leaf.js";
import { buildLevels } from "../tree/build.js";
import { nodeToJson } from "../tree/node.js";
import { proofFor } from "../tree/proof.js";
import { runJourney } from "../sim/journey.js";
import { FLAGS } from "../report/flags.js";

const KES = 100n;
const M = 1_000_000n * KES;
const rng = new Rng(0x5acc0a9e2026n);

// ------------------------------------------------------------------ members

const NAME_A = [
  "Kilele", "Mwangaza", "Upeo", "Tumaini", "Bidii", "Neema", "Jua", "Mvua", "Shamba", "Mlima",
  "Ziwa", "Pwani", "Nuru", "Tawi", "Mbegu", "Kisima", "Daraja", "Njia", "Ufanisi", "Mapato",
];
const NAME_B = ["Wakulima", "Walimu", "Wafanyikazi", "Jamii", "Vijana", "Mashinani", "Bora", "Pamoja"];

interface MemberSeed {
  no: number;
  name: string;
  licence: string;
  active: boolean;
  note: string;
}

const members: MemberSeed[] = [];
for (let no = 1; no <= 40; no++) {
  const a = NAME_A[(no * 7) % NAME_A.length]!;
  const b = NAME_B[(no * 3) % NAME_B.length]!;
  let name = `${a} ${b} Sacco Ltd (simulated)`;
  if (no === 3) name = "Mwangaza Sacco Ltd (simulated)";
  if (no === 38) name = "Tawi Mashinani Sacco Society Ltd (simulated)";
  if (no === 37) name = "Ufanisi Pamoja Sacco Ltd (simulated)";
  members.push({
    no,
    name,
    licence: `SIM/DT/${String(100 + no * 3).padStart(4, "0")}`,
    active: no !== 38,
    note: no === 38 ? "dormant: registered, deactivated by the registrar" : no === 37 ? "" : "",
  });
}
/** Name variants as the apex's clerks typed them (the name-matching note in docs/ warns about this). */
function bookName(m: MemberSeed, variant: number): string {
  const base = m.name.replace(" (simulated)", "");
  switch (variant % 5) {
    case 0:
      return base;
    case 1:
      return base.toUpperCase().replace("SACCO LTD", "SACCO SOCIETY");
    case 2:
      return base.replace("Sacco Ltd", "SACCO").replace(/a/, "aa");
    case 3:
      return `${base}.`;
    default:
      return base.replace(" Ltd", "");
  }
}

// ------------------------------------------------------------------ book lines

interface SeedLine {
  ref: string;
  cp: number;
  cpName: string;
  kind: "DEP" | "LOAN";
  balance: bigint;
  arrears: number;
  product: string;
  opened: string;
  notes: string;
  planted?: string;
}

function roundTo(v: bigint, unit: bigint): bigint {
  return (v / unit) * unit;
}

// Deposits: every member except 33 (omitted by the apex).
const TOTAL_DEP = 2_480_000_000n * KES;
const TOTAL_LOAN = 2_236_900_000n * KES;
const fixedDep: Record<number, bigint> = { 37: 14_000_000n * KES, 38: 3_200_000n * KES };
const depMembers = members.filter((m) => m.no !== 33).map((m) => m.no);
const weights = new Map<number, number>();
for (const no of depMembers) if (!(no in fixedDep)) weights.set(no, rng.int(20, 120));
const wsum = [...weights.values()].reduce((a, b) => a + b, 0);
const freeDep = TOTAL_DEP - Object.values(fixedDep).reduce((a, b) => a + b, 0n);
const deposits = new Map<number, bigint>();
for (const [no, w] of weights) {
  let v = roundTo((freeDep * BigInt(w)) / BigInt(wsum), 1000n * KES);
  if (rng.chance(30)) v += BigInt(rng.int(1, 99));
  deposits.set(no, v);
}
for (const [no, v] of Object.entries(fixedDep)) deposits.set(Number(no), v);
// Adjust the last generated deposit so the total is exact.
const lastDepNo = [...weights.keys()].pop()!;
const depSum = [...deposits.values()].reduce((a, b) => a + b, 0n);
deposits.set(lastDepNo, deposits.get(lastDepNo)! + (TOTAL_DEP - depSum));

const lines: SeedLine[] = [];
for (const no of depMembers) {
  const m = members[no - 1]!;
  lines.push({
    ref: `APX/DEP/${String(no).padStart(4, "0")}-1`,
    cp: no,
    cpName: bookName(m, no),
    kind: "DEP",
    balance: deposits.get(no)!,
    arrears: 0,
    product: rng.chance(60) ? "Term placement" : "Call placement",
    opened: `20${rng.int(18, 24)}-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}`,
    notes: "",
  });
}

// Planted fictitious and insider loans.
const planted: SeedLine[] = [
  { ref: "APX/LN/2024/0031", cp: 901, cpName: "APEX HOUSING DEPT (simulated)", kind: "LOAN", balance: 100n * M, arrears: 0, product: "Housing on-lending", opened: "2024-03-15", notes: "interdept", planted: "L-F1" },
  { ref: "APX/LN/2023/0212", cp: 902, cpName: "Mto Mdogo Sacco (collapsed) (simulated)", kind: "LOAN", balance: 80n * M, arrears: 0, product: "Liquidity loan", opened: "2023-11-02", notes: "", planted: "L-F2" },
  { ref: "APX/LN/2025/0077", cp: 903, cpName: "Kona Sacco Society (dormant) (simulated)", kind: "LOAN", balance: 60n * M, arrears: 0, product: "Development loan", opened: "2025-06-30", notes: "", planted: "L-F3" },
  { ref: "APX/LN/2025/0019", cp: 38, cpName: "TAWI MASHINANI SACCO SOC", kind: "LOAN", balance: 70n * M, arrears: 0, product: "Development loan", opened: "2025-02-11", notes: "", planted: "L-F4" },
  { ref: "APX/LN/2025/0140", cp: 38, cpName: "Tawi Mashinani Sacco", kind: "LOAN", balance: 60n * M, arrears: 0, product: "Bridging loan", opened: "2025-12-01", notes: "top-up", planted: "L-F5" },
  { ref: "APX/LN/2024/0158", cp: 5, cpName: bookName(members[4]!, 1), kind: "LOAN", balance: 90n * M, arrears: 0, product: "Development loan", opened: "2024-08-19", notes: "", planted: "L-F6" },
  { ref: "APX/LN/2025/0044", cp: 19, cpName: bookName(members[18]!, 2), kind: "LOAN", balance: 60n * M, arrears: 0, product: "Asset finance", opened: "2025-04-07", notes: "", planted: "L-F7" },
  { ref: "APX/LN/2026/0101", cp: 37, cpName: bookName(members[36]!, 0), kind: "LOAN", balance: 48n * M, arrears: 0, product: "Liquidity loan", opened: "2026-08-14", notes: "board approval ref pending", planted: "L-F8" },
];
const MEMBER5_SAYS = 25n * M;
const MEMBER19_SAYS = 15n * M;

// Member 22: three loans, never responded to.
const m22: SeedLine[] = [
  [25_000_000n, 12, "2022-05-10"],
  [19_800_000n, 0, "2023-09-21"],
  [12_500_000n, 30, "2025-01-15"],
].map(([amt, arr, opened], i) => ({
  ref: `APX/LN/${String(opened).slice(0, 4)}/${String(500 + i).padStart(4, "0")}`,
  cp: 22,
  cpName: bookName(members[21]!, i),
  kind: "LOAN" as const,
  balance: (amt as bigint) * KES,
  arrears: arr as number,
  product: "Development loan",
  opened: opened as string,
  notes: "",
}));

// 109 honest loans: three each for the 36 members outside {22, 33, 37, 38}, four for member 12.
const PRODUCTS = ["Development loan", "Liquidity loan", "Asset finance", "Bridging loan", "Housing on-lending"];
const pool = members.map((m) => m.no).filter((n) => ![22, 33, 37, 38].includes(n));
const honest: SeedLine[] = [];
let seq = 1;
for (const no of pool) {
  const budgetUnits = deposits.get(no)! / 1000n;
  // member 12 has a fourth loan, so honest loans number 109 (+3 for member 22, +8 planted = 120)
  for (let j = 0; j < (no === 12 ? 4 : 3); j++) {
    const share = BigInt(rng.int(15, 40));
    const year = rng.int(2021, 2026);
    const month = year === 2026 ? rng.int(1, 7) : rng.int(1, 12);
    let arrears = 0;
    const r = rng.int(1, 100);
    if (r > 80 && r <= 95) arrears = rng.int(1, 30);
    else if (r > 95) arrears = rng.int(31, 75);
    honest.push({
      ref: `APX/LN/${year}/${String(600 + seq++).padStart(4, "0")}`,
      cp: no,
      cpName: bookName(members[no - 1]!, j + no),
      kind: "LOAN",
      balance: budgetUnits * share, // provisional; scaled below
      arrears,
      product: rng.pick(PRODUCTS),
      opened: `${year}-${String(month).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}`,
      notes: rng.chance(8) ? "restructured" : "",
    });
  }
}
// Member 8's first loan: 45,000,000.00, 120 days in arrears (confirmed, non-performing).
const m8 = honest.find((l) => l.cp === 8)!;
m8.balance = 45n * M;
m8.arrears = 120;
m8.notes = "in arrears";
m8.opened = "2023-02-14";
// Scale the rest so booked loans hit the target exactly; the last generated loan absorbs rounding.
const plantedSum = planted.reduce((a, l) => a + l.balance, 0n);
const m22Sum = m22.reduce((a, l) => a + l.balance, 0n);
const free = honest.filter((l) => l !== m8);
const need = TOTAL_LOAN - plantedSum - m22Sum - m8.balance;
const provisional = free.reduce((a, l) => a + l.balance, 0n);
for (const l of free) {
  l.balance = roundTo((l.balance * need) / provisional, 10_000n * KES);
  if (rng.chance(25)) l.balance += BigInt(rng.int(1, 99));
}
// One balance that will be written with a single decimal digit.
const oneDecimal = free.find((l, i) => i < free.length - 1 && l.balance % 100n === 0n && l.cp > 10)!;
oneDecimal.balance += 50n; // .50 -> written as ".5"
const lastHonest = free[free.length - 1]!;
lastHonest.balance += need - free.reduce((a, l) => a + l.balance, 0n);
// A few recent (August 2026) loans, all small enough to stay under the 1% recency rule.
let recent = 0;
for (const l of free) {
  if (recent < 3 && l.balance < 18n * M && l.balance > 3n * M && l.arrears === 0 && l.cp % 4 === 1) {
    l.opened = `2026-08-${String(5 + recent * 7).padStart(2, "0")}`;
    recent++;
  }
}

lines.push(...honest, ...m22, ...planted);
// Book order: deposits by member, loans roughly by reference (as a core-banking export would list them).
const depLines = lines.filter((l) => l.kind === "DEP");
const loanLines = lines.filter((l) => l.kind === "LOAN").sort((a, b) => (a.ref < b.ref ? -1 : 1));
const book = [...depLines, ...loanLines];

// ------------------------------------------------------------------ assertions on the targets

const sum = (xs: SeedLine[]): bigint => xs.reduce((a, l) => a + l.balance, 0n);
function must(cond: boolean, what: string): void {
  if (!cond) throw new Error(`seed target violated: ${what}`);
}
must(book.length === 159, `159 lines (got ${book.length})`);
must(depLines.length === 39, "39 deposit lines");
must(loanLines.length === 120, "120 loans");
must(sum(depLines) === TOTAL_DEP, "booked deposits");
must(sum(loanLines) === TOTAL_LOAN, "booked loans");
must(new Set(book.map((l) => l.ref)).size === 159, "unique refs");
must(m22Sum === 57_300_000n * KES, "member 22 loans");
must(book.every((l) => l.balance > 0n), "positive balances");
const unrecognised = sum(planted.filter((p) => ["L-F1", "L-F2", "L-F3", "L-F4", "L-F5"].includes(p.planted!))) + (90n * M - MEMBER5_SAYS) + (60n * M - MEMBER19_SAYS);
must(unrecognised === 480n * M, "480M unrecognised fictitious");
const RECOGNISED = TOTAL_LOAN - unrecognised - m22Sum - 45n * M;
must(RECOGNISED === 1_654_600_000n * KES, "recognised loans");
const UPLIFT = 18_500_000n * KES + 12_000_000n * KES;
const LIABILITIES = TOTAL_DEP + UPLIFT;
must(LIABILITIES === 2_510_500_000n * KES, "liabilities");
const CASH = 305_412_318_55n;
const COVERAGE = ((CASH + RECOGNISED) * 10_000n) / LIABILITIES;
const BOOKED_COVERAGE = ((CASH + TOTAL_LOAN) * 10_000n) / TOTAL_DEP;
must(COVERAGE === 7807n, `coverage 7807 (got ${COVERAGE})`);
must(BOOKED_COVERAGE === 10251n, `booked coverage 10251 (got ${BOOKED_COVERAGE})`);
const totalLoans = TOTAL_LOAN;
for (const l of honest) {
  must(l.balance * 20n < totalLoans, `honest loan ${l.ref} under 5% of booked loans`);
  if (l.opened >= "2026-08-01") must(l.balance * 100n < totalLoans, `recent loan ${l.ref} under 1%`);
}
for (const no of pool) {
  const loans = sum(honest.filter((l) => l.cp === no)) + (no === 5 ? MEMBER5_SAYS : no === 19 ? MEMBER19_SAYS : 0n);
  const dep = deposits.get(no)! + (no === 14 ? 18_500_000n * KES : 0n);
  must(loans <= 3n * dep, `member ${no} loans within 3x deposits`);
}

// ------------------------------------------------------------------ writers

const out = seedDir();
mkdirSync(join(out, "member-ledgers"), { recursive: true });
mkdirSync(join(out, "period-2026-09"), { recursive: true });
mkdirSync(vectorsDir(), { recursive: true });
const w = (rel: string, text: string): void => writeFileSync(join(out, rel), text);

function plain(c: bigint): string {
  return `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;
}
function messyBalance(l: SeedLine, i: number): string {
  if (l === oneDecimal) return `${l.balance / 100n}.${(l.balance % 100n) / 10n}`;
  switch (i % 4) {
    case 0:
      return plain(l.balance);
    case 1:
      return csvCell(formatKes(l.balance));
    case 2:
      return csvCell(`KES ${formatKes(l.balance)}`);
    default:
      return plain(l.balance);
  }
}
function bookCsv(rows: SeedLine[]): string {
  const outRows = ["line_ref,cp_no,cp_name,kind,balance_kes,arrears_days,product,opened,notes"];
  rows.forEach((l, i) => {
    const kind = i % 17 === 5 ? l.kind.toLowerCase() : l.kind;
    const arrears = l.kind === "DEP" && i % 3 === 0 ? "" : String(l.arrears);
    let row = [csvCell(l.ref), l.cp, csvCell(l.cpName), kind, messyBalance(l, i), arrears, csvCell(l.product), l.opened, csvCell(l.notes)].join(",");
    if (i % 11 === 4) row += "   "; // trailing whitespace
    outRows.push(row);
    if (i === 70) outRows.push(""); // a blank line mid-file
  });
  return outRows.join("\n") + "\n\n";
}
w("apex-book-2026-08.csv", bookCsv(book));
// Dirty copy: one duplicated line_ref (a second loan booked under an existing reference).
const dup: SeedLine = { ...loanLines[40]!, balance: 7_250_000n * KES, notes: "re-keyed" };
const dirty = [...book.slice(0, 101), dup, ...book.slice(101)];
w("apex-book-2026-08-dirty.csv", bookCsv(dirty));

// Members, keys, config.
const registrar = testKeypair("registrar");
const apex = testKeypair("apex");
const custodian = testKeypair("custodian");
const registrarSalt = sha256("apex-confirm-test/registrar-salt");
const apexSaltKey = sha256("apex-confirm-test/apex-salt-key");
w(
  "members.csv",
  ["no,name,licence_no,board,active,notes"]
    .concat(members.map((m) => [m.no, csvCell(m.name), m.licence, boardContractAddress(m.no), m.active, csvCell(m.note)].join(",")))
    .join("\n") + "\n",
);
w(
  "keys.test.json",
  toJson({
    warning: "TEST KEYS ONLY. Derived from public labels; anyone can recompute them. Never fund or reuse.",
    apex_salt_key: hex(apexSaltKey),
    registrar_salt: hex(registrarSalt),
    registrar: { public: registrar.publicKey(), secret: registrar.secret() },
    apex: { public: apex.publicKey(), secret: apex.secret() },
    custodian: { name: "SIM CUSTODIAN BANK (simulated)", public: custodian.publicKey(), secret: custodian.secret() },
    boards: members.map((m) => ({
      no: m.no,
      board: boardContractAddress(m.no),
      threshold: 2,
      officers: ["chair", "treasurer", "secretary"].map((role) => {
        const k = testKeypair(`board-${m.no}-${role}`);
        return { role, public_hex: hex(k.rawPublicKey()), secret: k.secret() };
      }),
    })),
  }) + "\n",
);
w(
  "config.json",
  toJson({
    apex_name: "SIM APEX UNION (simulated)",
    currency: "KES",
    decimals: 2,
    confirm_window_secs: 10 * 86_400,
    attest_window_secs: 5 * 86_400,
    max_period_gap_secs: 45 * 86_400,
    performing_max_days: 90,
    alert_bps: 10_000,
  }) + "\n",
);
w(
  "concentration.json",
  toJson({
    note: "Thresholds are team assumptions, not calibrated. Output is a pattern for supervisory follow-up, not evidence.",
    loan_to_deposit_multiple: 3,
    single_loan_share_bps: 500,
    recent_days: 30,
    recent_loan_share_bps: 100,
  }) + "\n",
);

// Member ledgers (each member's own view; dormant member 38 exports nothing).
const ledgerOf = new Map<number, string[]>();
for (const m of members) if (m.no !== 38) ledgerOf.set(m.no, ["line_ref,kind,balance_kes,arrears_days"]);
for (const l of book) {
  if (!ledgerOf.has(l.cp)) continue;
  let bal = l.balance;
  if (l.planted === "L-F6") bal = MEMBER5_SAYS;
  if (l.planted === "L-F7") bal = MEMBER19_SAYS;
  if (l.cp === 14 && l.kind === "DEP") bal += 18_500_000n * KES;
  ledgerOf.get(l.cp)!.push([csvCell(l.ref), l.kind, l.cp % 2 === 0 ? plain(bal) : csvCell(formatKes(bal)), l.arrears].join(","));
}
ledgerOf.get(33)!.push(["APX/DEP/0033-1", "DEP", csvCell(formatKes(12_000_000n * KES)), 0].join(","));
for (const [no, rows] of ledgerOf) w(`member-ledgers/${no}.csv`, rows.join("\n") + "\n");

// Custodian statement for August 2026: 214 movements, closing 305,412,318.55.
function statement(opts: { month: string; days: number; n: number; closing: bigint; seed: bigint; commaLine: boolean; closingDate: string }): string {
  const r = new Rng(opts.seed);
  type Mv = { post: string; val: string; ref: string; narr: string; amt: bigint };
  const mv: Mv[] = [];
  const day = (d: number): string => `${opts.month}-${String(d).padStart(2, "0")}`;
  let n = 0;
  while (mv.length < opts.n - 1) {
    const d = r.int(1, opts.days);
    const kindRoll = r.int(1, 100);
    const ref = `FT${opts.month.replace("-", "")}${String(++n).padStart(4, "0")}`;
    if (kindRoll <= 40) mv.push({ post: day(d), val: day(d), ref, narr: `PLACEMENT FROM MEMBER ${String(r.int(1, 40)).padStart(3, "0")}`, amt: r.big(200_000n, 5_000_000n) * KES + r.big(0n, 99n) });
    else if (kindRoll <= 70) mv.push({ post: day(d), val: day(d), ref, narr: `LOAN REPAYMENT APX/LN/${r.int(2021, 2026)}/${r.int(600, 720)}`, amt: r.big(100_000n, 3_000_000n) * KES + r.big(0n, 99n) });
    else if (kindRoll <= 92) mv.push({ post: day(d), val: day(d), ref, narr: `WITHDRAWAL TO MEMBER ${String(r.int(1, 40)).padStart(3, "0")}`, amt: -(r.big(500_000n, 9_000_000n) * KES + r.big(0n, 99n)) });
    else if (kindRoll <= 97) mv.push({ post: day(d), val: day(d), ref, narr: "BANK CHARGES", amt: -(r.big(150n, 4_500n) * KES) });
    else {
      // a disbursement and its reversal
      const amt = r.big(1_000_000n, 6_000_000n) * KES;
      mv.push({ post: day(d), val: day(d), ref, narr: `LOAN DISB APX/LN/2026/${r.int(700, 760)}`, amt: -amt });
      if (mv.length < opts.n - 1) mv.push({ post: day(Math.min(d + 1, opts.days)), val: day(d), ref: `${ref}-REV`, narr: `REVERSAL OF ${ref} INCORRECT BENEFICIARY`, amt });
    }
  }
  mv.sort((a, b) => (a.post < b.post ? -1 : a.post > b.post ? 1 : 0));
  // value date differs from posting date on two lines
  mv[3]!.val = day(1);
  mv[3]!.post = day(3);
  const last = mv[mv.length - 1]!;
  last.post = day(opts.days);
  const lastCredit = r.big(1_000_000n, 3_000_000n) * KES + 37n;
  const closingMv: Mv = { post: day(opts.days), val: `${opts.closingDate.slice(0, 5)}${String(Number(opts.closingDate.slice(5, 7)) + 1).padStart(2, "0")}-01`, ref: `FT${opts.month.replace("-", "")}9999`, narr: "INTEREST CAPITALISED", amt: lastCredit };
  mv.push(closingMv);
  const total = mv.reduce((a, m) => a + m.amt, 0n);
  const opening = opts.closing - total;
  if (opening <= 0n) throw new Error("statement opening balance not positive; change seed");
  const rows = [
    "Bank,SIM CUSTODIAN BANK (simulated)",
    "Account,0100-SIMAPEX-01 SIM APEX UNION (simulated) - settlement",
    `Period,${day(1)} to ${day(opts.days)}`,
    "posting_date,value_date,reference,narrative,debit_kes,credit_kes,balance_kes",
    `${day(1)},${day(1)},OPENING BALANCE,,,,${plain(opening)}`,
  ];
  mv.forEach((m, i) => {
    const amt = m.amt < 0n ? -m.amt : m.amt;
    let s = i % 9 === 2 ? csvCell(formatKes(amt)) : plain(amt);
    if (opts.commaLine && i === 57 && m.amt > 0n) s = csvCell(`${amt / 100n},${(amt % 100n).toString().padStart(2, "0")}`);
    rows.push([m.post, m.val, m.ref, csvCell(m.narr), m.amt < 0n ? s : "", m.amt > 0n ? s : "", ""].join(","));
  });
  rows.push(`${opts.closingDate},${opts.closingDate},CLOSING BALANCE,,,,${plain(opts.closing)}`);
  return rows.join("\n") + "\n";
}
// Make sure line 57 is a credit so the comma-decimal line exists.
let aug = "";
for (let s = 11n; ; s++) {
  try {
    aug = statement({ month: "2026-08", days: 31, n: 214, closing: CASH, seed: s, commaLine: true, closingDate: "2026-08-31" });
  } catch {
    continue; // opening not positive with this seed; try the next
  }
  if (/,"\d+,\d\d",/.test(aug)) break;
}
w("custodian-statement-2026-08-31.csv", aug);

// Response plan for August.
const OPEN_AT = "2026-09-01T07:00:00Z";
const POST_AT = "2026-09-01T08:00:00Z";
const planMembers = members
  .filter((m) => m.active && m.no !== 22)
  .map((m) => ({ no: m.no, day: m.no === 11 ? 12 : m.no === 29 ? 13 : rng.int(1, 9), hour: rng.int(8, 17) }));
w(
  "responses-plan.json",
  toJson({
    period: 1,
    as_of: "2026-08-31",
    init_at: "2026-08-25T08:00:00Z",
    open_at: OPEN_AT,
    post_at: POST_AT,
    note: "days are counted from post_at; the confirm window is 10 days, so days 12 and 13 are late",
    custodian: { day: 3, hour: 10 },
    members: planMembers,
    never: [22],
    inactive: [38],
    watch_day: 14,
    close_day: 14,
  }) + "\n",
);

// ------------------------------------------------------------------ period 2 (September): a smaller book, and the apex stalls

const p2Deposits: SeedLine[] = members.map((m) => {
  const base = m.no === 33 ? 12_000_000n * KES : deposits.get(m.no)!;
  // After the August alert many members withdrew: the September book is smaller.
  const drift = -(base * BigInt(rng.int(55, 65))) / 100n;
  return {
    ref: `APX/DEP/${String(m.no).padStart(4, "0")}-1`,
    cp: m.no,
    cpName: bookName(m, m.no + 1),
    kind: "DEP" as const,
    balance: roundTo(base + drift, 1000n * KES),
    arrears: 0,
    product: "Term placement",
    opened: "2024-01-01",
    notes: m.no === 33 ? "line restored after member claim" : "",
  };
});
const p2Loans: SeedLine[] = [
  ...planted.filter((p) => ["L-F1", "L-F2", "L-F3", "L-F4", "L-F5"].includes(p.planted!)).map((p) => ({ ...p })),
  ...m22.map((l) => ({ ...l, arrears: l.arrears + 30 })),
  ...[1, 2, 3, 4, 6, 7, 9, 10].map((no, i) => ({
    ref: `APX/LN/2026/${String(900 + i).padStart(4, "0")}`,
    cp: no,
    cpName: bookName(members[no - 1]!, i),
    kind: "LOAN" as const,
    balance: roundTo((deposits.get(no)! * BigInt(rng.int(8, 20))) / 100n, 10_000n * KES),
    arrears: i === 5 ? 14 : 0,
    product: rng.pick(PRODUCTS),
    opened: `2025-${String(i + 2).padStart(2, "0")}-10`,
    notes: "",
  })),
];
const p2Book = [...p2Deposits, ...p2Loans];
w("period-2026-09/apex-book-2026-09.csv", bookCsv(p2Book));
const CASH2 = 298_774_905_10n;
let sep = "";
for (let s = 101n; ; s++) {
  try {
    sep = statement({ month: "2026-09", days: 30, n: 64, closing: CASH2, seed: s, commaLine: false, closingDate: "2026-09-30" });
    break;
  } catch {
    /* opening not positive with this seed; try the next */
  }
}
w("period-2026-09/custodian-statement-2026-09-30.csv", sep);
w(
  "period-2026-09/responses-plan.json",
  toJson({
    period: 2,
    as_of: "2026-09-30",
    open_at: "2026-10-01T07:00:00Z",
    note: "the apex opens the period but posts no root for 50 days; days below are counted from open_at",
    custodian: { day: 3, hour: 11 },
    watch_checks: [{ day: 30, expect_stale: false }, { day: 46, expect_stale: true }],
    post_day: 50,
    members_confirm_all: members.filter((m) => m.active && m.no !== 22).map((m) => ({ no: m.no, day: 50 + rng.int(1, 5), hour: rng.int(8, 17) })),
    never: [22],
    inactive: [38],
    watch_day: 61,
    close_day: 61,
  }) + "\n",
);

// Independent arithmetic for period 2's expected report.
const p2Dep = sum(p2Deposits);
const p2Loan = sum(p2Loans);
const p2Confirmed = sum(p2Loans.filter((l) => l.cp <= 10 && l.cp !== 22 && !l.planted));
const p2Recognised = sum(p2Loans.filter((l) => l.cp <= 10 && l.cp !== 22 && !l.planted && l.arrears <= 90));
const p2Cov = ((CASH2 + p2Recognised) * 10_000n) / p2Dep;
const p2Booked = ((CASH2 + p2Loan) * 10_000n) / p2Dep;
let p2Flags = FLAGS.UNCONFIRMED_LOANS;
if (p2Cov < 10_000n) p2Flags |= FLAGS.BELOW_ALERT;
if (p2Booked - p2Cov >= 1000n) p2Flags |= FLAGS.GAP_WIDE;

// ------------------------------------------------------------------ expected.json

const refOf = (tag: string): string => planted.find((p) => p.planted === tag)!.ref;
const expected = {
  note: "Simulated. These numbers illustrate the mechanism only.",
  planted: Object.fromEntries(planted.map((p) => [p.planted!, { ref: p.ref, cp: p.cp, booked: plain(p.balance) }])),
  period_1: {
    as_of: "2026-08-31",
    root_dep: TOTAL_DEP.toString(),
    root_loan: TOTAL_LOAN.toString(),
    deposit_uplift: UPLIFT.toString(),
    report: {
      period: 1,
      liabilities: LIABILITIES.toString(),
      cash: CASH.toString(),
      recognised_loans: RECOGNISED.toString(),
      booked_loans: TOTAL_LOAN.toString(),
      unconfirmed_loans: (sum(planted.filter((p) => ["L-F1", "L-F2", "L-F3", "L-F4", "L-F5"].includes(p.planted!))) + m22Sum).toString(),
      coverage_bps: "7807",
      booked_coverage_bps: "10251",
      unresponded: 10,
      disputed: 3,
      late: countLines([11, 29]),
      omitted: 1,
      flags: FLAGS.BELOW_ALERT | FLAGS.UNCONFIRMED_LOANS | FLAGS.DISPUTES | FLAGS.LATE_RESPONSES | FLAGS.OMITTED_CLAIMS | FLAGS.GAP_WIDE,
      flag_names: ["BELOW_ALERT", "UNCONFIRMED_LOANS", "DISPUTES", "LATE_RESPONSES", "OMITTED_CLAIMS", "GAP_WIDE"],
    },
    overdue_flagged: [22],
    colluding_loan: { tag: "L-F8", ref: refOf("L-F8"), member: 37, booked: (48n * M).toString(), recognised: true },
    proposals: {
      "5": [{ action: "dispute", ref: refOf("L-F6"), claimed: MEMBER5_SAYS.toString(), reason: "BALANCE_WRONG" }],
      "14": [{ action: "dispute", ref: "APX/DEP/0014-1", claimed: (deposits.get(14)! + 18_500_000n * KES).toString(), reason: "BALANCE_WRONG" }],
      "19": [{ action: "dispute", ref: refOf("L-F7"), claimed: MEMBER19_SAYS.toString(), reason: "BALANCE_WRONG" }],
      "33": [{ action: "claim-omitted", claimed: (12_000_000n * KES).toString() }],
    },
    concentration_flagged: [{ member: 37, rules: ["i", "iii"] }],
  },
  period_2: {
    as_of: "2026-09-30",
    stale_flag: true,
    member_22_overdue_streak: 2,
    report: {
      period: 2,
      liabilities: p2Dep.toString(),
      cash: CASH2.toString(),
      recognised_loans: p2Recognised.toString(),
      booked_loans: p2Loan.toString(),
      unconfirmed_loans: (p2Loan - p2Confirmed).toString(),
      coverage_bps: p2Cov.toString(),
      booked_coverage_bps: p2Booked.toString(),
      unresponded: 10,
      disputed: 0,
      late: 0,
      omitted: 0,
      flags: p2Flags,
    },
  },
};
function countLines(nos: number[]): number {
  return book.filter((l) => nos.includes(l.cp)).length;
}

// ------------------------------------------------------------------ run the journey and write vectors

const result = runJourney({ seedDir: out, expectedOverride: expected });
const r1 = result.periods[0]!.report;
must(r1.coverage_bps === 7807n && r1.booked_coverage_bps === 10251n, `journey coverage ${r1.coverage_bps}/${r1.booked_coverage_bps}`);
for (const [k, v] of Object.entries(expected.period_1.report)) {
  if (k === "flag_names") continue;
  must(String((r1 as unknown as Record<string, unknown>)[k]) === String(v), `period 1 ${k}: ${String((r1 as unknown as Record<string, unknown>)[k])} != ${String(v)}`);
}
const r2 = result.periods[1]!.report;
for (const [k, v] of Object.entries(expected.period_2.report)) {
  must(String((r2 as unknown as Record<string, unknown>)[k]) === String(v), `period 2 ${k}: ${String((r2 as unknown as Record<string, unknown>)[k])} != ${String(v)}`);
}
w("expected.json", toJson(expected) + "\n");

for (const p of result.periods) {
  const v = {
    note: "Generated by app/src/seed/generate.ts from data/seed. Read by the Rust scenario test.",
    period: p.period,
    as_of: p.asOf,
    open_at: p.openAt,
    post_at: p.postAt,
    members: 40,
    inactive: [38],
    root: nodeToJson(p.tree.root),
    leaf_count: p.tree.leafCount,
    depth: p.tree.depth,
    file_hash: hex(p.tree.fileHash),
    leaves: p.tree.leaves.map(leafToJson),
    cash: { balance: p.cash.toString(), at: p.cashAt },
    stale_checks: p.staleChecks,
    actions: p.actions,
    watch_at: p.watchAt,
    close_at: p.closeAt,
    expected: {
      ...Object.fromEntries(Object.entries(p.report).map(([k, x]) => [k, typeof x === "bigint" ? x.toString() : x])),
      overdue_flagged: p.overdueFlagged,
      streak_22: p.streak22,
    },
    colluding_index: p.tree.leaves.findIndex((l, i) => p.tree.refs[i] === refOf("L-F8")),
  };
  writeFileSync(join(vectorsDir(), `seed-period-${p.period}.json`), toJson(v) + "\n");
}

// ------------------------------------------------------------------ small Merkle vectors

function vectorTree(period: number, specs: { cp: number; kind: number; ref: string; balance: bigint; arrears: number }[]): unknown {
  const leaves: Leaf[] = specs.map((s, index) => ({
    period,
    index,
    cp: s.cp,
    kind: s.kind,
    lineRef: sha256(s.ref),
    balance: s.balance,
    arrearsDays: s.arrears,
    salt: sha256(`vector-salt/${period}/${index}`),
  }));
  const levels = buildLevels(period, leaves);
  return {
    note: "Shared Merkle sum tree vector. Leaf, node and root encodings per docs/LEAF-FORMAT.md.",
    period,
    leaf_count: leaves.length,
    depth: levels.length - 1,
    leaves: leaves.map((l, i) => ({ ...leafToJson(l), ref: specs[i]!.ref, leaf_hash: hex(leafHash(l)), node: nodeToJson(leafNode(l)) })),
    padding: Array.from({ length: (1 << (levels.length - 1)) - leaves.length }, (_, j) => ({
      index: leaves.length + j,
      node: nodeToJson(emptyNode(period, leaves.length + j)),
    })),
    levels: levels.map((lv) => lv.map(nodeToJson)),
    root: nodeToJson(levels[levels.length - 1]![0]!),
    proofs: leaves.map((_, i) => proofFor(levels, i).map(nodeToJson)),
  };
}
writeFileSync(
  join(vectorsDir(), "tree5.json"),
  toJson(
    vectorTree(7, [
      { cp: 3, kind: KIND_DEPOSIT, ref: "APX/DEP/0003-1", balance: 61_250_000_00n, arrears: 0 },
      { cp: 3, kind: KIND_LOAN, ref: "APX/LN/2024/0611", balance: 18_400_000_50n, arrears: 0 },
      { cp: 12, kind: KIND_LOAN, ref: "APX/LN/2025/0640", balance: 9_990_000_00n, arrears: 47 },
      { cp: 901, kind: KIND_LOAN, ref: "APX/LN/2024/0031", balance: 100_000_000_00n, arrears: 0 },
      { cp: 12, kind: KIND_DEPOSIT, ref: "APX/DEP/0012-1", balance: 1n, arrears: 0 },
    ]),
  ) + "\n",
);
writeFileSync(
  join(vectorsDir(), "tree1.json"),
  toJson(vectorTree(1, [{ cp: 1, kind: KIND_DEPOSIT, ref: "APX/DEP/0001-1", balance: 12_000_000_00n, arrears: 0 }])) + "\n",
);

console.log(`seed written to ${out}`);
console.log(`vectors written to ${vectorsDir()}`);
console.log(`period 1: coverage ${r1.coverage_bps} bps vs booked ${r1.booked_coverage_bps} bps, flags ${r1.flags}`);
console.log(`period 2: coverage ${r2.coverage_bps} bps vs booked ${r2.booked_coverage_bps} bps, stale=${result.periods[1]!.staleFlag}`);

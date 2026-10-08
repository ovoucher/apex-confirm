/** Argument parsing for the `apex` CLI. Pure, so it is unit-tested. */

export class UsageError extends Error {}

export interface Parsed {
  command: string;
  sub: string | null;
  positional: string[];
  flags: Record<string, string | true>;
}

/** Flags that never take a value. */
const BOOLEAN_FLAGS = new Set(["offline", "json", "inactive", "quiet", "dry-run", "help"]);

export const COMMANDS: Record<string, { subs?: string[]; usage: string }> = {
  init: { usage: "apex init --registrar <key> --apex <addr> [--config config.json]" },
  member: { subs: ["add", "deactivate", "activate", "rotate"], usage: "apex member add <no> <board-addr> <licence-no> | member deactivate <no> | member rotate <no> <new-board>" },
  custodian: { subs: ["set"], usage: "apex custodian set <addr> [--inactive]" },
  open: { usage: "apex open --as-of 2026-08-31 [--supersedes <id>]" },
  build: { usage: "apex build --period <id> --book <apex-book.csv>" },
  post: { usage: "apex post --period <id>" },
  check: { usage: "apex check --member <no> --pack <pack.json> --ledger <member-ledger.csv>" },
  confirm: { usage: "apex confirm --member <no> --pack <pack.json> [--lines all|<idx,...>]" },
  dispute: { usage: "apex dispute --member <no> --pack <pack.json> --line <idx> --claimed <KES> --reason <BALANCE_WRONG|NOT_OURS|ARREARS_WRONG|OTHER> [--claimed-arrears <days>] [--evidence <file>]" },
  omitted: { usage: "apex omitted --member <no> --claimed <KES> [--evidence <file>] [--period <id>]" },
  attest: { usage: "apex attest --custodian <key> --period <id> --statement <statement.csv>" },
  close: { usage: "apex close --period <id>" },
  watch: { usage: "apex watch" },
  "verify-tree": { usage: "apex verify-tree --period <id> --tree <tree.json>" },
  report: { usage: "apex report --period <id> [--as member:<no>|regulator|public] [--json]" },
  pages: { usage: "apex pages --out <dir>" },
  simulate: { usage: "apex simulate [--out <dir>] [--web <pages-dir>] [--json] [--quiet]" },
};

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      if (!name) throw new UsageError("empty flag");
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith("--")) flags[name] = true;
      else {
        flags[name] = next;
        i++;
      }
    } else positional.push(a);
  }
  const command = positional.shift();
  if (!command || flags["help"]) throw new UsageError(usage());
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`unknown command "${command}"\n${usage()}`);
  let sub: string | null = null;
  if (spec.subs) {
    sub = positional.shift() ?? null;
    if (!sub || !spec.subs.includes(sub)) throw new UsageError(`usage: ${spec.usage}`);
  }
  return { command, sub, positional, flags };
}

export function usage(): string {
  return ["usage: apex <command> [--offline] [--data-dir var/] [--at <iso-time>]", ...Object.values(COMMANDS).map((c) => `  ${c.usage}`)].join("\n");
}

export function flagStr(p: Parsed, name: string, required = true): string | undefined {
  const v = p.flags[name];
  if (v === undefined || v === true) {
    if (required) throw new UsageError(`missing --${name}\nusage: ${COMMANDS[p.command]!.usage}`);
    return undefined;
  }
  return v;
}

export function flagInt(p: Parsed, name: string, required = true): number | undefined {
  const v = flagStr(p, name, required);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be a non-negative integer, got "${v}"`);
  return Number(v);
}

export function posInt(p: Parsed, i: number, what: string): number {
  const v = p.positional[i];
  if (v === undefined || !/^\d+$/.test(v)) throw new UsageError(`expected ${what} as argument ${i + 1}\nusage: ${COMMANDS[p.command]!.usage}`);
  return Number(v);
}

export function posStr(p: Parsed, i: number, what: string): string {
  const v = p.positional[i];
  if (v === undefined) throw new UsageError(`expected ${what} as argument ${i + 1}\nusage: ${COMMANDS[p.command]!.usage}`);
  return v;
}

/** "--lines all" or "--lines 3,17,42" */
export function parseLines(v: string | undefined): "all" | number[] {
  if (v === undefined || v === "all") return "all";
  const parts = v.split(",").map((s) => s.trim());
  if (!parts.every((s) => /^\d+$/.test(s))) throw new UsageError(`--lines must be "all" or comma-separated indexes, got "${v}"`);
  return parts.map(Number);
}

/** "--as member:14" | "--as regulator" | "--as public" */
export function parseAudience(v: string | undefined): { kind: "public" } | { kind: "regulator" } | { kind: "member"; no: number } {
  if (v === undefined || v === "public") return { kind: "public" };
  if (v === "regulator") return { kind: "regulator" };
  const m = /^member:(\d+)$/.exec(v);
  if (m) return { kind: "member", no: Number(m[1]) };
  throw new UsageError(`--as must be public, regulator or member:<no>, got "${v}"`);
}

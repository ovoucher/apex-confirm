import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError, parseArgs, parseAudience, parseLines } from "../src/cli-args.js";
import { main } from "../src/cli.js";
import { seedPath } from "./helpers.js";

test("parseArgs: command, sub-command, positionals, value and boolean flags", () => {
  const p = parseArgs(["member", "add", "7", "CBOARD", "SIM/DT/0022", "--offline", "--data-dir", "x"]);
  assert.equal(p.command, "member");
  assert.equal(p.sub, "add");
  assert.deepEqual(p.positional, ["7", "CBOARD", "SIM/DT/0022"]);
  assert.equal(p.flags["offline"], true);
  assert.equal(p.flags["data-dir"], "x");
  const q = parseArgs(["dispute", "--member=5", "--claimed", "40,000,000.00", "--json"]);
  assert.equal(q.flags["member"], "5");
  assert.equal(q.flags["claimed"], "40,000,000.00");
  assert.equal(q.flags["json"], true);
});

test("parseArgs rejects unknown commands, missing sub-commands and --help", () => {
  assert.throws(() => parseArgs([]), UsageError);
  assert.throws(() => parseArgs(["frobnicate"]), /unknown command/);
  assert.throws(() => parseArgs(["member", "delete", "3"]), /usage: apex member/);
  assert.throws(() => parseArgs(["open", "--help"]), UsageError);
});

test("--lines and --as", () => {
  assert.equal(parseLines(undefined), "all");
  assert.deepEqual(parseLines("3,17, 42"), [3, 17, 42]);
  assert.throws(() => parseLines("3,x"), UsageError);
  assert.deepEqual(parseAudience("member:14"), { kind: "member", no: 14 });
  assert.deepEqual(parseAudience("regulator"), { kind: "regulator" });
  assert.deepEqual(parseAudience(undefined), { kind: "public" });
  assert.throws(() => parseAudience("members:1"), UsageError);
});

async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await main(args, (s) => lines.push(s));
  return { code, out: lines.join("\n") };
}

test("exit codes: 1 usage, 2 validation failure, 3 contract error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "apex-cli-"));
  try {
    const off = ["--offline", "--data-dir", dir, "--at", "2026-09-01T07:00:00Z"];
    assert.equal((await cli(["open"])).code, 1);
    assert.equal((await cli(["open", ...off])).code, 1, "missing --as-of");
    // contract error: open before init
    const r = await cli(["open", "--as-of", "2026-08-31", ...off]);
    assert.equal(r.code, 3);
    assert.match(r.out, /NotInitialised/);
    // set up a register, then fail validation on the dirty book
    assert.equal((await cli(["init", "--registrar", "GREG", "--apex", "GAPEX", ...off])).code, 0);
    assert.equal((await cli(["member", "add", "1", "CB1", "SIM/DT/0001", ...off])).code, 0);
    assert.equal((await cli(["custodian", "set", "GBANK", ...off])).code, 0);
    // the apex cannot be a member board
    const rc = await cli(["member", "add", "2", "GAPEX", "SIM/DT/0002", ...off]);
    assert.equal(rc.code, 3);
    assert.match(rc.out, /RoleConflict/);
    assert.equal((await cli(["open", "--as-of", "2026-08-31", ...off])).code, 0);
    const v = await cli(["build", "--period", "1", "--book", seedPath("apex-book-2026-08-dirty.csv"), "--salt-key", "11".repeat(32), ...off]);
    assert.equal(v.code, 2);
    assert.match(v.out, /DUPLICATE_REF/);
    const ok = await cli(["build", "--period", "1", "--book", seedPath("apex-book-2026-08.csv"), "--salt-key", "11".repeat(32), ...off]);
    assert.equal(ok.code, 0, ok.out);
    assert.ok(existsSync(join(dir, "period-1", "root.json")));
    assert.ok(existsSync(join(dir, "period-1", "packs", "5.json")));
    assert.equal((await cli(["post", "--period", "1", ...off])).code, 0);
    // statement for another date: AsOfMismatch
    const bad = await cli(["attest", "--custodian", "GBANK", "--period", "1", "--statement", seedPath("period-2026-09/custodian-statement-2026-09-30.csv"), ...off]);
    assert.equal(bad.code, 3);
    assert.match(bad.out, /AsOfMismatch/);
    const good = await cli(["attest", "--custodian", "GBANK", "--period", "1", "--statement", seedPath("custodian-statement-2026-08-31.csv"), ...off]);
    assert.equal(good.code, 0, good.out);
    assert.match(good.out, /305,412,318\.55/);
    // too early to close
    const early = await cli(["close", "--period", "1", ...off]);
    assert.equal(early.code, 3);
    assert.match(early.out, /TooEarly/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live mode without RPC settings is a usage error; --dry-run builds the transaction offline", async () => {
  delete process.env.STELLAR_RPC_URL;
  const r = await cli(["close", "--period", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /STELLAR_RPC_URL/);
  process.env.APEX_REGISTER_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const d = await cli(["close", "--period", "1", "--dry-run"]);
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /dry run: close_period\(1 args\)/);
  delete process.env.APEX_REGISTER_CONTRACT_ID;
});

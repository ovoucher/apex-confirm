import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatKes } from "../src/util/amounts.js";
import { treeFile, memberPack } from "../src/tree/build.js";
import { writePages } from "../src/cli.js";
import { journey } from "./journey-cache.js";

function render() {
  const j = journey();
  const dir = mkdtempSync(join(tmpdir(), "apex-pages-"));
  writePages(
    j.model,
    dir,
    j.config.apex_name,
    (id) => (j.periods[id - 1] ? treeFile(j.periods[id - 1]!.tree) : null),
    (id, no) => (j.periods[id - 1] ? memberPack(j.periods[id - 1]!.tree, no) : null),
    new Map(j.periods.map((p) => [p.period, p.concentration])),
    new Map(j.members.map((m) => [m.no, m.name])),
  );
  return { j, dir };
}

test("the public page contains no member-level amount or reference", () => {
  const { j, dir } = render();
  try {
    const html = readFileSync(join(dir, "public", "index.html"), "utf8");
    assert.match(html, /7807/);
    assert.match(html, /10251/);
    assert.match(html, /could do most of what this register does/);
    for (const p of j.periods) {
      p.tree.leaves.forEach((l, i) => {
        assert.ok(!html.includes(formatKes(l.balance)), `public page leaks balance ${formatKes(l.balance)}`);
        assert.ok(!html.includes(p.tree.refs[i]!), `public page leaks ref ${p.tree.refs[i]}`);
      });
    }
    for (const m of j.members) assert.ok(!html.includes(m.name.replace(" (simulated)", "")), `public page names member ${m.no}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each member page contains only that member's lines", () => {
  const { j, dir } = render();
  try {
    const p1 = j.periods[0]!;
    for (const no of [5, 14, 22, 37]) {
      const html = readFileSync(join(dir, "member", String(no), "index.html"), "utf8");
      p1.tree.leaves.forEach((l, i) => {
        const ref = p1.tree.refs[i]!;
        if (l.cp === no) assert.ok(html.includes(ref), `member ${no} page misses its line ${ref}`);
        else assert.ok(!html.includes(`<code>${ref}</code>`), `member ${no} page shows ${ref} of member ${l.cp}`);
      });
    }
    const m22 = readFileSync(join(dir, "member", "22", "index.html"), "utf8");
    assert.match(m22, /Overdue streak<\/div><div class="v bad">2/);
    assert.match(readFileSync(join(dir, "member", "5", "index.html"), "utf8"), /DISPUTED \(BALANCE_WRONG/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the regulator page maps unresponded indexes to lines and passes verify-tree", () => {
  const { dir } = render();
  try {
    const html = readFileSync(join(dir, "regulator", "index.html"), "utf8");
    assert.match(html, /APX\/LN\/2024\/0031/); // the housing-department loan (non-member 901)
    assert.match(html, /not a member/);
    assert.match(html, /inactive member/);
    assert.match(html, /verify-tree: the full line file recomputes/);
    assert.match(html, /not evidence/);
    assert.match(html, /member 22: 2/);
    assert.ok(existsSync(join(dir, "public", "data.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

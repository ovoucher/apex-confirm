/**
 * Static pages. Data is embedded at generation time.
 *   web/public/index.html        ratios and flags only; no member-level data
 *   web/member/<no>/index.html   one member's own lines; generated for that member, not published by default
 *   web/regulator/index.html     everything; gitignored and never published
 */
import { formatBps, formatKes } from "../util/amounts.js";
import { flagText, flagsFromNames } from "../report/flags.js";
import type { MemberView, PublicView, RegulatorPeriod } from "../report/period.js";
import { REASON_NAMES } from "../register/errors.js";
import { isoTime } from "../util/time.js";
import { esc, page, tile } from "./templates/layout.js";

const CAVEAT = `<div class="caveat"><strong>Read this first.</strong> A regulator-run database could do most of what this register does.
The ledger's only extra value is that members can check these numbers without trusting the apex or the regulator.
Coverage counts only cash the custodian bank attests and loans the borrowing SACCOs confirm. It is a floor, not solvency.
A loan booked to a member whose board colludes with the apex is confirmed and counted: collusion is not caught.</div>`;

function bpsCell(v: string | null): string {
  return v === null ? "&ndash;" : `${esc(v)} <span class="sub">(${formatBps(BigInt(v))})</span>`;
}

export function publicPage(v: PublicView, apexName: string): string {
  const latest = [...v.periods].reverse().find((p) => p.coverage_bps !== null);
  const tiles = latest
    ? [
        tile("Confirmed coverage", formatBps(BigInt(latest.coverage_bps!)), BigInt(latest.coverage_bps!) < 10_000n ? "bad" : "ok"),
        tile("Booked coverage (apex's own books)", formatBps(BigInt(latest.booked_coverage_bps!))),
        tile("Gap", latest.gap_bps === null ? "n/a" : `${latest.gap_bps} bps`, latest.gap_bps !== null && BigInt(latest.gap_bps) >= 1000n ? "bad" : ""),
        tile("Apex staleness", v.apex_stale_since ? `stale since ${esc(v.apex_stale_since)}` : "posting on time", v.apex_stale_since ? "bad" : "ok"),
      ].join("")
    : tile("Status", "no closed period yet");
  const rows = v.periods
    .map(
      (p) => `<tr><td>${p.period}${p.supersedes ? ` <span class="sub">(corrects ${p.supersedes})</span>` : ""}</td><td>${esc(p.as_of)}</td><td>${esc(p.state)}</td>
<td class="n">${bpsCell(p.coverage_bps)}</td><td class="n">${bpsCell(p.booked_coverage_bps)}</td><td class="n">${p.gap_bps ?? "&ndash;"}</td>
<td class="n">${p.lines}</td><td class="n">${p.unresponded ?? "&ndash;"}</td><td class="n">${p.disputed ?? "&ndash;"}</td><td class="n">${p.late ?? "&ndash;"}</td><td class="n">${p.omitted ?? "&ndash;"}</td>
<td>${p.custodian_attested_at.map(esc).join("<br>") || "not yet"}</td><td>${p.flags.map(esc).join("<br>") || "none"}</td></tr>`,
    )
    .join("\n");
  const flagHelp = latest ? `<ul>${flagText(flagsFromNames(latest.flags)).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "";
  return page(
    `${apexName}: coverage register`,
    `<h1>${esc(apexName)}: coverage register</h1>
<p class="sub">Public view, generated ${esc(v.generated_at)}. Ratios in basis points (10000 = 100%). No member-level amounts are shown here.</p>
${CAVEAT}
<div class="grid">${tiles}</div>
<h2>Flags in the latest closed period</h2>${flagHelp}
<h2>All periods</h2>
<div class="scroll"><table><thead><tr><th>Period</th><th>Balance date</th><th>State</th><th class="n">Confirmed coverage</th><th class="n">Booked coverage</th><th class="n">Gap (bps)</th><th class="n">Lines</th><th class="n">Unresponded</th><th class="n">Disputed</th><th class="n">Late</th><th class="n">Omitted claims</th><th>Custodian attested</th><th>Flags</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<h2>How to check this yourself</h2>
<p>Every figure above can be recomputed from the register contract: <code>report(period)</code>, <code>tally(period)</code>, <code>cash(period)</code> and the posted root in <code>period(period)</code>. The formula is in docs/COVERAGE.md.</p>`,
  );
}

export function memberPage(v: MemberView, pub: PublicView): string {
  const sections = v.periods
    .map((p) => {
      const pp = pub.periods.find((x) => x.period === p.period);
      const rows = p.lines
        .map(
          (l) => `<tr><td class="n">${l.index}</td><td><code>${esc(l.ref)}</code></td><td>${l.kind}</td><td class="n">${esc(l.booked)}</td><td class="n">${l.arrears_days}</td>
<td class="${l.proof_ok ? "ok" : "bad"}">${l.proof_ok ? "verified" : "FAILED"}</td>
<td>${l.response ? `${l.response.verdict}${l.response.verdict === "DISPUTED" ? ` (${esc(l.response.reason)}, ours ${esc(l.response.claimed)})` : ""}<br><span class="sub">${esc(l.response.at)}${l.response.late ? " &middot; late" : ""}</span>` : '<span class="warn">no response</span>'}</td></tr>`,
        )
        .join("\n");
      return `<h2>Period ${p.period}${pp ? ` &middot; balance date ${esc(pp.as_of)}` : ""}</h2>
${p.lines.length ? `<div class="scroll"><table><thead><tr><th class="n">Index</th><th>Apex reference</th><th>Kind</th><th class="n">Booked (KES)</th><th class="n">Arrears days</th><th>Proof vs on-chain root</th><th>Our response</th></tr></thead><tbody>${rows}</tbody></table></div>` : "<p>No lines were delivered to us for this period.</p>"}
${p.omitted ? `<p>We claimed an omitted deposit of KES ${esc(p.omitted)}.</p>` : ""}
${pp && pp.coverage_bps !== null ? `<p>Public ratios for this period: confirmed ${formatBps(BigInt(pp.coverage_bps))}, booked ${formatBps(BigInt(pp.booked_coverage_bps!))}.</p>` : ""}`;
    })
    .join("\n");
  return page(
    `Member ${v.member}: apex lines`,
    `<h1>Member ${v.member}: ${esc(v.name)}</h1>
<p class="sub">Private to member ${v.member}. Generated for this member only; not published by default.</p>
${CAVEAT}
<div class="grid">${tile("Overdue streak", String(v.overdue_streak), v.overdue_streak > 0 ? "bad" : "ok")}${tile("Last period responded", String(v.last_response_period || "none"))}</div>
${sections}`,
  );
}

export function regulatorPage(periods: RegulatorPeriod[], apexName: string, generatedAt: number): string {
  const body = periods
    .map((p) => {
      const r = p.report;
      const head = r
        ? `<div class="grid">${tile("Confirmed coverage", `${r.coverage_bps} bps`, r.coverage_bps < 10_000n ? "bad" : "ok")}${tile("Booked coverage", `${r.booked_coverage_bps} bps`)}${tile("Unconfirmed loans (KES)", formatKes(r.unconfirmed_loans), r.unconfirmed_loans > 0n ? "bad" : "")}${tile("Liabilities incl. member claims (KES)", formatKes(r.liabilities))}</div>`
        : "<p>Not closed yet.</p>";
      const un = p.unresponded
        .map(
          (u) =>
            `<tr><td class="n">${u.index}</td><td><code>${esc(u.ref)}</code></td><td class="n">${u.cp}</td><td>${esc(u.cp_name)}</td><td>${u.kind}</td><td class="n">${esc(u.booked)}</td><td>${u.registered ? (u.active ? "active member" : '<span class="bad">inactive member</span>') : '<span class="bad">not a member</span>'}</td></tr>`,
        )
        .join("\n");
      const ds = p.disputes
        .map(
          (d) =>
            `<tr><td class="n">${d.index}</td><td><code>${esc(d.ref)}</code></td><td class="n">${d.member_no}</td><td>${d.kind === 1 ? "DEP" : "LOAN"}</td><td class="n">${formatKes(d.booked)}</td><td class="n">${formatKes(d.claimed)}</td><td>${esc(REASON_NAMES[d.reason] ?? "?")}</td><td><code>${esc(d.evidence_hash.slice(0, 16))}&hellip;</code></td><td>${esc(isoTime(d.at))}${d.late ? " late" : ""}</td></tr>`,
        )
        .join("\n");
      const cf = p.concentration.map((c) => `<tr><td class="n">${c.member}</td><td>${c.rules.join(", ")}</td><td>${c.details.map(esc).join("<br>")}</td></tr>`).join("\n");
      const vt = p.verify
        ? p.verify.ok
          ? '<p class="ok">verify-tree: the full line file recomputes to the on-chain root; every leaf is non-negative and every reference unique.</p>'
          : `<ul class="bad">${p.verify.issues.map((i) => `<li>${esc(i.code)}: ${esc(i.message)}</li>`).join("")}</ul>`
        : "<p>verify-tree not run.</p>";
      return `<h2>Period ${p.period}</h2>${head}
<h3>Full-file check</h3>${vt}
<h3>Unresponded lines (off-chain mapping from the full tree)</h3>
<div class="scroll"><table><thead><tr><th class="n">Index</th><th>Reference</th><th class="n">cp</th><th>Booked name</th><th>Kind</th><th class="n">Booked (KES)</th><th>Counterparty status</th></tr></thead><tbody>${un || '<tr><td colspan="7">none</td></tr>'}</tbody></table></div>
<h3>Disputes</h3>
<div class="scroll"><table><thead><tr><th class="n">Index</th><th>Reference</th><th class="n">Member</th><th>Kind</th><th class="n">Booked</th><th class="n">Member's figure</th><th>Reason</th><th>Evidence hash</th><th>At</th></tr></thead><tbody>${ds || '<tr><td colspan="9">none</td></tr>'}</tbody></table></div>
<h3>Concentration heuristic</h3>
<p class="warn">Pattern for supervisory follow-up, not evidence. Thresholds are assumptions (concentration.json).</p>
<div class="scroll"><table><thead><tr><th class="n">Member</th><th>Rules</th><th>Details</th></tr></thead><tbody>${cf || '<tr><td colspan="3">none</td></tr>'}</tbody></table></div>
<h3>Overdue streaks</h3><p>${p.overdue.map((o) => `member ${o.no}: ${o.streak}`).join(", ") || "none"}</p>`;
    })
    .join("\n");
  return page(
    `${apexName}: regulator view`,
    `<h1>${esc(apexName)}: regulator view</h1>
<p class="sub">Generated ${esc(isoTime(generatedAt))}. Contains the off-chain line mapping. Never publish this page.</p>
${CAVEAT}
${body}`,
  );
}

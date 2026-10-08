# Apex Confirm: demo

Everything below runs offline, from the project root, with the simulated seed in `data/seed/` and the
TEST keys in `data/seed/keys.test.json` (derived from public labels; never fund or reuse them).
Outputs are copied from runs in this environment. Nothing here touches a network.

## 0. Build and test

```bash
cargo test                       # apex_register: 46 passed; board_account: 8 passed (~5 min, mostly the property test)
stellar contract build           # target/wasm32v1-none/release/{apex_register,board_account}.wasm
cd app && npm ci && npm test     # 111 passed, offline
```

## 1. The whole journey: `apex simulate`

Two periods, 40 members (member 38 dormant and inactive), one custodian, every response from
`data/seed/responses-plan.json`, run through the offline model of the contract.

```bash
cd app && npm run build && node dist/src/cli.js simulate
```

```
registered 40 members (inactive: member 38) and 1 custodian
period 1: posted root over 159 lines (depth 8)
period 1: closed with coverage 7807 bps vs booked 10251 bps
period 2: apex stale since 1794819600; closed with coverage 3627 bps

period 1: coverage 7807 bps (78.07%) vs booked 10251 bps (102.51%)
  liabilities 2,510,500,000.00  cash 305,412,318.55  recognised loans 1,654,600,000.00
  booked loans 2,236,900,000.00  unconfirmed loans 427,300,000.00
  unresponded 10  disputed 3  late 8  omitted 1
  flags 111 = BELOW_ALERT | UNCONFIRMED_LOANS | DISPUTES | LATE_RESPONSES | OMITTED_CLAIMS | GAP_WIDE
  overdue flagged: 22; member 22 streak 1; apex stale: no
  concentration (pattern for supervisory follow-up, not evidence): member 37 rules i,iii

period 2: coverage 3627 bps (36.27%) vs booked 7831 bps (78.31%)
  liabilities 1,016,289,000.00  cash 298,774,905.10  recognised loans 69,860,000.00
  booked loans 497,160,000.00  unconfirmed loans 427,300,000.00
  unresponded 10  disputed 0  late 0  omitted 0
  flags 67 = BELOW_ALERT | UNCONFIRMED_LOANS | GAP_WIDE
  overdue flagged: 22; member 22 streak 2; apex stale: yes

known limitation: the colluding member's loan [105] was CONFIRMED and counted as recognised; confirmation cannot catch collusion.
```

How to read period 1:

- **The apex's books imply 102.51% coverage** (cash 305.4m + all booked loans 2,236.9m over deposits 2,480m).
- **Confirmed coverage is 78.07%.** Out of the booked loans: KES 480m of fictitious amounts (five loans
  to non-members 901–903 and dormant member 38 that nobody can confirm, plus the overstatement on the
  loans members 5 and 19 dispute), KES 57.3m unanswered by member 22, and KES 45m more than 90 days in
  arrears. Members 14 and 33 add KES 30.5m of deposits the apex under-booked or omitted, which raises
  liabilities to 2,510.5m.
- **Member 37's KES 48m insider loan is confirmed and counted.** This is the known limitation; the
  concentration heuristic points at member 37 as a pattern for follow-up, not as evidence.
- In period 2 the apex posts no root for 50 days after closing period 1, so `flag_stale_apex` fires,
  and member 22 is overdue for the second period running.

The same numbers are asserted in `data/seed/expected.json`, by `app/test/scenario.test.ts`, and by the
Rust `scenario_kuscco_pattern` test, which runs the same 159-line tree inside the Soroban host.

To write the trees, member packs, model state and the three page sets:

```bash
node dist/src/cli.js simulate --quiet --out ../var --web ../web
# ../web/public/index.html      ratios and flags only (no member-level amount; tested)
# ../web/member/<no>/index.html one member's lines, proof status and responses (tested)
# ../web/regulator/index.html   everything incl. the off-chain index-to-line mapping (gitignored)
```

## 2. One period, command by command: `scripts/demo-offline.sh`

```bash
cd .. && scripts/demo-offline.sh      # ~50 s; state in var/demo/
```

Output (paths shortened):

```
== registrar: init, 40 members (member 38 inactive), custodian
initialised: registrar GCWE6GEV2VVQSLERUF4GF76I64GO5BT3R4KNT6WZ7GHXPLN5FGHVL7MO, apex GA4XYVSRGAHY7BHMAZSYTT2TXJLYXTDW4USWMAX3EUHCHZOHAVPJQJQM
member 38 deactivated
custodian GA37HX743K2C765L3VSP7CQ53RVGRO4PSONTG3SMADL4NE6PV2YADF66 active
== apex: open, validate + build, post
opened period 1 for balance date 2026-08-31
error   line 104: DUPLICATE_REF line_ref APX/LN/2023/0649 already used on line 82
validation failed: 1 error(s) in ./data/seed/apex-book-2026-08-dirty.csv
built period 1: 159 lines, depth 8, root 3c76a653ceaafbc5...
  booked deposits KES 2,480,000,000.00, booked loans KES 2,236,900,000.00
  wrote ./var/demo/period-1/tree.json (private), root.json, packs/ (42 counterparties)
posted root for period 1; confirm by 2026-09-11T07:10:00Z, attest by 2026-09-06T07:10:00Z
== custodian: attest cash from the statement (day 3)
custodian attested KES 305,412,318.55 as of 2026-08-31 for period 1 (214 movements, 9 reversals)
== member 5: check the pack against its own ledger (proposals only)
member 5, period 1: 5 line(s); proofs all verify against the on-chain root
  [16] APX/LN/2024/0613 LOAN booked 25,570,000.00 arrears 10 proof=ok ours=25,570,000.00
  [20] APX/LN/2023/0614 LOAN booked 15,180,000.00 arrears 0 proof=ok ours=15,180,000.00
  [61] APX/DEP/0005-1 DEP  booked 105,420,000.70 arrears 0 proof=ok ours=105,420,000.70
  [72] APX/LN/2024/0158 LOAN booked 90,000,000.00 arrears 0 proof=ok ours=25,000,000.00
  [154] APX/LN/2023/0615 LOAN booked 19,180,000.64 arrears 0 proof=ok ours=19,180,000.64
proposals (the board decides; nothing has been signed):
  confirm      [16] APX/LN/2024/0613
  confirm      [20] APX/LN/2023/0614
  confirm      [61] APX/DEP/0005-1
  dispute      [72] APX/LN/2024/0158 claimed 25,000,000.00 arrears 0 reason BALANCE_WRONG: apex KES 90,000,000.00 vs ours KES 25,000,000.00
  confirm      [154] APX/LN/2023/0615
== member 5's board: confirm the four matching lines, dispute the overstated loan
member 5 confirmed 4 line(s) in period 1
member 5 disputed line 72: booked 90,000,000.00, ours 25,000,000.00 (BALANCE_WRONG)
== member 5 cannot confirm the same line twice
contract error: AlreadyResponded (#24)
(exit 3)
== member 33: claim the omitted deposit
member 33 claimed an omitted deposit of KES 12,000,000.00 in period 1
== registrar: verify the full salted file against the posted root
verify-tree: OK (159 lines recompute to the on-chain root)
== anyone: close before the window ends fails; after it, mark overdue and close
contract error: TooEarly (#32)
(exit 3)
watch: 37 member(s) newly flagged overdue; apex stale: no (current period 1: Posted)
period 1: coverage 1566 bps (15.66%) vs booked 10251 bps (102.51%)
  liabilities 2,492,000,000.00  cash 305,412,318.55  recognised loans 84,930,000.64
  booked loans 2,236,900,000.00  unconfirmed loans 2,086,969,999.36
  unresponded 154  disputed 1  late 0  omitted 1
  flags 103 = BELOW_ALERT | UNCONFIRMED_LOANS | DISPUTES | OMITTED_CLAIMS | GAP_WIDE
== pages
pages written to ./var/demo/web
```

Only member 5 and member 33 respond in this walkthrough, so 37 members are flagged overdue and almost
every loan is unconfirmed: coverage falls to 15.66%. That is the design working. Silence never counts as
confirmation.

Other things to try against `var/demo/`:

```bash
A="node app/dist/src/cli.js --offline --data-dir var/demo"
$A report --period 1 --as member:5          # member 5's own lines and statuses
$A report --period 1 --as regulator         # plus the off-chain mapping of unresponded indexes to lines
$A report --period 1 --json                 # public view as JSON
```

## 3. Live transactions without a network: `--dry-run`

```bash
APEX_REGISTER_CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM \
  node app/dist/src/cli.js close --period 1 --dry-run
# dry run: close_period(1 args) on CAAAA…D2KM
# AAAAAgAAAA…   (unsigned transaction envelope, base64 XDR)
```

## 4. Testnet (written, NOT executed here)

`scripts/deploy-testnet.sh` deploys `apex_register` and three `board_account` instances, inits the
register and registers three members and the custodian. `scripts/e2e-testnet.sh` then runs one period
with a 120-second window: open, build, post, a 2-of-3 board dispute and confirmations, custodian
attestation, close and `apex report --as public`. This environment could not reach Stellar testnet, so
neither script has been run and no output is shown.

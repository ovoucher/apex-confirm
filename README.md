# Apex Confirm

A per-period counterparty-confirmation register for a SACCO apex body, on Stellar Soroban.
The apex commits its book of member positions as a Merkle sum tree. Each member SACCO's
board confirms or disputes its own lines. The custodian bank attests the cash. The register
then publishes a coverage ratio that the regulator and every member can recompute without
trusting the apex.

> **Read this first.**
> - **A SASRA-run database would do most of this.** Bank-signed cash confirmations and
>   member SACCOs confirming their own lines through a regulator portal get most of the value.
> - **The ledger's only extra value** is that members can check the numbers, and that their own
>   confirmation was counted, without trusting the apex or SASRA.
> - **Collusion is not caught.** A loan booked to a member SACCO whose board colludes with the
>   apex is confirmed and counted. The concentration flag is a heuristic, not a control.
> - **Coverage is a floor, not solvency.** It counts only attested cash and confirmed performing loans.
> - All data in this repository is **simulated**. No SACCO, apex, bank or regulator has seen it.

## The problem

KUSCCO, the apex union that took surplus deposits from Kenyan SACCOs, lost KSh13.3bn to fraud;
PwC's forensic audit found it insolvent by KSh12.5bn, with KSh24.8bn of SACCO deposits at risk and
247 of 257 licensed deposit-taking SACCOs exposed. A deceased auditor's signature appeared on the
books. Members saw quarterly statements and the regulator saw returns, but neither could check the
apex's figures against anyone other than the apex and its auditor (sources in `VALIDATION.md`).

The failure was on the **asset side**: reported loans to dormant or fictitious societies, concealed
inter-departmental lending, cash that left as commissions. A proof that deposits are recorded
would have looked healthy. So this design tests the assets: **the borrowers confirm the loans and
the bank confirms the cash.**

**User:** the finance manager of a deposit-taking SACCO that places funds with, or borrows from, an
apex; the SACCO's board (2 of 3 officers) signs. Secondary readers: SASRA supervision staff, the
custodian bank's confirmation desk, and SACCO members who read the public ratio.

## What the MVP does

| Step | Who | Command | On-chain |
|---|---|---|---|
| Register members (board accounts) and custodians | registrar (never the apex) | `apex member add`, `apex custodian set` | `register_member`, `set_custodian` |
| Open a period for a balance date | apex | `apex open --as-of 2026-08-31` | `open_period` |
| Validate the book, build the salted, shuffled sum tree, write member packs | apex | `apex build` | – |
| Post the root (total deposits, total loans, leaf count, file hash) | apex | `apex post` | `post_root` |
| Check the pack against the SACCO's own ledger; the CLI **proposes**, the board decides | member | `apex check` | – |
| Confirm, dispute (claimed figure + reason) or claim an omitted deposit | member board (2-of-3 custom account) | `apex confirm`, `apex dispute`, `apex omitted` | `confirm[_batch]`, `dispute`, `claim_omitted` |
| Attest cash on the same balance date, with a statement hash | custodian | `apex attest` | `attest_cash` |
| Close and compute the report | anyone | `apex close` | `close_period` |
| Flag non-responders and a stalled apex | anyone | `apex watch` | `mark_overdue`, `flag_stale_apex` |
| Recompute the full file against the root | registrar / SASRA | `apex verify-tree` | – |
| Public, member and regulator pages | anyone / member / regulator | `apex pages`, `apex report --as …` | read functions |

**Coverage** = (attested cash + confirmed or acknowledged performing loans) / (posted deposits +
deposits members claim above the book). **Booked coverage** = (cash + all posted loans) / posted
deposits, which is what the apex's own books imply. Both in basis points, integer division.
See `docs/COVERAGE.md`.

In the seeded two-period journey the apex's books imply **10251 bps (102.5%)**; confirmed coverage is
**7807 bps (78.1%)**. Five fictitious loans to non-members and a dormant member stay unconfirmed,
two overstated loans are cut to the borrower's figure, one member does not respond and is flagged
overdue, and **the colluding member's KES 48m insider loan is confirmed and counted** (the known
limitation, asserted by a test). In period 2 the apex stops posting and the stale-apex flag fires.

## Quickstart

Rust 1.94, stellar-cli 28.0.0, Node 22 (see the monorepo `TOOLCHAIN.md`).

```bash
cargo test                          # both contracts, in the Soroban host (the property test takes ~4 min)
stellar contract build              # wasm32v1-none artifacts
cd app && npm ci && npm test        # offline TypeScript suite (node --test)
npm run build && node dist/src/cli.js simulate
node dist/src/cli.js simulate --quiet --out ../var --web ../web   # trees, packs, state and pages
cd .. && scripts/demo-offline.sh    # one period, command by command, offline
```

Every command runs `--offline` against a local model of the contract (`app/src/register/model.ts`,
checked error-for-error against the Rust tests) or live against a Soroban RPC configured in `.env`
(see `.env.example`). `--dry-run` builds the live transaction without sending it.
Exit codes: 0 ok, 1 usage, 2 validation failure, 3 contract error (the error name is printed).

## Layout

```
contracts/apex_register/   the register: roles, periods, Merkle-sum proofs, responses, cash, reports, flags
contracts/board_account/   M-of-N (default 2-of-3) Ed25519 custom account for a SACCO board
contracts/vectors/         JSON vectors shared by the Rust and TypeScript tests
app/                       `apex` CLI: book/statement parsers, tree builder, member check, offline model,
                           live client, coverage, concentration heuristic, static pages, seed generator
data/seed/                 simulated, messy seed: apex book (+ dirty copy), custodian statements,
                           40 member ledgers, response plan, expected.json, TEST keys
web/                       generated pages: public/ (ratios only), member/<no>/; regulator/ is gitignored
scripts/                   demo-offline.sh; deploy-testnet.sh and e2e-testnet.sh (NOT executed here)
docs/                      LEAF-FORMAT, COVERAGE, CONFIRMATION-PROCEDURE, REASON-CODES, THREAT-MODEL,
                           DATA-PROTECTION, NO-CHAIN-ALTERNATIVE
ARCHITECTURE.md  VALIDATION.md  DEMO.md  .env.example
```

## Status

**functional locally**: both contracts are executed in the Soroban host by `cargo test` (unit,
negative, auth, a real two-signature custom-account path, a 200-case property test and the seeded
scenario), the wasm builds, and the offline TypeScript suite passes. 

### Testnet Deployment
The smart contracts are currently deployed on the Stellar Testnet at the following addresses:
- **apex_register**: `CBZHXXMUDF7O7OMKMAXEWKC533P3PBV5FELNYB2KOLVJ7ZQJ74HSWE5H`
- **member 1 board_account**: `CBRWTIMNVDWHI62GEZUN3NKWJEDFLXXSFEYKXLHDGOHFN7FPNDW4YZMH`
- **member 2 board_account**: `CCUDW6TGEEREJJYU2DCLPM26BZBYLQJOSFVYSF5DWZGQWW3ODLZXBP3I`
- **member 3 board_account**: `CC2ACKFW73NZMUDAMRRBUOAJGLIPAZD74ZTSJ7PC7YAJ5F2ULE3JFED3`

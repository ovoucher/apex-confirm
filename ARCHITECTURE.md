# Apex Confirm: architecture

> **Caveat on the first screen.** A SASRA-run database fed by bank-signed cash confirmations and
> member SACCOs confirming their own lines would do most of what this register does. The ledger's
> only extra value is that members can check the ratio, and that their own confirmation was
> counted, without trusting the apex or SASRA. Collusion between the apex and a member board is
> not caught. Coverage is a floor, not solvency. See `docs/NO-CHAIN-ALTERNATIVE.md`.

## Verify-first items

| # | Item | Result in this build | Fallback if it had failed |
|---|---|---|---|
| (a) | Custom-account harness in soroban-sdk 28: `__check_auth(signature_payload: Hash<32>, signatures: Vec<Sig>, auth_contexts: Vec<Context>)` and `Env::try_invoke_contract_check_auth` | **Confirmed.** `board_account` tests call `try_invoke_contract_check_auth` with real Ed25519 signatures (8 tests). | Direct `__check_auth` call; register tests with `mock_auths` |
| (b) | Full real-signature auth path: a `SorobanAuthorizationEntry` signed by two board keys, passed with `env.set_auths`, authorising `apex_register.confirm` | **Confirmed** in the test host: `test/real_auth.rs` (below threshold, outsider, unsorted, wrong invocation and nonce replay all rejected; chair + secretary accepted). The TypeScript side builds the same entry with `authorizeEntry` (`app/src/register/client.ts`, unit-tested offline). The network path was **not** exercised. | Document as the one auth path not tested end to end |
| (c) | Per-transaction read/write entry limits bounding `confirm_batch` (cap 16) and `mark_overdue` (cap 25) | **Not verified** against current network settings (testnet unreachable). The caps are constants; the CLI splits larger work into several calls. | Lower the caps; the CLI already pages |
| (d) | The PwC findings behind the redesign table | **Open.** The table rests on search excerpts (`VALIDATION.md`). | Reword to "reported"; drop unsupported rows |
| (e) | OpenZeppelin `stellar-accounts` 0.7.2 with soroban-sdk 28 | **Not evaluated.** The in-house `board_account` (156 lines) stays. | – |

## Components

```
apex core banking ─► book CSV ─► validate ─► build sum tree (salted, shuffled)
                                               │            │
                     root.json ─► apex_register.post_root   ├─► tree.json ─► registrar/SASRA: verify-tree (full file)
                                               │            └─► packs/<member>.json ─► member SACCO
member core banking ─► ledger CSV ─► apex check (proof vs on-chain root, compare) ─► proposals
                                                  board (2-of-3 board_account) ─► confirm / dispute / claim_omitted
custodian bank statement ─► custodian key ─► attest_cash (same as_of)
                                               │
          anyone ─► close_period ─► Report {coverage, booked coverage, unconfirmed, flags} ─► events
          anyone ─► mark_overdue, flag_stale_apex (apex watch)
          registrar ─► register_member / set_custodian / rotate_board / set_apex   (never the apex)
          pages: public (ratios) · member (own lines) · regulator (full, off-chain mapping + concentration heuristic)
```

| Component | Path | Role |
|---|---|---|
| `apex_register` | `contracts/apex_register/src/lib.rs`, `merkle.rs` | One instance per apex body. Roles, member and custodian registry, period state machine, Merkle-sum proof verification, responses, cash attestations, omitted claims, reports, overdue and staleness flags, events. |
| `board_account` | `contracts/board_account/src/lib.rs` | M-of-N Ed25519 custom account (default 2-of-3). Signatures sorted ascending by key; unknown key, duplicate or unsorted order and below-threshold are rejected; an invalid signature traps. `rotate` needs the account's own quorum. Also usable by a custodian desk. |
| Book and statement parsers | `app/src/book/` | Apex book CSV (thousands separators, `KES` prefix, one-decimal amounts, blank lines), member ledger CSV, custodian statement CSV (opening/closing rows, reversals, value dates, decimal commas; must reconcile). |
| Validation | `app/src/book/validate.ts` | Errors (duplicate `line_ref`, negative balance, arrears on a deposit, bad kind) block the build; warnings (deposit to a non-member) and info (loan to a non-member or inactive member) are printed. |
| Tree | `app/src/tree/` | Leaf and node hashing byte-identical to `merkle.rs`, per-line HMAC salts, deterministic per-period shuffle, padding, proofs, member packs, `verifyTree` for the full file. |
| Member check | `app/src/member/check.ts` | Verifies each proof against the on-chain root, compares with the member's ledger and **proposes** confirm / dispute / claim-omitted / do-not-respond. Nothing is signed. |
| Offline model | `app/src/register/model.ts` | A TypeScript mirror of the contract, used by `--offline` and `simulate`; `model.test.ts` reproduces every contract error code. |
| Live client | `app/src/register/client.ts` | ScVal encoding of `#[contracttype]` structs, transaction building, board auth-entry signing, simulate/assemble/submit against an RPC. |
| Reports | `app/src/report/` | `coverage.ts` (same arithmetic as `compute_report`, checked against Rust vectors), flags, the concentration heuristic, public/member/regulator views. |
| Pages | `app/src/pages/pages.ts` | Static HTML: `web/public/` (ratios and flags only), `web/member/<no>/` (that member's lines), `web/regulator/` (everything; gitignored). |

## Contract interface (`apex_register`)

Registrar: `init`, `register_member(no, board, licence_hash)`, `set_member_active`, `rotate_board`,
`set_custodian(addr, active)` (at most 4 active), `set_apex`, `transfer_registrar`.
Apex: `open_period(as_of, supersedes) -> id`, `post_root(period, root, leaf_count, file_hash)`.
Member board: `confirm`, `confirm_batch` (≤ 16), `dispute(…, claimed, claimed_arrears_days, reason, evidence_hash)`,
`claim_omitted(period, member, claimed_deposit, evidence_hash)`.
Custodian: `attest_cash(period, custodian, balance, as_of, statement_hash)`.
Anyone: `close_period -> Report`, `mark_overdue(period, max ≤ 25)`, `flag_stale_apex`.
Reads: `config`, `member`, `member_by_board`, `member_count`, `custodians`, `current_period`, `period`,
`tally`, `report`, `latest_report`, `reports(from, to)` (≤ 24), `response`, `unresponded` (≤ 512 per page),
`disputes` (≤ 32), `cash`, `omitted`, `member_responses`, `apex_stale_since`.
Errors: 35 `#[contracterror]` codes, `AlreadyInitialised = 1` … `RangeTooLarge = 35`, mirrored in
`app/src/register/errors.ts`.

**Period state machine.** `Open` (after `open_period`; custodians are snapshotted here) → `Posted`
(after `post_root`; `confirm_by = posted_at + confirm_window`, `attest_by = posted_at + attest_window`)
→ `Closed` (after `close_period`, which needs an attestation from every custodian in the snapshot and
either `now ≥ confirm_by` or every line responded). The next period can open only after the previous one closed, with a strictly
later `as_of` that is not in the future. A wrong book cannot be replaced: the apex closes it and opens a
superseding period (`supersedes`), and both stay visible.

**A response is final.** A line can be answered once (confirm or dispute). There is no edit, no delete
and no admin override of a report.

## Roles, and why the registrar is not the apex

| Role | Who (intended) | Can | Cannot |
|---|---|---|---|
| Registrar | SASRA or a body it designates | admit/deactivate members, rotate boards, add/remove custodians, replace the apex key | post roots, respond, attest |
| Apex | the apex body's finance team | open periods, post roots | register members or custodians (tested: the apex cannot set a custodian) |
| Member board | 2-of-3 officers of a SACCO, as a `board_account` | respond to its own lines only (`NotYourLeaf`), claim omitted deposits | answer another member's line; an inactive member cannot respond |
| Custodian | the bank that holds the apex's accounts | attest cash for periods whose snapshot includes it | be the apex (`RoleConflict`) |
| Anyone | – | close, mark overdue, flag a stale apex, read | – |

If the apex could register members it could admit sock-puppet boards to confirm fictitious loans, and
if it could register custodians it could attest its own cash. Separating the registrar is the design's
main control. `init` rejects `registrar == apex`; a board address cannot be the apex, and a board
cannot be bound to two members.

## Trust assumptions

- **Registrar honesty.** The registrar admits only real, licensed SACCO boards and real custodians. A captured registrar can admit sock puppets.
- **Board care.** A board that confirms without checking gives a false confirmation. The procedure (`docs/CONFIRMATION-PROCEDURE.md`) and evidence hashes make it accountable, not impossible.
- **Custodian scope.** The custodian attests only the accounts it holds. Cash at other banks is invisible unless those banks are also registered custodians.
- **Coverage is a floor, not solvency.** Other assets are excluded by design.
- **Collusion is not caught.** The seeded scenario asserts that the colluding loan passes.
- **On-chain data.** Amounts of responded lines, counterparty numbers and ratios are public (`docs/DATA-PROTECTION.md`).
- **The full file is checked by someone.** A hidden negative leaf in a subtree no member verifies is caught only by `verify-tree` on the full file (`docs/THREAT-MODEL.md`).

## Limits

- **4096 lines per period** (tree depth ≤ 12). Larger books would need several registers or a deeper tree.
- **Public amounts for responded lines.** Responses store booked and claimed amounts; sum-tree proofs reveal subtree sums to the member.
- **State archival.** Persistent entries are extended to the network maximum TTL on every write, but an entry nobody touches will eventually be archived and must be restored before it can be read. Old periods need a restore-and-extend job (not built).
- **RPC retention.** Soroban RPC keeps events for a short window (days, per network settings), so the CLI and pages read state through view functions rather than rebuilding history from events. A long-term index would need an archiver.
- **No cron.** Nothing on-chain runs by itself: `apex watch` (`mark_overdue` pages, `flag_stale_apex`) must be run by someone, for example the registrar or any member. Live `watch` pages `mark_overdue` assuming member numbers are dense (1..N).
- **Batch caps** of 16 responses and 25 overdue checks per call, unverified against current network limits (verify-first (c)).
- **Board auth on testnet** uses `board_account`; a classic multisig account would also work with `require_auth`, but was not tested.
- **`board_account.init` has no auth.** It must run right after deploy; the registrar checks `signers()` before `register_member` (`docs/THREAT-MODEL.md`).
- Fee sponsorship (OpenZeppelin Relayer Channels) is documented, not built: in this MVP a `SOURCE_SECRET` fee payer submits board-signed transactions.

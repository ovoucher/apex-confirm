# Threat model

Assets protected: the integrity of the coverage ratio and of each member's record of what it confirmed.
Out of scope: the confidentiality of responded amounts (see `DATA-PROTECTION.md`), dispute resolution,
and anything the custodian bank does not hold.

| Threat | What stops it | What does not | Test / evidence |
|---|---|---|---|
| **Fictitious loans to non-members or dormant societies** | Only a registered, active member's board can confirm a line with its `cp`; non-member and inactive-member lines stay unconfirmed and out of coverage, and the regulator page maps them to line references | – | scenario: L-F1–F5 unconfirmed; `NotYourLeaf`, `MemberInactive` tests |
| **Overstated loan balance** | The borrower disputes with its figure; only `min(claimed, booked)` counts | a borrower that confirms without checking | scenario: members 5 and 19 |
| **Sock-puppet member** (apex creates a fake SACCO to confirm fake loans) | Only the registrar registers boards; the apex cannot (`register_member` needs registrar auth); licence numbers are hashed per member | a captured or careless registrar | auth tests; `RoleConflict` for the apex as a board |
| **Sock-puppet custodian** (apex attests its own cash) | Only the registrar sets custodians; the apex cannot be one (`RoleConflict`); custodians are snapshotted when a period opens, so one added later cannot attest it (`NotCustodian`) | a captured registrar; a bank that attests carelessly | "the apex cannot set a custodian" test |
| **Collusion** (insider loan booked to a colluding member whose board confirms it) | **Nothing on-chain.** The off-chain concentration heuristic (loans > 3× the member's deposits, one loan > 5% of the book, a recent large loan) flags a pattern for supervisory follow-up | the heuristic is weak and uncalibrated; small insider loans pass | scenario asserts the colluding loan is confirmed and counted; member 37 flagged by rule (i) |
| **Hidden negative leaf / omitted liability** (a subtree no member checks contains a negative deposit or loan that lowers the root sums) | Proof verification rejects negative sibling sums on every checked path; `verify-tree` on the full file rejects any negative leaf, duplicate reference or root mismatch; an omitted deposit is caught if its owner files `claim_omitted` | if the registrar/SASRA never runs `verify-tree` and the affected member stays silent, it goes unnoticed | `verifyTree.test.ts` injects a negative leaf under a non-member that no proof touches |
| **Stalling apex** (stops posting after a bad period) | `flag_stale_apex` (anyone) sets `apex_stale_since` once `max_period_gap_secs` (45 days) pass with no open or unposted period; the public page shows it | no cron: someone must call it | Rust and TS tests; scenario period 2 |
| **Apex never closes** | `close_period` is permissionless once `confirm_by` passes | – | – |
| **Custodian refuses to attest** | `close_period` fails with `CustodianMissing`; the period stays visibly open | the product stalls by design; the registrar can only change custodians for the next period | `CustodianMissing` test |
| **Non-responding member** | `mark_overdue` flags every active member with no response and no omitted claim; its lines stay out of coverage; the streak is kept | a member that never responds keeps coverage low, which is the intended signal | scenario: member 22 streak 2 |
| **Rushed board** (confirms without checking) | 2-of-3 signing, the draft procedure, evidence hashes and permanence make a false confirmation attributable | nothing prevents it | – |
| **Board key loss or compromise** | The registrar calls `rotate_board`; the old account fails auth immediately; a board can also `rotate` its own officer set with its quorum | responses already made stay recorded with timestamps | rotate tests (both contracts) |
| **Board account front-run at deploy** | `board_account.init` has no auth; the deploy script inits in the same run, and the registrar reads `signers()` and checks the officer keys before `register_member` | a registrar that skips the check | `scripts/deploy-testnet.sh` |
| **Replay of a response or of a signed authorisation** | one response per line (`AlreadyResponded`); host nonces reject a reused authorisation entry; leaves carry the period (`WrongPeriod`) | – | `real_auth.rs` replays a signed entry |
| **Wrong book posted** | Roots are immutable; the apex closes and opens a superseding period; both remain visible | – | `BadSupersedes` test |
| **Brute-forcing other members' lines from proofs** | per-line HMAC salts that are never published; `line_ref` is hashed | a member sees sibling **sums** in its proofs (`DATA-PROTECTION.md`) | – |
| **Overflow in crafted trees** | all sums are checked `i128` additions returning `Overflow`, never a panic | – | overflow tests (Rust, TS) |

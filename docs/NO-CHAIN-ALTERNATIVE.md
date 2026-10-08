# The no-chain alternative

The review panel's refutation, accepted: **SASRA could run all of this as a database.**

## How SASRA would run it

1. SASRA's shared platform stores each apex's per-period root (or the whole line file) submitted through
   an authenticated upload.
2. Member SACCOs log into SASRA's portal, see their own lines and confirm or dispute them. Two officers
   approve in the portal (maker-checker) instead of signing with keys.
3. The custodian bank sends a signed balance confirmation (as for an audit confirmation under ISA 505) to
   SASRA directly.
4. SASRA's system computes the same coverage formula (`COVERAGE.md`), flags non-responders and stale apexes
   on a schedule (a real cron, which the chain lacks), and publishes the ratio.

The leaf format, sum tree, member packs, `verify-tree`, the coverage formula, the reason codes and the
board procedure all carry over unchanged. This repository's TypeScript model (`app/src/register/model.ts`)
is effectively that database's business logic.

## What SASRA gains by not using a chain

- No keys for boards or banks to manage; ordinary portal logins and bank messaging.
- Private data by default: amounts need not be public.
- Scheduling, archival, reporting and corrections are ordinary operations.
- One fewer technology to explain to boards, auditors and courts.

## What it loses

- **Members must trust the operator.** In a database, whoever runs it can edit or delete a posted root, a
  dispute or a report, or delay a close, and members cannot tell. On the register, nobody can: each member
  can recompute the ratio and see that its own confirmation was counted.
- **The operator is also a party that can fail.** SASRA's supervision did not catch KUSCCO for years
  (Researched: 10-R9, 03-G4). A register that members can check without trusting SASRA keeps working as a
  signal even if supervision is slow or captured.
- **No neutral operator for a group of SACCOs** that wants the discipline before, or without, a mandate.

## Which to choose

If SASRA will build and mandate it, the right product is the **open standard and reference
implementation** (leaf format, formula, procedure, vectors) adopted into SASRA's platform, with the chain as
an optional independence layer. The chain is worth its cost only if members and SASRA value independence
from each other; that is a validation question (`VALIDATION.md`, killer question 7), not a given.

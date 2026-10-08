# Board confirmation procedure (DRAFT)

> **Draft for SACCOs to adapt. Not legal, audit or regulatory advice.** It has not been reviewed by a
> SACCO board, an auditor or SASRA. SACCO by-laws on signing authority were not researched; the 2-of-3
> structure is an assumption.

## Roles

| Role | Who | Does |
|---|---|---|
| Preparer | Finance manager | Receives the pack, runs the check, prepares the proposal and the evidence file |
| Reviewer | Internal auditor or a second finance officer (if any) | Re-performs the ledger comparison for a sample and all proposed disputes |
| Signers | Two of the three designated officers (e.g. chair, treasurer, secretary) | Decide and sign; at least one signer must not be the preparer |

## Each period

1. **Receive** `packs/<member>.json` from the apex and note the date received. The balance date (`as_of`)
   and period id are in the pack.
2. **Export** the SACCO's own positions with the apex at the same balance date from core banking, as
   `line_ref,kind,balance_kes,arrears_days` (one row per deposit account and per loan).
3. **Check.** `apex check --member <no> --pack <pack.json> --ledger <ledger.csv>`. It verifies every
   line's proof against the root posted on-chain and compares each line with the ledger. If any proof
   fails, **do not respond**: tell the registrar; the pack was altered or the root is wrong.
4. **Reconcile differences** before proposing a dispute: timing (value dates around the balance date),
   interest capitalised on the balance date, fees, reversals. Record the reconciliation.
5. **Prepare the evidence file** for each dispute and omitted claim: ledger extract, statements from the
   apex, correspondence. Compute its hash (`sha256sum file`). Keep the file for at least the retention
   period the regulator sets; only the hash goes on-chain.
6. **Board decision.** Present the proposals (confirm / dispute with our figure and reason / claim omitted)
   to the signers with the reconciliation. The CLI proposes; the board decides. Record the decision in minutes.
7. **Sign and submit** before `confirm_by` (10 days after posting in the default configuration). Two
   officers sign the authorisation; the platform's fee payer submits. Responses cannot be withdrawn.
8. **After close**, compare the member page (`web/member/<no>/`) with what was signed, and read the public
   ratio. Raise disputes with the apex directly and escalate to SASRA; the register only records them.

## Rules of thumb

- Confirm only what the ledger supports. A confirmation that later proves wrong cannot be undone; file a
  note with the registrar and correct it in the next period.
- `NOT_OURS` with a claim of 0 for any loan the SACCO never took.
- If the SACCO holds nothing with the apex, file an omitted claim of 0 so it is not flagged overdue.
- Never share officer keys; the registrar rotates the board account after an officer changes or a key is lost.
- A board that is asked by the apex to confirm a line it cannot support should dispute it and tell the registrar.

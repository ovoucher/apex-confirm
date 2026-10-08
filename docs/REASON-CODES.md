# Dispute reason codes

A dispute records the member's own figure (`claimed`, KES cents), its own arrears view
(`claimed_arrears_days`), a reason code and an `evidence_hash` (SHA-256 of a document the board keeps;
the document is never uploaded). The register records disputes; it does not resolve them.

| Code | Name | Use when | Claim rules | Effect on coverage |
|---|---|---|---|---|
| 0 | `NONE` | never valid in a dispute (reserved for confirmations) | – | `BadReason` |
| 1 | `BALANCE_WRONG` | the line is ours but the balance differs from our ledger | `claimed ≥ 0`, and the claim must differ from the booked balance or arrears (`NotADispute`) | loan: `min(claimed, booked)` counts if `claimed_arrears_days ≤ 90`; deposit: any excess over booked raises liabilities |
| 2 | `NOT_OURS` | we do not recognise this line at all | `claimed` must be **0** (`BadClaim` otherwise) | loan: nothing is recognised; deposit: nothing added |
| 3 | `ARREARS_WRONG` | the balance matches but the arrears days differ | `claimed` is normally the booked balance; `claimed_arrears_days` is ours | loan: counts only if our arrears ≤ 90 days |
| 4 | `OTHER` | anything else (wrong counterparty name, product, terms); explain in the evidence document | as `BALANCE_WRONG` | as `BALANCE_WRONG` |
| ≥ 5 | – | invalid | – | `BadReason` |

Rules that apply to every response:

- One response per line, ever (`AlreadyResponded`): a line cannot be confirmed twice or confirmed and then disputed.
- Only the counterparty's own board can respond (`NotYourLeaf`), and only while the member is active.
- A response after `confirm_by` is accepted but stored as `late` and raises `LATE_RESPONSES`.

**Omitted deposit** is not a dispute: when the member holds a deposit with the apex that has no line in
its pack, its board calls `claim_omitted(period, member, claimed_deposit, evidence_hash)` once per period.
The claim raises liabilities by `claimed_deposit`. A claim of 0 is valid and counts as the member's
response for `mark_overdue` (useful for a member that holds nothing with the apex).

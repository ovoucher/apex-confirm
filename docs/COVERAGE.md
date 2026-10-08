# Coverage: formulas, what it is not, worked example

All arithmetic is integer. Amounts are KES cents (`i128` on-chain, `bigint` off-chain). Ratios are basis
points (10000 = 100%) with integer division rounding down. The contract's `compute_report` and
`app/src/report/coverage.ts` are the same arithmetic, checked against each other by vectors.

## Inputs

- From the root: `root.dep` (booked deposit liabilities), `root.loan` (booked loans), `leaf_count`.
- From responses, accumulated in the period's `Tally`:
  - a **confirmed loan** adds its booked balance to `confirmed_loans`, and to `recognised_loans` if
    `arrears_days ≤ performing_max_days` (90);
  - a **disputed loan** adds its booked balance to `disputed_loans_booked` and `ack = min(claimed, booked)`
    to `disputed_loans_ack`, and `ack` to `recognised_loans` if the member's `claimed_arrears_days ≤ 90`.
    A member can reduce a loan, never raise it;
  - a **disputed deposit** above the booked figure adds `claimed − booked` to `deposit_uplift`; below adds nothing;
  - an **omitted-deposit claim** adds `claimed` to `deposit_uplift`;
  - **cash** is the sum of custodian attestations for the period.

## Formulas

```
liabilities         = root.dep + deposit_uplift
coverage_bps        = (cash + recognised_loans) × 10000 / liabilities        (−1 if liabilities ≤ 0)
booked_coverage_bps = (cash + root.loan)        × 10000 / root.dep           (−1 if root.dep ≤ 0)
unconfirmed_loans   = root.loan − confirmed_loans − disputed_loans_booked    (booked loans nobody answered)
unresponded         = leaf_count − responded
```

Flags (bitmask, same values on-chain and off-chain):

| Bit | Flag | Condition |
|---|---|---|
| 1 | `BELOW_ALERT` | liabilities > 0 and `coverage_bps < alert_bps` (seed: 10000) |
| 2 | `UNCONFIRMED_LOANS` | `unconfirmed_loans > 0` |
| 4 | `DISPUTES` | at least one dispute |
| 8 | `LATE_RESPONSES` | at least one response after `confirm_by` |
| 16 | `CUSTODIAN_LATE` | an attestation after `attest_by` |
| 32 | `OMITTED_CLAIMS` | at least one omitted-deposit claim |
| 64 | `GAP_WIDE` | `booked_coverage_bps − coverage_bps ≥ 1000` |
| 128 | `NO_LIABILITIES` | liabilities ≤ 0 or `root.dep ≤ 0` (ratios are −1) |

## What coverage is not

- **Not solvency.** Only attested cash and confirmed performing loans count. Property, securities,
  receivables from non-members, and cash at banks that are not registered custodians are all excluded,
  unless a second custodian attests them. A solvent apex with large other assets will show low coverage.
- **Not proof that a loan is good.** A confirmation means the borrower acknowledges the balance and
  arrears, nothing about its ability to repay after the balance date.
- **Not protection against collusion.** A board that colludes with the apex confirms a fictitious loan and
  it counts.
- **Not a judgement on disputes.** A dispute lowers recognised loans to the member's figure; who is right
  is for the apex, the member, SASRA or a court.
- **Not complete for unresponded lines.** An unconfirmed loan may be real and merely late. It is excluded
  until someone answers for it.

## Worked example (the 7-line test in the contract and `model.test.ts`)

Book: deposits 1,000,000 (m1), 500,000 (m2), 250,000 (m3); loans 400,000 (m1, 0 days), 300,000 (m2,
120 days), 200,000 (m3, 10 days), 100,000 (m2, 0 days). Cash attested: 600,000. All KES.

| Response | Effect |
|---|---|
| m1 confirms deposit 1,000,000 and loan 400,000 | recognised +400,000 |
| m2 confirms deposit 500,000 and loan 300,000 (120 days) | confirmed, but non-performing: recognised +0 |
| m3 disputes loan 200,000, claims 150,000 at 10 days | recognised +150,000 |
| m3 disputes deposit 250,000, claims 280,000 | deposit_uplift +30,000 |
| m2's 100,000 loan: no response | unconfirmed 100,000 |

```
liabilities         = 1,750,000 + 30,000                         = 1,780,000
coverage_bps        = (600,000 + 550,000) × 10000 / 1,780,000     = 6460
booked_coverage_bps = (600,000 + 1,000,000) × 10000 / 1,750,000   = 9142
unconfirmed_loans   = 1,000,000 − 700,000 − 200,000               = 100,000
flags               = BELOW_ALERT | UNCONFIRMED_LOANS | DISPUTES | GAP_WIDE
```

The seeded journey (`DEMO.md`) gives 7807 vs 10251 bps on a 159-line book.

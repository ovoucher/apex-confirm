# Leaf and node format (v1)

The tree is a binary Merkle **sum** tree: every node carries a SHA-256 hash, a deposit sum and a loan
sum. The contract (`contracts/apex_register/src/merkle.rs`) and the CLI (`app/src/tree/`) implement the
same bytes; both test suites read the shared vectors in `contracts/vectors/`.

## Encoding rules

- `u32`: 4 bytes big-endian. `i128`: 16 bytes big-endian two's complement (Rust `to_be_bytes`).
- Tags are ASCII bytes with no length prefix or terminator.
- `‖` is concatenation. `sha256` is the Soroban host function / Node `crypto`.

## Leaf

```
leaf_hash = sha256("APEX-LEAF-v1" ‖ period:u32 ‖ index:u32 ‖ cp:u32 ‖ kind:u32
                   ‖ line_ref:32 ‖ balance:i128 ‖ arrears_days:u32 ‖ salt:32)       (112 bytes hashed)
leaf node = { hash: leaf_hash, dep: kind==1 ? balance : 0, loan: kind==2 ? balance : 0 }
```

| Field | Meaning |
|---|---|
| `period` | register period id; a leaf cannot be replayed into another period (`WrongPeriod`) |
| `index` | position in the shuffled tree, `0 ≤ index < leaf_count` (`BadIndex`); the proof path is derived from it |
| `cp` | counterparty number: a registrar member number (1–1024) or an apex-internal number for non-members (e.g. 901) |
| `kind` | `1` = deposit the apex holds for the member (a liability), `2` = loan the apex made (an asset) |
| `line_ref` | `sha256(trim(apex account / loan number))`, so the on-chain leaf does not show the reference |
| `balance` | KES cents; must be ≥ 0 |
| `arrears_days` | days in arrears for loans; 0 for deposits |
| `salt` | `HMAC-SHA256(APEX_SALT_KEY, period:u32 ‖ trim(line_ref))`; never published, delivered only in the member's own pack and the regulator's full file, so leaves cannot be brute-forced from public sums |

## Padding and parents

```
depth       = ceil(log2(max(leaf_count, 2)))          1 ≤ leaf_count ≤ 4096, so depth ≤ 12
empty leaf  = { hash: sha256("APEX-EMPTY-v1" ‖ period:u32 ‖ index:u32), dep: 0, loan: 0 }   for index ≥ leaf_count
parent(L,R) = { hash: sha256("APEX-NODE-v1" ‖ L.hash ‖ L.dep:i128 ‖ L.loan:i128 ‖ R.hash ‖ R.dep:i128 ‖ R.loan:i128),
                dep:  L.dep + R.dep,  loan: L.loan + R.loan }        (checked; overflow → `Overflow`)
```

The root's `dep` is the period's total deposit liabilities and its `loan` the total booked loans.
A proof is the list of sibling nodes from the leaf level up (exactly `depth` of them). At level `k` the
node is a left child when bit `k` of `index` is 0. Verification rejects any sibling with a negative sum
(`NegativeSum`), a wrong length or a root mismatch (`BadProof`).

## Ordering and file hash

- Lines are shuffled before indexing with a deterministic Fisher–Yates driven by
  `sha256("APEX-SHUFFLE-v1" ‖ period:u32 ‖ APEX_SALT_KEY)` as a counter stream, so index order does not
  reveal the book's order and the apex can reproduce it.
- `file_hash` posted with the root = `sha256(canonical JSON of the leaf list)`; `verify-tree` checks it.

## Vectors

`contracts/vectors/tree5.json` (period 7, five leaves, depth 3, three padding leaves):

| | value |
|---|---|
| leaf 0 | `APX/DEP/0003-1`, cp 3, kind 1, balance 6125000000 → `leaf_hash 7332b956…1158c449` |
| leaf 1 | `APX/LN/2024/0611`, balance 1840000050 → `leaf_hash 38d90f3c…1796a821d` |
| padding index 5 | `fa19245e…c4be3d2e`, sums 0 |
| root | `fa07b093…9f44ff075c`, dep 6125000001, loan 12839000050 |

Also in `contracts/vectors/`: `tree1.json` (one leaf, depth 1), `seed-period-1.json` and
`seed-period-2.json` (the 159-line and September seed trees the Rust scenario reads), and
`coverage.json` (reports exported by the Rust property test, re-checked by `coverage.test.ts`).

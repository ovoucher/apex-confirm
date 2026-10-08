# Data protection

**What is public on the ledger.** Anyone can read, for every period: the root (total booked deposits and
total booked loans), leaf count and file hash; every **response** (line index, member number, kind,
booked amount, claimed amount, arrears days, reason, evidence hash, time, late flag); cash attestations
(balance, date, statement hash); omitted-deposit claims (amount); reports, flags and overdue streaks.

**Responded amounts are linkable to a member.** A response carries the member number, and the member
number is bound on-chain to a registered board account. Anyone who knows which SACCO holds member number
14 can read its confirmed apex balances. Members must agree to this before joining (killer question 2 in
`VALIDATION.md`).

**What is not on the ledger.**
- No personal data. Counterparties are SACCOs identified by member number only; individual SACCO members'
  accounts never touch the register. Licence numbers are stored as salted hashes.
- Line references appear only as `sha256` hashes inside leaves; the readable reference is in the member's
  pack and the regulator's full file.
- Unresponded lines are invisible except as an index: mapping an index to a line needs the full salted
  tree, which only the apex and the registrar hold (the regulator page, which is gitignored and never
  published).
- Evidence documents are hashed locally; only the hash is posted.

**What a member learns from its own pack.** A sum-tree proof reveals each sibling node's deposit and
loan **sums**. A member therefore learns the total of the subtrees next to its line, and with a line
near a small subtree it can infer another counterparty's balance. The shuffle and the salts stop a member
from identifying whose balance it is, not the amount. This is inherent in Merkle sum trees.

**The ZK upgrade path (not in the MVP).** Soroban's BN254 and Poseidon host functions would allow
commitments to balances with range proofs (non-negative leaves) and a proof that the posted totals equal
the committed sums, so responses and proofs could hide individual amounts while the ratio stays
verifiable. This needs circuit work, audits and a new leaf format (v2); none of it is built.

**Retention.** The apex keeps the full salted tree per period and delivers it to the registrar. How long it
must be kept is for SASRA's rules (unknown).

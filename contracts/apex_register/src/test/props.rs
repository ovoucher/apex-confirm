//! Property test without extra crates: a seeded xorshift drives 200 cases. Each case builds
//! a random tree of 1-300 lines (random kinds, balances up to 10^14 cents, arrears and
//! counterparties, some unregistered, some members inactive) and applies a random sequence
//! of confirm, dispute, omitted claim, attestation, time advance and close. An independent
//! tally kept by the test must match the contract's, and the invariants below must hold.
//! Reports of the first cases are exported to `contracts/vectors/coverage.json` for the
//! TypeScript `coverage.ts` test.
extern crate std;

use super::util::*;
use crate::merkle;
use crate::*;
use soroban_sdk::testutils::Ledger as _;
use std::collections::BTreeSet;
use std::format;
use std::string::String;

struct XorShift(u64);
impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.below(hi - lo + 1)
    }
}

const MEMBERS: u32 = 12;
const EXPORT_CASES: usize = 60;

#[derive(Default, Clone, PartialEq, Debug)]
struct Expect {
    confirmed_dep: i128,
    confirmed_loans: i128,
    recognised: i128,
    disputed_booked: i128,
    disputed_ack: i128,
    uplift: i128,
    disputes: u32,
    omitted: u32,
    responded: u32,
    cash: i128,
}

fn tally_json(t: &Tally) -> String {
    format!(
        "{{\"responded\":{},\"late\":{},\"confirmed_dep\":\"{}\",\"confirmed_loans\":\"{}\",\"recognised_loans\":\"{}\",\"disputed_loans_booked\":\"{}\",\"disputed_loans_ack\":\"{}\",\"disputed_count\":{},\"deposit_uplift\":\"{}\",\"omitted_count\":{},\"cash\":\"{}\",\"cash_count\":{},\"cash_late\":{}}}",
        t.responded, t.late, t.confirmed_dep, t.confirmed_loans, t.recognised_loans, t.disputed_loans_booked, t.disputed_loans_ack,
        t.disputed_count, t.deposit_uplift, t.omitted_count, t.cash, t.cash_count, t.cash_late
    )
}

fn report_json(r: &Report) -> String {
    format!(
        "{{\"period\":{},\"liabilities\":\"{}\",\"cash\":\"{}\",\"recognised_loans\":\"{}\",\"booked_loans\":\"{}\",\"unconfirmed_loans\":\"{}\",\"coverage_bps\":\"{}\",\"booked_coverage_bps\":\"{}\",\"unresponded\":{},\"disputed\":{},\"late\":{},\"omitted\":{},\"flags\":{},\"closed_at\":{}}}",
        r.period, r.liabilities, r.cash, r.recognised_loans, r.booked_loans, r.unconfirmed_loans, r.coverage_bps,
        r.booked_coverage_bps, r.unresponded, r.disputed, r.late, r.omitted, r.flags, r.closed_at
    )
}

#[test]
fn property_random_trees_and_response_sequences() {
    let mut rng = XorShift(0x0A9E_C0F1_2026_0924);
    let mut exported: std::vec::Vec<String> = std::vec::Vec::new();

    for case in 0..200usize {
        let w = World::new(MEMBERS);
        let e = &w.env;
        // some members inactive
        let mut inactive = BTreeSet::new();
        for _ in 0..rng.below(3) {
            let no = rng.range(1, MEMBERS as u64) as u32;
            inactive.insert(no);
        }
        for no in &inactive {
            w.c.set_member_active(no, &false);
        }
        // random tree; counterparties 1..=15 (13-15 unregistered)
        let n = rng.range(1, 300) as usize;
        let mut lines = std::vec::Vec::new();
        for _ in 0..n {
            let cp = rng.range(1, 15) as u32;
            let bal = (rng.next() % 100_000_000_000_000) as i128; // up to 10^14 cents
            let arrears = if rng.below(4) == 0 {
                rng.range(0, 200) as u32
            } else {
                0
            };
            if rng.below(2) == 0 {
                lines.push(dep(cp, bal));
            } else {
                lines.push(loan(cp, bal, arrears));
            }
        }
        let t = Tree::build(e, 1, &lines);
        let cash = (rng.next() % 100_000_000_000_000) as i128;
        w.at(T_OPEN);
        let p = w.c.open_period(&AS_OF_AUG, &0);
        let attest_early = rng.below(2) == 0;
        if attest_early {
            w.c.attest_cash(&p, &w.custodian, &cash, &AS_OF_AUG, &zero32(e));
        }
        w.c.post_root(&p, &t.root(), &(n as u32), &zero32(e));
        let root = t.root();

        let can_respond = |cp: u32| cp <= MEMBERS && !inactive.contains(&cp);
        let mut ex = Expect::default();
        let mut responded: BTreeSet<u32> = BTreeSet::new();
        let mut omitted: BTreeSet<u32> = BTreeSet::new();
        let mut closed = false;
        let mut attested = attest_early;
        let mut frozen: Option<Report> = None;

        let steps = rng.range(1, (n as u64).min(80) + 10);
        for _ in 0..steps {
            let op = rng.below(100);
            let i = rng.below(n as u64) as u32;
            let leaf = t.leaf(i);
            if op < 45 {
                // confirm
                let r = w.c.try_confirm(&p, &leaf.cp, &leaf, &t.proof(i));
                if closed {
                    assert_eq!(r, Err(Ok(Error::BadState)));
                } else if leaf.cp > MEMBERS {
                    assert_eq!(r, Err(Ok(Error::UnknownMember)));
                } else if inactive.contains(&leaf.cp) {
                    assert_eq!(r, Err(Ok(Error::MemberInactive)));
                } else if responded.contains(&i) {
                    assert_eq!(r, Err(Ok(Error::AlreadyResponded)));
                } else {
                    assert_eq!(r, Ok(Ok(())));
                    responded.insert(i);
                    ex.responded += 1;
                    if leaf.kind == KIND_DEPOSIT {
                        ex.confirmed_dep += leaf.balance;
                    } else {
                        ex.confirmed_loans += leaf.balance;
                        if leaf.arrears_days <= PERFORMING_MAX_DAYS {
                            ex.recognised += leaf.balance;
                        }
                    }
                }
            } else if op < 65 {
                // dispute
                let reason = rng.range(1, 4) as u32;
                let mut claimed = if leaf.balance > 0 {
                    (rng.next() as i128) % (leaf.balance * 2 + 1)
                } else {
                    rng.range(0, 5) as i128
                };
                if reason == REASON_NOT_OURS {
                    claimed = 0;
                }
                let carr = if rng.below(3) == 0 {
                    rng.range(0, 200) as u32
                } else {
                    leaf.arrears_days
                };
                let r = w.c.try_dispute(
                    &p,
                    &leaf.cp,
                    &leaf,
                    &t.proof(i),
                    &claimed,
                    &carr,
                    &reason,
                    &zero32(e),
                );
                if closed {
                    assert_eq!(r, Err(Ok(Error::BadState)));
                } else if !can_respond(leaf.cp) {
                    assert!(r.is_err());
                } else if responded.contains(&i) {
                    assert_eq!(r, Err(Ok(Error::AlreadyResponded)));
                } else if claimed == leaf.balance && carr == leaf.arrears_days {
                    assert_eq!(r, Err(Ok(Error::NotADispute)));
                } else {
                    assert_eq!(r, Ok(Ok(())));
                    responded.insert(i);
                    ex.responded += 1;
                    ex.disputes += 1;
                    if leaf.kind == KIND_LOAN {
                        let ack = claimed.min(leaf.balance);
                        ex.disputed_booked += leaf.balance;
                        ex.disputed_ack += ack;
                        if carr <= PERFORMING_MAX_DAYS {
                            ex.recognised += ack;
                        }
                    } else if claimed > leaf.balance {
                        ex.uplift += claimed - leaf.balance;
                    }
                }
            } else if op < 72 {
                // wrong member for this leaf
                let other = rng.range(1, MEMBERS as u64) as u32;
                if other != leaf.cp && can_respond(other) && !closed {
                    assert_eq!(
                        w.c.try_confirm(&p, &other, &leaf, &t.proof(i)),
                        Err(Ok(Error::NotYourLeaf))
                    );
                }
            } else if op < 78 {
                // omitted claim
                let no = rng.range(1, MEMBERS as u64) as u32;
                let amt = (rng.next() % 1_000_000_000_000) as i128;
                let r = w.c.try_claim_omitted(&p, &no, &amt, &zero32(e));
                if closed {
                    assert_eq!(r, Err(Ok(Error::BadState)));
                } else if inactive.contains(&no) {
                    assert_eq!(r, Err(Ok(Error::MemberInactive)));
                } else if omitted.contains(&no) {
                    assert_eq!(r, Err(Ok(Error::AlreadyClaimed)));
                } else {
                    assert_eq!(r, Ok(Ok(())));
                    omitted.insert(no);
                    ex.omitted += 1;
                    ex.uplift += amt;
                }
            } else if op < 83 {
                // attestation
                let r =
                    w.c.try_attest_cash(&p, &w.custodian, &cash, &AS_OF_AUG, &zero32(e));
                if closed {
                    assert_eq!(r, Err(Ok(Error::BadState)));
                } else if attested {
                    assert_eq!(r, Err(Ok(Error::AlreadyAttested)));
                } else {
                    assert_eq!(r, Ok(Ok(())));
                    attested = true;
                }
            } else if op < 93 {
                // advance time by up to 3 days
                let now = w.now();
                w.env.ledger().set_timestamp(now + rng.range(1, 3 * DAY));
            } else {
                // try to close
                let r = w.c.try_close_period(&p);
                let per = w.c.period(&p).unwrap();
                if closed {
                    assert_eq!(r, Err(Ok(Error::BadState)));
                } else if w.now() < per.confirm_by && (responded.len() as u32) < per.leaf_count {
                    assert_eq!(r, Err(Ok(Error::TooEarly)));
                } else if !attested {
                    assert_eq!(r, Err(Ok(Error::CustodianMissing)));
                } else {
                    let rep = r.unwrap().unwrap();
                    closed = true;
                    frozen = Some(rep);
                }
            }
        }
        // Finish the period.
        if !closed {
            if !attested {
                w.c.attest_cash(&p, &w.custodian, &cash, &AS_OF_AUG, &zero32(e));
            }
            w.env
                .ledger()
                .set_timestamp(w.now().max(T_OPEN + CONFIRM_WINDOW));
            frozen = Some(w.c.close_period(&p));
        }
        ex.cash = cash;
        let rep = frozen.unwrap();
        let tally = w.c.tally(&p).unwrap();

        // -------- invariants
        // independent tally equals the contract's
        assert_eq!(tally.confirmed_dep, ex.confirmed_dep, "case {case}");
        assert_eq!(tally.confirmed_loans, ex.confirmed_loans, "case {case}");
        assert_eq!(tally.recognised_loans, ex.recognised, "case {case}");
        assert_eq!(tally.disputed_loans_booked, ex.disputed_booked);
        assert_eq!(tally.disputed_loans_ack, ex.disputed_ack);
        assert_eq!(tally.deposit_uplift, ex.uplift);
        assert_eq!(tally.disputed_count, ex.disputes);
        assert_eq!(tally.omitted_count, ex.omitted);
        assert_eq!(tally.cash, ex.cash);
        // recognised <= confirmed + acknowledged <= booked
        assert!(tally.recognised_loans <= tally.confirmed_loans + tally.disputed_loans_ack);
        assert!(tally.confirmed_loans + tally.disputed_loans_ack <= root.loan);
        // unconfirmed = booked loans on unresponded lines, recomputed from the tree
        let unresp_loans: i128 = (0..n as u32)
            .filter(|i| !responded.contains(i))
            .map(|i| t.leaf(i))
            .filter(|l| l.kind == KIND_LOAN)
            .map(|l| l.balance)
            .sum();
        assert!(rep.unconfirmed_loans >= 0);
        assert_eq!(rep.unconfirmed_loans, unresp_loans, "case {case}");
        // no line of an unregistered or inactive counterparty was ever responded
        for i in 0..n as u32 {
            let resp = w.c.response(&p, &i);
            if !can_respond(t.leaf(i).cp) {
                assert!(resp.is_none());
            }
            assert_eq!(resp.is_some(), responded.contains(&i));
        }
        // responded equals the popcount of RespBits (read through the unresponded view)
        let unresp = w.c.unresponded(&p, &0, &512);
        assert_eq!(tally.responded, n as u32 - unresp.len(), "case {case}");
        assert_eq!(tally.responded, ex.responded);
        assert_eq!(rep.unresponded, unresp.len());
        // a proof for index i never verifies at index j != i
        if n > 1 {
            let i = rng.below(n as u64) as u32;
            let mut j = rng.below(n as u64) as u32;
            if j == i {
                j = (i + 1) % n as u32;
            }
            let proof = t.proof(i);
            let moved = Leaf {
                index: j,
                ..t.leaf(i)
            };
            assert_ne!(
                merkle::root_from_proof(e, merkle::leaf_node(e, &moved), j, &proof).ok(),
                Some(root.clone())
            );
            assert_ne!(
                merkle::root_from_proof(e, merkle::leaf_node(e, &t.leaf(i)), j, &proof).ok(),
                Some(root.clone())
            );
        }
        // the report equals the pure computation over the stored tally
        let recomputed =
            compute_report(p, ALERT_BPS, &root, n as u32, &tally, rep.closed_at).unwrap();
        assert_eq!(rep, recomputed);
        // no report changes once written
        let i = rng.below(n as u64) as u32;
        let _ = w.c.try_confirm(&p, &t.leaf(i).cp, &t.leaf(i), &t.proof(i));
        let _ = w.c.try_close_period(&p);
        assert_eq!(w.c.report(&p).unwrap(), rep);

        if case < EXPORT_CASES {
            exported.push(format!(
                "{{\"case\":{},\"alert_bps\":{},\"root\":{{\"dep\":\"{}\",\"loan\":\"{}\"}},\"leaf_count\":{},\"tally\":{},\"report\":{}}}",
                case, ALERT_BPS, root.dep, root.loan, n, tally_json(&tally), report_json(&rep)
            ));
        }
    }

    // Edge cases for the TypeScript side: zero divisors and exact alert boundary.
    let edge = [
        (
            Node {
                hash: zero32(&Env::default()),
                dep: 0,
                loan: 500,
            },
            Tally {
                cash: 10,
                ..Tally::default()
            },
        ),
        (
            Node {
                hash: zero32(&Env::default()),
                dep: 1_000,
                loan: 0,
            },
            Tally {
                cash: 1_000,
                ..Tally::default()
            },
        ),
        (
            Node {
                hash: zero32(&Env::default()),
                dep: 1_000,
                loan: 900,
            },
            Tally {
                cash: 100,
                confirmed_loans: 800,
                recognised_loans: 800,
                responded: 3,
                late: 1,
                cash_late: true,
                ..Tally::default()
            },
        ),
    ];
    for (k, (root, tally)) in edge.iter().enumerate() {
        let rep = compute_report(1, ALERT_BPS, root, 4, tally, 99).unwrap();
        exported.push(format!(
            "{{\"case\":\"edge-{}\",\"alert_bps\":{},\"root\":{{\"dep\":\"{}\",\"loan\":\"{}\"}},\"leaf_count\":4,\"tally\":{},\"report\":{}}}",
            k, ALERT_BPS, root.dep, root.loan, tally_json(tally), report_json(&rep)
        ));
    }

    let body = format!(
        "{{\n  \"note\": \"Exported by the Rust property test (contracts/apex_register/src/test/props.rs). Checked by app/test/coverage.test.ts.\",\n  \"cases\": [\n    {}\n  ]\n}}\n",
        exported.join(",\n    ")
    );
    let path = vectors_dir().join("coverage.json");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current != body {
        std::fs::write(&path, body).unwrap();
    }
}

//! Unit and negative tests, one group per contract function.
extern crate std;

use super::util::*;
use crate::assert_err;
use crate::*;
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, MockAuth, MockAuthInvoke,
};
use soroban_sdk::{vec, Address, BytesN, Env, IntoVal, Symbol, Vec};

fn small_tree(env: &Env, period: u32) -> Tree {
    Tree::build(
        env,
        period,
        &[
            dep(1, 1_000_000 * KES),
            dep(2, 500_000 * KES),
            loan(1, 400_000 * KES, 0),
            loan(2, 300_000 * KES, 120),
            loan(3, 200_000 * KES, 10),
            loan(2, 100_000 * KES, 0),
            dep(3, 250_000 * KES),
        ],
    )
}

// ============================================================ init

#[test]
fn init_twice_fails() {
    let w = World::new(0);
    assert_err!(
        w.c.try_init(&w.registrar, &w.apex, &Symbol::new(&w.env, "KES"), &2, &10, &5, &45, &90, &10_000),
        Error::AlreadyInitialised
    );
}

#[test]
fn init_rejects_registrar_equal_to_apex_and_bad_windows() {
    let env = Env::default();
    env.mock_all_auths();
    let c = ApexRegisterClient::new(&env, &env.register(ApexRegister, ()));
    let r = Address::generate(&env);
    let a = Address::generate(&env);
    let kes = Symbol::new(&env, "KES");
    assert_err!(c.try_init(&r, &r, &kes, &2, &10, &5, &45, &90, &10_000), Error::RoleConflict);
    assert_err!(c.try_init(&r, &a, &kes, &2, &0, &5, &45, &90, &10_000), Error::BadConfig);
    assert_err!(c.try_init(&r, &a, &kes, &2, &10, &0, &45, &90, &10_000), Error::BadConfig);
    assert_err!(c.try_init(&r, &a, &kes, &2, &10, &11, &45, &90, &10_000), Error::BadConfig);
    assert_err!(c.try_init(&r, &a, &kes, &2, &10, &5, &45, &90, &0), Error::BadConfig);
    assert_err!(c.try_init(&r, &a, &kes, &2, &10, &5, &45, &90, &20_001), Error::BadConfig);
    // views before init
    assert_err!(c.try_config(), Error::NotInitialised);
    c.init(&r, &a, &kes, &2, &10, &5, &45, &90, &10_000);
    assert_eq!(env.auths()[0].0, r, "init requires the registrar's authorisation");
    assert_eq!(c.config().alert_bps, 10_000);
}

// ============================================================ register_member

#[test]
fn register_member_is_registrar_only_with_auth_tree() {
    let w = World::new(0);
    let board = Address::generate(&w.env);
    let lic = h(&w.env, "SASRA/DT/0001");
    w.c.register_member(&1, &board, &lic);
    assert_eq!(
        w.env.auths(),
        std::vec![(
            w.registrar.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    w.id.clone(),
                    Symbol::new(&w.env, "register_member"),
                    (1u32, board.clone(), lic.clone()).into_val(&w.env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
    let m = w.c.member(&1).unwrap();
    assert_eq!(m.board, board);
    assert!(m.active);
    assert_eq!(w.c.member_by_board(&board), Some(1));
    assert_eq!(w.c.member_count(), 1);

    // The apex authorising (instead of the registrar) is rejected: the apex can never
    // admit the members that confirm its loans.
    let b2 = Address::generate(&w.env);
    let r = w
        .c
        .mock_auths(&[MockAuth {
            address: &w.apex,
            invoke: &MockAuthInvoke {
                contract: &w.id,
                fn_name: "register_member",
                args: (2u32, b2.clone(), lic.clone()).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_register_member(&2, &b2, &lic);
    assert!(r.is_err());
    assert_eq!(w.c.member(&2), None);
}

#[test]
fn register_member_role_conflicts_and_numbers() {
    let w = World::new(2);
    let lic = h(&w.env, "lic");
    // a board already bound to member 1
    assert_err!(w.c.try_register_member(&3, &w.boards[1], &lic), Error::RoleConflict);
    // the apex's own address as a board
    assert_err!(w.c.try_register_member(&3, &w.apex, &lic), Error::RoleConflict);
    // the registrar or a custodian as a board
    assert_err!(w.c.try_register_member(&3, &w.registrar, &lic), Error::RoleConflict);
    assert_err!(w.c.try_register_member(&3, &w.custodian, &lic), Error::RoleConflict);
    let b = Address::generate(&w.env);
    assert_err!(w.c.try_register_member(&0, &b, &lic), Error::BadMemberNo);
    assert_err!(w.c.try_register_member(&1025, &b, &lic), Error::BadMemberNo);
    assert_err!(w.c.try_register_member(&1, &b, &lic), Error::MemberExists);
    w.c.register_member(&1024, &b, &lic);
    assert_eq!(w.c.member_count(), 3);
}

// ============================================================ set_member_active / rotate_board

#[test]
fn set_member_active_is_registrar_only() {
    let w = World::new(1);
    w.c.set_member_active(&1, &false);
    assert_eq!(w.env.auths()[0].0, w.registrar);
    assert!(!w.c.member(&1).unwrap().active);
    assert_err!(w.c.try_set_member_active(&9, &false), Error::UnknownMember);
    w.c.set_member_active(&1, &true);
    assert!(w.c.member(&1).unwrap().active);
    // board authorising for itself is not enough
    let r = w
        .c
        .mock_auths(&[MockAuth {
            address: &w.boards[1],
            invoke: &MockAuthInvoke {
                contract: &w.id,
                fn_name: "set_member_active",
                args: (1u32, false).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_set_member_active(&1, &false);
    assert!(r.is_err());
}

#[test]
fn rotate_board_rebinds_and_checks_conflicts() {
    let w = World::new(2);
    let nb = Address::generate(&w.env);
    w.c.rotate_board(&1, &nb);
    assert_eq!(w.env.auths()[0].0, w.registrar);
    assert_eq!(w.c.member(&1).unwrap().board, nb);
    assert_eq!(w.c.member_by_board(&nb), Some(1));
    assert_eq!(w.c.member_by_board(&w.boards[1]), None);
    assert_err!(w.c.try_rotate_board(&1, &w.boards[2]), Error::RoleConflict);
    assert_err!(w.c.try_rotate_board(&1, &w.apex), Error::RoleConflict);
    assert_err!(w.c.try_rotate_board(&7, &Address::generate(&w.env)), Error::UnknownMember);
}

// ============================================================ set_custodian / set_apex / transfer_registrar

#[test]
fn set_custodian_registrar_only_and_apex_cannot() {
    let w = World::new(1);
    let bank2 = Address::generate(&w.env);
    // the apex tries to choose its own custodian: auth failure
    let r = w
        .c
        .mock_auths(&[MockAuth {
            address: &w.apex,
            invoke: &MockAuthInvoke {
                contract: &w.id,
                fn_name: "set_custodian",
                args: (bank2.clone(), true).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_set_custodian(&bank2, &true);
    assert!(r.is_err());
    assert_eq!(w.c.custodians().len(), 1);

    w.env.mock_all_auths();
    w.c.set_custodian(&bank2, &true);
    assert_eq!(
        w.env.auths(),
        std::vec![(
            w.registrar.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    w.id.clone(),
                    Symbol::new(&w.env, "set_custodian"),
                    (bank2.clone(), true).into_val(&w.env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
    // role conflicts
    assert_err!(w.c.try_set_custodian(&w.apex, &true), Error::RoleConflict);
    assert_err!(w.c.try_set_custodian(&w.boards[1], &true), Error::RoleConflict);
    // a fifth active custodian
    w.c.set_custodian(&Address::generate(&w.env), &true);
    w.c.set_custodian(&Address::generate(&w.env), &true);
    assert_eq!(w.c.custodians().len(), 4);
    assert_err!(w.c.try_set_custodian(&Address::generate(&w.env), &true), Error::TooManyCustodians);
    // deactivating frees a slot; re-activating an active one is idempotent
    w.c.set_custodian(&bank2, &false);
    assert_eq!(w.c.custodians().len(), 3);
    w.c.set_custodian(&w.custodian, &true);
    assert_eq!(w.c.custodians().len(), 3);
}

#[test]
fn set_apex_and_transfer_registrar() {
    let w = World::new(1);
    let new_apex = Address::generate(&w.env);
    assert_err!(w.c.try_set_apex(&w.boards[1]), Error::RoleConflict);
    assert_err!(w.c.try_set_apex(&w.custodian), Error::RoleConflict);
    assert_err!(w.c.try_set_apex(&w.registrar), Error::RoleConflict);
    w.c.set_apex(&new_apex);
    assert_eq!(w.env.auths()[0].0, w.registrar);
    assert_eq!(w.c.config().apex, new_apex);

    let new_reg = Address::generate(&w.env);
    assert_err!(w.c.try_transfer_registrar(&new_apex), Error::RoleConflict);
    w.c.transfer_registrar(&new_reg);
    let auths: std::vec::Vec<Address> = w.env.auths().iter().map(|a| a.0.clone()).collect();
    assert!(auths.contains(&w.registrar) && auths.contains(&new_reg), "both registrars sign");
    assert_eq!(w.c.config().registrar, new_reg);

    // only the new registrar signing is not enough
    let other = Address::generate(&w.env);
    let r = w
        .c
        .mock_auths(&[MockAuth {
            address: &other,
            invoke: &MockAuthInvoke {
                contract: &w.id,
                fn_name: "transfer_registrar",
                args: (other.clone(),).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_transfer_registrar(&other);
    assert!(r.is_err());
}

// ============================================================ open_period

#[test]
fn open_period_apex_only() {
    let w = World::new(1);
    w.at(T_OPEN);
    let r = w
        .c
        .mock_auths(&[MockAuth {
            address: &w.registrar,
            invoke: &MockAuthInvoke {
                contract: &w.id,
                fn_name: "open_period",
                args: (AS_OF_AUG, 0u32).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_open_period(&AS_OF_AUG, &0);
    assert!(r.is_err());
    w.env.mock_all_auths();
    assert_eq!(w.c.open_period(&AS_OF_AUG, &0), 1);
    assert_eq!(
        w.env.auths(),
        std::vec![(
            w.apex.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    w.id.clone(),
                    Symbol::new(&w.env, "open_period"),
                    (AS_OF_AUG, 0u32).into_val(&w.env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
    let p = w.c.period(&1).unwrap();
    assert_eq!(p.state, PeriodState::Open);
    assert_eq!(p.custodians, vec![&w.env, w.custodian.clone()]);
    assert_eq!(w.c.current_period(), 1);
}

#[test]
fn open_period_rules() {
    let w = World::new(1);
    w.at(T_OPEN);
    // future as_of
    assert_err!(w.c.try_open_period(&(T_OPEN + 1), &0), Error::FutureAsOf);
    // supersedes an unknown period
    assert_err!(w.c.try_open_period(&AS_OF_AUG, &1), Error::BadSupersedes);
    let t = Tree::build(&w.env, 1, &[dep(1, 100)]);
    let p = w.open_post(&t, 100);
    // previous not closed (Open and Posted)
    assert_err!(w.c.try_open_period(&(AS_OF_AUG + DAY), &0), Error::PreviousNotClosed);
    w.confirm(p, &t, 0);
    w.c.close_period(&p);
    // non-increasing as_of
    w.at(T_OPEN + 2 * DAY);
    assert_err!(w.c.try_open_period(&AS_OF_AUG, &0), Error::AsOfNotIncreasing);
    assert_err!(w.c.try_open_period(&(AS_OF_AUG - 1), &0), Error::AsOfNotIncreasing);
    // supersedes an open (not closed) period id / a future id
    assert_err!(w.c.try_open_period(&(AS_OF_AUG + DAY), &5), Error::BadSupersedes);
    // no active custodian
    w.c.set_custodian(&w.custodian, &false);
    assert_err!(w.c.try_open_period(&(AS_OF_AUG + DAY), &0), Error::NoCustodian);
    w.c.set_custodian(&w.custodian, &true);
    // a correction of period 1 may reuse its balance date; both stay visible
    let p2 = w.c.open_period(&AS_OF_AUG, &1);
    assert_eq!(p2, 2);
    assert_eq!(w.c.period(&2).unwrap().supersedes, 1);
    assert_eq!(w.c.period(&1).unwrap().state, PeriodState::Closed);
    assert!(w.c.report(&1).is_some());
}

// ============================================================ post_root

#[test]
fn post_root_rules() {
    let w = World::new(1);
    let t = Tree::build(&w.env, 1, &[dep(1, 100), loan(1, 50, 0)]);
    let fh = h(&w.env, "file");
    // no such period
    assert_err!(w.c.try_post_root(&1, &t.root(), &2, &fh), Error::BadState);
    w.at(T_OPEN);
    let p = w.c.open_period(&AS_OF_AUG, &0);
    assert_err!(w.c.try_post_root(&p, &t.root(), &0, &fh), Error::BadLeafCount);
    assert_err!(w.c.try_post_root(&p, &t.root(), &4097, &fh), Error::BadLeafCount);
    let mut neg = t.root();
    neg.dep = -1;
    assert_err!(w.c.try_post_root(&p, &neg, &2, &fh), Error::NegativeSum);
    let mut neg2 = t.root();
    neg2.loan = -5;
    assert_err!(w.c.try_post_root(&p, &neg2, &2, &fh), Error::NegativeSum);
    // only the apex
    let r = w
        .c
        .mock_auths(&[MockAuth {
            address: &w.registrar,
            invoke: &MockAuthInvoke {
                contract: &w.id,
                fn_name: "post_root",
                args: (p, t.root(), 2u32, fh.clone()).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_post_root(&p, &t.root(), &2, &fh);
    assert!(r.is_err());
    w.env.mock_all_auths();
    w.c.post_root(&p, &t.root(), &2, &fh);
    assert_eq!(w.env.auths()[0].0, w.apex);
    let per = w.c.period(&p).unwrap();
    assert_eq!(per.state, PeriodState::Posted);
    assert_eq!(per.depth, 1);
    assert_eq!(per.confirm_by, T_OPEN + CONFIRM_WINDOW);
    assert_eq!(per.attest_by, T_OPEN + ATTEST_WINDOW);
    assert_eq!(per.root, t.root());
    // a root can never be replaced
    assert_err!(w.c.try_post_root(&p, &t.root(), &2, &fh), Error::BadState);
}

// ============================================================ confirm

#[test]
fn confirm_happy_path_updates_tally_and_bit() {
    let w = World::new(3);
    let t = small_tree(&w.env, 1);
    let p = w.open_post(&t, 0);
    w.at(T_OPEN + DAY);
    w.confirm(p, &t, 2);
    // the board's authorisation was required
    assert_eq!(w.env.auths()[0].0, w.boards[1]);
    let tl = w.c.tally(&p).unwrap();
    assert_eq!(tl.responded, 1);
    assert_eq!(tl.confirmed_loans, 400_000 * KES);
    assert_eq!(tl.recognised_loans, 400_000 * KES);
    assert_eq!(w.c.unresponded(&p, &0, &10), vec![&w.env, 0u32, 1, 3, 4, 5, 6]);
    let r = w.c.response(&p, &2).unwrap();
    assert_eq!(r.verdict, VERDICT_CONFIRMED);
    assert_eq!(r.member_no, 1);
    assert!(!r.late);
    assert_eq!(w.c.member_responses(&p, &1), 1);
    // deposit confirmation
    w.confirm(p, &t, 0);
    assert_eq!(w.c.tally(&p).unwrap().confirmed_dep, 1_000_000 * KES);
    // non-performing loan: confirmed but not recognised
    w.confirm(p, &t, 3);
    let tl = w.c.tally(&p).unwrap();
    assert_eq!(tl.confirmed_loans, 700_000 * KES);
    assert_eq!(tl.recognised_loans, 400_000 * KES);
}

#[test]
fn a_line_cannot_be_confirmed_twice_nor_confirmed_then_disputed() {
    let w = World::new(3);
    let t = small_tree(&w.env, 1);
    let p = w.open_post(&t, 0);
    w.confirm(p, &t, 2);
    let l = t.leaf(2);
    assert_err!(w.c.try_confirm(&p, &1, &l, &t.proof(2)), Error::AlreadyResponded);
    assert_err!(
        w.c.try_dispute(&p, &1, &l, &t.proof(2), &1, &0, &REASON_BALANCE_WRONG, &zero32(&w.env)),
        Error::AlreadyResponded
    );
    assert_err!(
        w.c.try_confirm_batch(&p, &1, &vec![&w.env, (l.clone(), t.proof(2))]),
        Error::AlreadyResponded
    );
    assert_eq!(w.c.tally(&p).unwrap().responded, 1);
}

#[test]
fn any_tampered_field_or_sibling_fails_the_proof() {
    let w = World::new(3);
    let t = small_tree(&w.env, 1);
    let p = w.open_post(&t, 0);
    let good = t.leaf(4); // member 3's loan, index 4
    let proof = t.proof(4);
    let e = &w.env;

    let mut l = good.clone();
    l.index = 6; // member 3 also owns index 6, so only the proof can catch it
    assert_err!(w.c.try_confirm(&p, &3, &l, &proof), Error::BadProof);
    let mut l = good.clone();
    l.kind = KIND_DEPOSIT;
    assert_err!(w.c.try_confirm(&p, &3, &l, &proof), Error::BadProof);
    let mut l = good.clone();
    l.balance += 1;
    assert_err!(w.c.try_confirm(&p, &3, &l, &proof), Error::BadProof);
    let mut l = good.clone();
    l.arrears_days = 11;
    assert_err!(w.c.try_confirm(&p, &3, &l, &proof), Error::BadProof);
    let mut l = good.clone();
    l.salt = h(e, "other salt");
    assert_err!(w.c.try_confirm(&p, &3, &l, &proof), Error::BadProof);
    let mut l = good.clone();
    l.line_ref = h(e, "other ref");
    assert_err!(w.c.try_confirm(&p, &3, &l, &proof), Error::BadProof);
    // cp changed to another member: the leaf is no longer member 3's
    let mut l = good.clone();
    l.cp = 2;
    assert_err!(w.c.try_confirm(&p, &2, &l, &proof), Error::BadProof);

    for level in 0..proof.len() {
        let mut pr = proof.clone();
        let mut s = pr.get(level).unwrap();
        s.hash = h(e, "tampered");
        pr.set(level, s);
        assert_err!(w.c.try_confirm(&p, &3, &good, &pr), Error::BadProof);

        let mut pr = proof.clone();
        let mut s = pr.get(level).unwrap();
        s.dep += 1;
        pr.set(level, s);
        assert_err!(w.c.try_confirm(&p, &3, &good, &pr), Error::BadProof);

        let mut pr = proof.clone();
        let mut s = pr.get(level).unwrap();
        s.loan += 1;
        pr.set(level, s);
        assert_err!(w.c.try_confirm(&p, &3, &good, &pr), Error::BadProof);
    }
    // a negative sibling sum is rejected outright
    let mut pr = proof.clone();
    let mut s = pr.get(0).unwrap();
    s.dep = -1;
    pr.set(0, s);
    assert_err!(w.c.try_confirm(&p, &3, &good, &pr), Error::NegativeSum);

    // one level short / one level long
    let mut short = proof.clone();
    short.pop_back();
    assert_err!(w.c.try_confirm(&p, &3, &good, &short), Error::BadProof);
    let mut long = proof.clone();
    long.push_back(t.root());
    assert_err!(w.c.try_confirm(&p, &3, &good, &long), Error::BadProof);

    // wrong period in the leaf, index beyond leaf_count, bad kind, negative balance
    let mut l = good.clone();
    l.period = 2;
    assert_err!(w.c.try_confirm(&p, &3, &l, &proof), Error::WrongPeriod);
    let mut l = good.clone();
    l.index = 7; // padding slot of the 8-wide tree
    assert_err!(w.c.try_confirm(&p, &3, &l, &proof), Error::BadIndex);
    let mut l = good.clone();
    l.kind = 3;
    assert_err!(w.c.try_confirm(&p, &3, &l, &proof), Error::BadLeaf);
    let mut l = good.clone();
    l.balance = -1;
    assert_err!(w.c.try_confirm(&p, &3, &l, &proof), Error::BadLeaf);

    // untouched, it verifies
    w.c.confirm(&p, &3, &good, &proof);
}

#[test]
fn wrong_member_cases() {
    let w = World::new(3);
    let t = small_tree(&w.env, 1);
    let p = w.open_post(&t, 0);
    let la = t.leaf(0); // member 1's deposit
    let pa = t.proof(0);

    // (i) member 2's board tries to confirm member 1's line as member 1: member 1's board
    // must authorise and did not.
    let r = w
        .c
        .mock_auths(&[MockAuth {
            address: &w.boards[2],
            invoke: &MockAuthInvoke {
                contract: &w.id,
                fn_name: "confirm",
                args: (p, 1u32, la.clone(), pa.clone()).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_confirm(&p, &1, &la, &pa);
    assert!(r.is_err());
    assert!(w.env.auths().iter().all(|(a, _)| *a != w.boards[1]));
    assert!(w.c.response(&p, &0).is_none());

    // (ii) member 2 confirming member 1's leaf as itself
    w.env.mock_all_auths();
    assert_err!(w.c.try_confirm(&p, &2, &la, &pa), Error::NotYourLeaf);

    // unknown member number
    assert_err!(w.c.try_confirm(&p, &9, &la, &pa), Error::UnknownMember);

    // (iii) an inactive member's board
    w.c.set_member_active(&1, &false);
    assert_err!(w.c.try_confirm(&p, &1, &la, &pa), Error::MemberInactive);
    w.c.set_member_active(&1, &true);

    // (iv) after rotate_board, the old board can no longer sign for member 1
    let new_board = Address::generate(&w.env);
    w.c.rotate_board(&1, &new_board);
    let r = w
        .c
        .mock_auths(&[MockAuth {
            address: &w.boards[1],
            invoke: &MockAuthInvoke {
                contract: &w.id,
                fn_name: "confirm",
                args: (p, 1u32, la.clone(), pa.clone()).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_confirm(&p, &1, &la, &pa);
    assert!(r.is_err());
    w.c.mock_auths(&[MockAuth {
        address: &new_board,
        invoke: &MockAuthInvoke {
            contract: &w.id,
            fn_name: "confirm",
            args: (p, 1u32, la.clone(), pa.clone()).into_val(&w.env),
            sub_invokes: &[],
        },
    }])
    .confirm(&p, &1, &la, &pa);
    assert_eq!(w.c.response(&p, &0).unwrap().member_no, 1);
}

#[test]
fn confirm_needs_a_posted_period() {
    let w = World::new(1);
    let t = Tree::build(&w.env, 1, &[dep(1, 100)]);
    w.at(T_OPEN);
    let p = w.c.open_period(&AS_OF_AUG, &0);
    assert_err!(w.c.try_confirm(&p, &1, &t.leaf(0), &t.proof(0)), Error::BadState);
    assert_err!(w.c.try_confirm(&9, &1, &t.leaf(0), &t.proof(0)), Error::BadState);
}

// ============================================================ dispute

#[test]
fn dispute_argument_rules() {
    let w = World::new(3);
    let t = small_tree(&w.env, 1);
    let p = w.open_post(&t, 0);
    let l = t.leaf(4);
    let pr = t.proof(4);
    let ev = h(&w.env, "evidence.pdf");
    // NOT_OURS with a non-zero claim
    assert_err!(w.c.try_dispute(&p, &3, &l, &pr, &1, &10, &REASON_NOT_OURS, &ev), Error::BadClaim);
    // negative claim
    assert_err!(w.c.try_dispute(&p, &3, &l, &pr, &-1, &10, &REASON_BALANCE_WRONG, &ev), Error::BadClaim);
    // same balance and arrears: use confirm
    assert_err!(
        w.c.try_dispute(&p, &3, &l, &pr, &l.balance, &10, &REASON_OTHER, &ev),
        Error::NotADispute
    );
    // reasons 0 and 5
    assert_err!(w.c.try_dispute(&p, &3, &l, &pr, &1, &10, &0, &ev), Error::BadReason);
    assert_err!(w.c.try_dispute(&p, &3, &l, &pr, &1, &10, &5, &ev), Error::BadReason);
    // same balance, different arrears is a real dispute
    w.c.dispute(&p, &3, &l, &pr, &l.balance, &30, &REASON_ARREARS_WRONG, &ev);
    let r = w.c.response(&p, &4).unwrap();
    assert_eq!(r.verdict, VERDICT_DISPUTED);
    assert_eq!(r.claimed_arrears_days, 30);
    assert_eq!(r.evidence_hash, ev);
    assert_eq!(w.c.disputes(&p, &0, &32).len(), 1);
    assert_err!(w.c.try_disputes(&p, &0, &33), Error::RangeTooLarge);
}

#[test]
fn disputed_loan_recognition_rule() {
    let w = World::new(3);
    let t = Tree::build(
        &w.env,
        1,
        &[
            loan(1, 90_000_000 * KES, 0),
            loan(2, 60_000_000 * KES, 0),
            loan(3, 10_000_000 * KES, 0),
            loan(3, 5_000_000 * KES, 0),
        ],
    );
    let p = w.open_post(&t, 0);
    let ev = zero32(&w.env);
    // claimed below booked, performing: min(claimed, booked) recognised
    w.c.dispute(&p, &1, &t.leaf(0), &t.proof(0), &(25_000_000 * KES), &0, &REASON_BALANCE_WRONG, &ev);
    let tl = w.c.tally(&p).unwrap();
    assert_eq!(tl.recognised_loans, 25_000_000 * KES);
    assert_eq!(tl.disputed_loans_booked, 90_000_000 * KES);
    assert_eq!(tl.disputed_loans_ack, 25_000_000 * KES);
    // claimed below booked but claimed arrears > 90: nothing recognised
    w.c.dispute(&p, &2, &t.leaf(1), &t.proof(1), &(15_000_000 * KES), &91, &REASON_BALANCE_WRONG, &ev);
    let tl = w.c.tally(&p).unwrap();
    assert_eq!(tl.recognised_loans, 25_000_000 * KES);
    assert_eq!(tl.disputed_loans_ack, 40_000_000 * KES);
    // exactly 90 days still performing
    w.c.dispute(&p, &3, &t.leaf(2), &t.proof(2), &(10_000_000 * KES), &90, &REASON_ARREARS_WRONG, &ev);
    // claimed above booked: capped at booked
    w.c.dispute(&p, &3, &t.leaf(3), &t.proof(3), &(7_000_000 * KES), &0, &REASON_BALANCE_WRONG, &ev);
    let tl = w.c.tally(&p).unwrap();
    assert_eq!(tl.recognised_loans, (25 + 10 + 5) * 1_000_000 * KES);
    assert!(tl.recognised_loans <= tl.confirmed_loans + tl.disputed_loans_ack);
    assert_eq!(tl.disputed_count, 4);
    assert_eq!(tl.deposit_uplift, 0);
}

#[test]
fn deposit_dispute_uplift_rule() {
    let w = World::new(2);
    let t = Tree::build(&w.env, 1, &[dep(1, 100_000_000 * KES), dep(2, 50_000_000 * KES)]);
    let p = w.open_post(&t, 0);
    let ev = zero32(&w.env);
    // member says the apex holds more than booked: difference is added to liabilities
    w.c.dispute(&p, &1, &t.leaf(0), &t.proof(0), &(118_500_000 * KES), &0, &REASON_BALANCE_WRONG, &ev);
    assert_eq!(w.c.tally(&p).unwrap().deposit_uplift, 18_500_000 * KES);
    // member says less: nothing is subtracted
    w.c.dispute(&p, &2, &t.leaf(1), &t.proof(1), &(40_000_000 * KES), &0, &REASON_BALANCE_WRONG, &ev);
    let tl = w.c.tally(&p).unwrap();
    assert_eq!(tl.deposit_uplift, 18_500_000 * KES);
    assert_eq!(tl.confirmed_dep, 0);
}

// ============================================================ confirm_batch

fn batch_world() -> (World, Tree, u32) {
    let w = World::new(2);
    let mut lines = std::vec::Vec::new();
    for i in 0..17 {
        lines.push(loan(1, (1_000 + i) * KES, 0));
    }
    lines.push(dep(2, 5));
    let t = Tree::build(&w.env, 1, &lines);
    let p = w.open_post(&t, 0);
    (w, t, p)
}

#[test]
fn confirm_batch_of_16_succeeds() {
    let (w, t, p) = batch_world();
    let mut items = Vec::new(&w.env);
    for i in 0..16 {
        items.push_back((t.leaf(i), t.proof(i)));
    }
    w.c.confirm_batch(&p, &1, &items);
    assert_eq!(w.env.auths().len(), 1, "one board authorisation for the whole batch");
    let tl = w.c.tally(&p).unwrap();
    assert_eq!(tl.responded, 16);
    assert_eq!(w.c.member_responses(&p, &1), 16);
}

#[test]
fn confirm_batch_of_17_fails() {
    let (w, t, p) = batch_world();
    let mut items = Vec::new(&w.env);
    for i in 0..17 {
        items.push_back((t.leaf(i), t.proof(i)));
    }
    assert_err!(w.c.try_confirm_batch(&p, &1, &items), Error::BatchTooLarge);
}

#[test]
fn one_bad_item_reverts_the_whole_batch() {
    let (w, t, p) = batch_world();
    let before = w.c.tally(&p).unwrap();
    let mut items = Vec::new(&w.env);
    for i in 0..15 {
        items.push_back((t.leaf(i), t.proof(i)));
    }
    let mut bad = t.leaf(15);
    bad.balance += 1;
    items.push_back((bad, t.proof(15)));
    assert_err!(w.c.try_confirm_batch(&p, &1, &items), Error::BadProof);
    assert_eq!(w.c.tally(&p).unwrap(), before);
    assert_eq!(w.c.unresponded(&p, &0, &100).len(), 18);
    for i in 0..16 {
        assert!(w.c.response(&p, &i).is_none());
    }
    // a line of another member inside a batch also reverts it
    let mut items = Vec::new(&w.env);
    items.push_back((t.leaf(0), t.proof(0)));
    items.push_back((t.leaf(17), t.proof(17)));
    assert_err!(w.c.try_confirm_batch(&p, &1, &items), Error::NotYourLeaf);
    assert_eq!(w.c.tally(&p).unwrap(), before);
}

// ============================================================ claim_omitted

#[test]
fn claim_omitted_rules() {
    let w = World::new(3);
    let t = Tree::build(&w.env, 1, &[dep(1, 100 * KES), loan(2, 40 * KES, 0)]);
    let p = w.open_post(&t, 100 * KES);
    let ev = h(&w.env, "member ledger extract");
    assert_err!(w.c.try_claim_omitted(&p, &3, &-1, &ev), Error::BadClaim);
    w.c.claim_omitted(&p, &3, &(12_000_000 * KES), &ev);
    assert_eq!(w.env.auths()[0].0, w.boards[3]);
    assert_err!(w.c.try_claim_omitted(&p, &3, &5, &ev), Error::AlreadyClaimed);
    let tl = w.c.tally(&p).unwrap();
    assert_eq!(tl.deposit_uplift, 12_000_000 * KES);
    assert_eq!(tl.omitted_count, 1);
    assert_eq!(w.c.omitted(&p, &3).unwrap().claimed_deposit, 12_000_000 * KES);
    // a zero claim ("we hold nothing, received no lines") counts as a response
    w.c.claim_omitted(&p, &2, &0, &ev);
    w.confirm(p, &t, 0);
    w.at(T_OPEN + CONFIRM_WINDOW + 1);
    assert_eq!(w.c.mark_overdue(&p, &25), 0);
    assert_eq!(w.c.member(&2).unwrap().overdue_streak, 0);
    assert_eq!(w.c.member(&2).unwrap().last_response_period, p);
}

// ============================================================ attest_cash

#[test]
fn attest_cash_rules() {
    let w = World::new(1);
    w.at(T_OPEN);
    let p = w.c.open_period(&AS_OF_AUG, &0);
    let sh = h(&w.env, "statement.csv");
    // a custodian added after open_period is not in the snapshot
    let late_bank = Address::generate(&w.env);
    w.c.set_custodian(&late_bank, &true);
    assert_err!(w.c.try_attest_cash(&p, &late_bank, &5, &AS_OF_AUG, &sh), Error::NotCustodian);
    // a stranger
    assert_err!(w.c.try_attest_cash(&p, &w.apex, &5, &AS_OF_AUG, &sh), Error::NotCustodian);
    // as_of mismatch, negative balance
    assert_err!(w.c.try_attest_cash(&p, &w.custodian, &5, &(AS_OF_AUG + 1), &sh), Error::AsOfMismatch);
    assert_err!(w.c.try_attest_cash(&p, &w.custodian, &-5, &AS_OF_AUG, &sh), Error::BadClaim);
    // only the custodian itself can sign its attestation
    let r = w
        .c
        .mock_auths(&[MockAuth {
            address: &w.apex,
            invoke: &MockAuthInvoke {
                contract: &w.id,
                fn_name: "attest_cash",
                args: (p, w.custodian.clone(), 5i128, AS_OF_AUG, sh.clone()).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_attest_cash(&p, &w.custodian, &5, &AS_OF_AUG, &sh);
    assert!(r.is_err());
    w.env.mock_all_auths();
    // accepted while Open, not late
    w.c.attest_cash(&p, &w.custodian, &(305_412_318_55), &AS_OF_AUG, &sh);
    assert_eq!(w.env.auths()[0].0, w.custodian);
    let cash = w.c.cash(&p);
    assert_eq!(cash.len(), 1);
    assert_eq!(cash.get(0).unwrap().balance, 305_412_318_55);
    assert!(!cash.get(0).unwrap().late);
    assert_err!(w.c.try_attest_cash(&p, &w.custodian, &5, &AS_OF_AUG, &sh), Error::AlreadyAttested);
    assert_err!(w.c.try_attest_cash(&9, &w.custodian, &5, &AS_OF_AUG, &sh), Error::BadState);
}

#[test]
fn attestation_after_attest_by_is_late() {
    let w = World::new(1);
    let t = Tree::build(&w.env, 1, &[dep(1, 100)]);
    w.at(T_OPEN);
    let p = w.c.open_period(&AS_OF_AUG, &0);
    w.c.post_root(&p, &t.root(), &1, &zero32(&w.env));
    w.at(T_OPEN + ATTEST_WINDOW + 1);
    w.c.attest_cash(&p, &w.custodian, &100, &AS_OF_AUG, &zero32(&w.env));
    assert!(w.c.cash(&p).get(0).unwrap().late);
    assert!(w.c.tally(&p).unwrap().cash_late);
    w.confirm(p, &t, 0);
    let r = w.c.close_period(&p);
    assert_eq!(r.flags & FLAG_CUSTODIAN_LATE, FLAG_CUSTODIAN_LATE);
}

// ============================================================ close_period

#[test]
fn close_is_too_early_before_confirm_by_unless_all_responded() {
    let w = World::new(2);
    let t = Tree::build(&w.env, 1, &[dep(1, 100), dep(2, 50)]);
    let p = w.open_post(&t, 100);
    w.confirm(p, &t, 0);
    assert_err!(w.c.try_close_period(&p), Error::TooEarly);
    w.confirm(p, &t, 1);
    // everyone responded: may close before the window ends
    let r = w.c.close_period(&p);
    assert_eq!(r.unresponded, 0);
    assert_eq!(r.closed_at, T_OPEN);
    assert_err!(w.c.try_close_period(&p), Error::BadState);
}

#[test]
fn a_missing_custodian_attestation_blocks_close() {
    let w = World::new(1);
    let t = Tree::build(&w.env, 1, &[dep(1, 100)]);
    w.at(T_OPEN);
    let p = w.c.open_period(&AS_OF_AUG, &0);
    w.c.post_root(&p, &t.root(), &1, &zero32(&w.env));
    w.at(T_OPEN + CONFIRM_WINDOW);
    assert_err!(w.c.try_close_period(&p), Error::CustodianMissing);
    w.c.attest_cash(&p, &w.custodian, &100, &AS_OF_AUG, &zero32(&w.env));
    let r = w.c.close_period(&p);
    assert_eq!(r.cash, 100);
    assert_eq!(w.c.period(&p).unwrap().state, PeriodState::Closed);
}

#[test]
fn report_matches_hand_computed_seven_line_tree() {
    let w = World::new(3);
    let t = small_tree(&w.env, 1);
    let p = w.open_post(&t, 600_000 * KES);
    w.at(T_OPEN + 2 * DAY);
    w.confirm(p, &t, 0); // m1 deposit 1,000,000
    w.confirm(p, &t, 2); // m1 loan 400,000 performing
    w.confirm(p, &t, 1); // m2 deposit 500,000
    w.confirm(p, &t, 3); // m2 loan 300,000, 120 days in arrears: not recognised
    // m2 leaves index 5 (100,000) unanswered
    let ev = h(&w.env, "board minute 2026-09-03");
    w.c.dispute(&p, &3, &t.leaf(4), &t.proof(4), &(150_000 * KES), &10, &REASON_BALANCE_WRONG, &ev);
    w.c.dispute(&p, &3, &t.leaf(6), &t.proof(6), &(280_000 * KES), &0, &REASON_BALANCE_WRONG, &ev);
    w.at(T_OPEN + CONFIRM_WINDOW);
    let r = w.c.close_period(&p);
    // close and coverage_alert events were emitted
    assert_eq!(w.env.events().all().events().len(), 2);
    // Hand computation (KES):
    //   booked deposits 1,750,000; uplift 30,000 → liabilities 1,780,000
    //   recognised loans 400,000 + min(150,000, 200,000) = 550,000
    //   coverage = (600,000 + 550,000) * 10000 / 1,780,000 = 6460.67 → 6460
    //   booked   = (600,000 + 1,000,000) * 10000 / 1,750,000 = 9142.86 → 9142
    //   unconfirmed = 1,000,000 − 700,000 − 200,000 = 100,000
    assert_eq!(
        r,
        Report {
            period: 1,
            liabilities: 1_780_000 * KES,
            cash: 600_000 * KES,
            recognised_loans: 550_000 * KES,
            booked_loans: 1_000_000 * KES,
            unconfirmed_loans: 100_000 * KES,
            coverage_bps: 6460,
            booked_coverage_bps: 9142,
            unresponded: 1,
            disputed: 2,
            late: 0,
            omitted: 0,
            flags: FLAG_BELOW_ALERT | FLAG_UNCONFIRMED_LOANS | FLAG_DISPUTES | FLAG_GAP_WIDE,
            closed_at: T_OPEN + CONFIRM_WINDOW,
        }
    );
    assert_eq!(w.c.report(&p), Some(r.clone()));
    assert_eq!(w.c.latest_report(), Some(r.clone()));
    assert_eq!(w.c.reports(&1, &24).len(), 1);
    assert_err!(w.c.try_reports(&1, &25), Error::RangeTooLarge);
    assert_err!(w.c.try_reports(&3, &2), Error::RangeTooLarge);
    assert_eq!(w.c.unresponded(&p, &0, &512), vec![&w.env, 5u32]);
    assert_err!(w.c.try_unresponded(&p, &0, &513), Error::RangeTooLarge);
    assert_eq!(w.c.disputes(&p, &1, &5).get(0).unwrap().index, 6);

    // responses after close fail
    assert_err!(w.c.try_confirm(&p, &2, &t.leaf(5), &t.proof(5)), Error::BadState);
    assert_err!(w.c.try_claim_omitted(&p, &2, &0, &ev), Error::BadState);
    assert_err!(w.c.try_attest_cash(&p, &w.custodian, &1, &AS_OF_AUG, &ev), Error::BadState);
    // the report never changes
    assert_eq!(w.c.report(&p), Some(r));
}

#[test]
fn zero_divisor_yields_minus_one_and_no_liabilities() {
    let w = World::new(1);
    let t = Tree::build(&w.env, 1, &[loan(1, 500, 0)]);
    let p = w.open_post(&t, 0);
    w.confirm(p, &t, 0);
    let r = w.c.close_period(&p);
    assert_eq!(r.coverage_bps, -1);
    assert_eq!(r.booked_coverage_bps, -1);
    assert_eq!(r.flags & FLAG_NO_LIABILITIES, FLAG_NO_LIABILITIES);
    assert_eq!(r.flags & FLAG_BELOW_ALERT, 0);
    assert_eq!(r.flags & FLAG_GAP_WIDE, 0);
}

// ============================================================ mark_overdue

#[test]
fn mark_overdue_flags_exactly_the_silent_active_members() {
    let w = World::new(5);
    let t = Tree::build(
        &w.env,
        1,
        &[dep(1, 10), dep(2, 10), dep(3, 10), dep(4, 10), dep(5, 10)],
    );
    let p = w.open_post(&t, 10);
    w.c.set_member_active(&4, &false); // dormant: skipped
    w.confirm(p, &t, 0);
    w.c.claim_omitted(&p, &5, &0, &zero32(&w.env));
    // too early at confirm_by itself
    w.at(T_OPEN + CONFIRM_WINDOW);
    assert_err!(w.c.try_mark_overdue(&p, &25), Error::TooEarly);
    w.at(T_OPEN + CONFIRM_WINDOW + 1);
    assert_err!(w.c.try_mark_overdue(&p, &26), Error::BatchTooLarge);
    assert_eq!(w.c.mark_overdue(&p, &25), 2); // members 2 and 3
    assert_eq!(w.c.member(&2).unwrap().overdue_streak, 1);
    assert_eq!(w.c.member(&3).unwrap().overdue_streak, 1);
    assert_eq!(w.c.member(&4).unwrap().overdue_streak, 0);
    assert_eq!(w.c.member(&1).unwrap().overdue_streak, 0);
    assert_eq!(w.c.member(&1).unwrap().last_response_period, p);
    // second pass flags nothing
    assert_eq!(w.c.mark_overdue(&p, &25), 0);
    assert_eq!(w.c.member(&2).unwrap().overdue_streak, 1);
    // an open (not posted) period cannot be marked
    assert_err!(w.c.try_mark_overdue(&9, &25), Error::BadState);
}

#[test]
fn mark_overdue_pages_25_at_a_time() {
    let w = World::new(60);
    let t = Tree::build(&w.env, 1, &[dep(1, 10)]);
    let p = w.open_post(&t, 10);
    w.confirm(p, &t, 0);
    w.at(T_OPEN + CONFIRM_WINDOW + 1);
    assert_eq!(w.c.mark_overdue(&p, &25), 24); // members 1..=25, member 1 responded
    assert_eq!(w.c.member(&26).unwrap().overdue_streak, 0);
    assert_eq!(w.c.mark_overdue(&p, &25), 25); // 26..=50
    assert_eq!(w.c.mark_overdue(&p, &25), 10); // 51..=60
    assert_eq!(w.c.mark_overdue(&p, &25), 0);
    assert_eq!(w.c.member(&60).unwrap().overdue_streak, 1);
}

#[test]
fn overdue_streak_increments_across_periods_and_resets_on_response() {
    let w = World::new(2);
    let t1 = Tree::build(&w.env, 1, &[dep(1, 10), dep(2, 10)]);
    let p1 = w.open_post(&t1, 10);
    w.confirm(p1, &t1, 0);
    w.at(T_OPEN + CONFIRM_WINDOW + 1);
    assert_eq!(w.c.mark_overdue(&p1, &25), 1);
    w.c.close_period(&p1);

    w.at(T_OPEN + 30 * DAY);
    let p2 = w.c.open_period(&(AS_OF_AUG + 30 * DAY), &0);
    let t2 = Tree::build(&w.env, 2, &[dep(1, 10), dep(2, 10)]);
    w.c.attest_cash(&p2, &w.custodian, &10, &(AS_OF_AUG + 30 * DAY), &zero32(&w.env));
    w.c.post_root(&p2, &t2.root(), &2, &zero32(&w.env));
    w.confirm(p2, &t2, 0);
    w.at(T_OPEN + 30 * DAY + CONFIRM_WINDOW + 1);
    w.c.mark_overdue(&p2, &25);
    assert_eq!(w.c.member(&2).unwrap().overdue_streak, 2);
    w.c.close_period(&p2);

    w.at(T_OPEN + 60 * DAY);
    let p3 = w.c.open_period(&(AS_OF_AUG + 60 * DAY), &0);
    let t3 = Tree::build(&w.env, 3, &[dep(1, 10), dep(2, 10)]);
    w.c.attest_cash(&p3, &w.custodian, &10, &(AS_OF_AUG + 60 * DAY), &zero32(&w.env));
    w.c.post_root(&p3, &t3.root(), &2, &zero32(&w.env));
    w.confirm(p3, &t3, 1);
    w.at(T_OPEN + 60 * DAY + CONFIRM_WINDOW + 1);
    w.c.mark_overdue(&p3, &25);
    assert_eq!(w.c.member(&2).unwrap().overdue_streak, 0);
    assert_eq!(w.c.member(&2).unwrap().last_response_period, 3);
    assert_eq!(w.c.member(&1).unwrap().overdue_streak, 1);
}

#[test]
fn a_member_admitted_after_posting_is_not_flagged() {
    let w = World::new(1);
    let t = Tree::build(&w.env, 1, &[dep(1, 10)]);
    let p = w.open_post(&t, 10);
    w.confirm(p, &t, 0);
    w.at(T_OPEN + DAY);
    w.c.register_member(&2, &Address::generate(&w.env), &zero32(&w.env));
    w.at(T_OPEN + CONFIRM_WINDOW + 1);
    assert_eq!(w.c.mark_overdue(&p, &25), 0);
}

// ============================================================ late responses

#[test]
fn a_late_confirmation_is_stored_late_and_keeps_the_overdue_increment() {
    let w = World::new(2);
    let t = Tree::build(&w.env, 1, &[dep(1, 10), dep(2, 10)]);
    let p = w.open_post(&t, 20);
    w.confirm(p, &t, 0);
    w.at(T_OPEN + CONFIRM_WINDOW + 1);
    // member 2 is flagged before it responds
    assert_eq!(w.c.mark_overdue(&p, &25), 1);
    assert_eq!(w.c.member(&2).unwrap().overdue_streak, 1);
    w.at(T_OPEN + CONFIRM_WINDOW + 2 * DAY);
    w.confirm(p, &t, 1);
    let r = w.c.response(&p, &1).unwrap();
    assert!(r.late);
    assert!(!w.c.response(&p, &0).unwrap().late);
    // the flag stays for this period
    assert_eq!(w.c.mark_overdue(&p, &25), 0);
    assert_eq!(w.c.member(&2).unwrap().overdue_streak, 1);
    let rep = w.c.close_period(&p);
    assert_eq!(rep.late, 1);
    assert_eq!(rep.flags & FLAG_LATE_RESPONSES, FLAG_LATE_RESPONSES);
}

// ============================================================ flag_stale_apex

#[test]
fn flag_stale_apex_rules() {
    let w = World::new(1);
    // nothing ever opened
    assert!(!w.c.flag_stale_apex());
    let t = Tree::build(&w.env, 1, &[dep(1, 10)]);
    let p = w.open_post(&t, 10);
    w.confirm(p, &t, 0);
    let closed_at = T_OPEN + DAY;
    w.at(closed_at);
    w.c.close_period(&p);
    // within the gap
    w.at(closed_at + MAX_GAP);
    assert!(!w.c.flag_stale_apex());
    assert_eq!(w.c.apex_stale_since(), 0);
    // after the gap
    w.at(closed_at + MAX_GAP + 1);
    assert!(w.c.flag_stale_apex());
    assert_eq!(w.c.apex_stale_since(), closed_at + MAX_GAP + 1);
    // set once
    w.at(closed_at + MAX_GAP + 100);
    assert!(w.c.flag_stale_apex());
    assert_eq!(w.c.apex_stale_since(), closed_at + MAX_GAP + 1);
    // cleared by open_period
    let p2 = w.c.open_period(&(AS_OF_AUG + 30 * DAY), &0);
    assert_eq!(w.c.apex_stale_since(), 0);
    let opened = w.now();
    // an open period without a root for longer than the gap also flags
    w.at(opened + MAX_GAP);
    assert!(!w.c.flag_stale_apex());
    w.at(opened + MAX_GAP + 1);
    assert!(w.c.flag_stale_apex());
    // posting does not clear it; only the next open does
    let t2 = Tree::build(&w.env, p2, &[dep(1, 10)]);
    w.c.post_root(&p2, &t2.root(), &1, &zero32(&w.env));
    assert!(w.c.apex_stale_since() > 0);
}

#[test]
fn a_posted_period_is_not_stale() {
    let w = World::new(1);
    let t = Tree::build(&w.env, 1, &[dep(1, 10)]);
    w.open_post(&t, 10);
    w.at(T_OPEN + 200 * DAY);
    assert!(!w.c.flag_stale_apex());
}

// ============================================================ overflow

#[test]
fn i128_overflow_in_a_crafted_tree_returns_overflow() {
    let w = World::new(1);
    let e = &w.env;
    let leaf = Leaf {
        period: 1,
        index: 0,
        cp: 1,
        kind: KIND_DEPOSIT,
        line_ref: h(e, "L"),
        balance: i128::MAX,
        arrears_days: 0,
        salt: h(e, "S"),
    };
    let crafted_root = Node { hash: h(e, "root"), dep: i128::MAX, loan: 0 };
    w.at(T_OPEN);
    let p = w.c.open_period(&AS_OF_AUG, &0);
    w.c.post_root(&p, &crafted_root, &2, &zero32(e));
    let sibling = Node { hash: h(e, "sib"), dep: 1, loan: 0 };
    assert_err!(w.c.try_confirm(&p, &1, &leaf, &vec![e, sibling]), Error::Overflow);
    let loan_leaf = Leaf { kind: KIND_LOAN, ..leaf.clone() };
    let sib2 = Node { hash: h(e, "sib"), dep: 0, loan: 1 };
    assert_err!(w.c.try_confirm(&p, &1, &loan_leaf, &vec![e, sib2]), Error::Overflow);
    // report arithmetic overflow is an error too, not a panic
    let t = Tally { cash: i128::MAX, recognised_loans: 1, ..Tally::default() };
    let root = Node { hash: zero32(e), dep: 1, loan: 0 };
    assert_eq!(compute_report(1, 10_000, &root, 1, &t, 0), Err(Error::Overflow));
}

// ============================================================ events

#[test]
fn events_are_emitted_for_the_period_lifecycle() {
    let w = World::new(1);
    let t = Tree::build(&w.env, 1, &[dep(1, 10), loan(1, 5, 0)]);
    let p = w.open_post(&t, 1);
    w.confirm(p, &t, 0);
    let before = w.env.events().all().events().len();
    assert_eq!(before, 1, "confirm emits exactly one event");
    w.confirm(p, &t, 1);
    let r = w.c.close_period(&p);
    assert!(r.flags & FLAG_BELOW_ALERT != 0);
    // close + coverage_alert
    assert_eq!(w.env.events().all().events().len(), 2);
    let _ = BytesN::<32>::from_array(&w.env, &[0; 32]);
}

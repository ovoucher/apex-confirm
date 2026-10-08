//! Verify-first item (b): `apex_register.confirm` authorised by a real `board_account`
//! custom account through a two-signature `SorobanAuthorizationEntry` (no mocked auth).
extern crate std;

use super::util::*;
use crate::*;
use board_account::testutils::signed_entry;
use board_account::{BoardAccount, BoardAccountClient};
use ed25519_dalek::SigningKey;
use soroban_sdk::testutils::MockAuthInvoke;
use soroban_sdk::{vec, BytesN, IntoVal};

fn officer(i: u8) -> SigningKey {
    SigningKey::from_bytes(&[i.wrapping_mul(13).wrapping_add(5); 32])
}

#[test]
fn confirm_with_a_real_two_of_three_board_signature() {
    let w = World::new(0);
    let env = &w.env;
    let keys = [officer(1), officer(2), officer(3)];
    let outsider = officer(9);
    let board = env.register(BoardAccount, ());
    BoardAccountClient::new(env, &board).init(
        &vec![
            env,
            BytesN::from_array(env, &keys[0].verifying_key().to_bytes()),
            BytesN::from_array(env, &keys[1].verifying_key().to_bytes()),
            BytesN::from_array(env, &keys[2].verifying_key().to_bytes()),
        ],
        &2,
    );
    w.c.register_member(&7, &board, &h(env, "SASRA/DT/0007"));
    let t = Tree::build(env, 1, &[dep(7, 45_000_000 * KES), loan(7, 12_500_000 * KES, 0)]);
    let p = w.open_post(&t, 1);

    let leaf = t.leaf(1);
    let proof = t.proof(1);
    let args = (p, 7u32, leaf.clone(), proof.clone()).into_val(env);
    let invoke = MockAuthInvoke { contract: &w.id, fn_name: "confirm", args, sub_invokes: &[] };

    // From here on no auth is mocked: the host calls board_account.__check_auth.
    // One officer is below the threshold.
    env.set_auths(&[signed_entry(env, &board, &[&keys[0]], &invoke, 11, false)]);
    assert!(w.c.try_confirm(&p, &7, &leaf, &proof).is_err());
    // An officer plus an outsider: unknown signer.
    env.set_auths(&[signed_entry(env, &board, &[&keys[0], &outsider], &invoke, 12, false)]);
    assert!(w.c.try_confirm(&p, &7, &leaf, &proof).is_err());
    // Unsorted signatures.
    let mut ks = [&keys[0], &keys[1]];
    ks.sort_by(|a, b| b.verifying_key().to_bytes().cmp(&a.verifying_key().to_bytes()));
    env.set_auths(&[signed_entry(env, &board, &ks, &invoke, 13, true)]);
    assert!(w.c.try_confirm(&p, &7, &leaf, &proof).is_err());
    // Two valid signatures, but over a different invocation (another line): rejected.
    let other_args = (p, 7u32, t.leaf(0), t.proof(0)).into_val(env);
    let other = MockAuthInvoke { contract: &w.id, fn_name: "confirm", args: other_args, sub_invokes: &[] };
    env.set_auths(&[signed_entry(env, &board, &[&keys[0], &keys[1]], &other, 14, false)]);
    assert!(w.c.try_confirm(&p, &7, &leaf, &proof).is_err());
    assert!(w.c.response(&p, &1).is_none());

    // Chair and secretary sign the exact invocation: accepted.
    env.set_auths(&[signed_entry(env, &board, &[&keys[0], &keys[2]], &invoke, 15, false)]);
    w.c.confirm(&p, &7, &leaf, &proof);
    let r = w.c.response(&p, &1).unwrap();
    assert_eq!(r.verdict, VERDICT_CONFIRMED);
    assert_eq!(r.booked, 12_500_000 * KES);

    // Replaying the same signed entry (same nonce) is refused by the host.
    let ev = h(env, "x");
    let d_args = (p, 7u32, t.leaf(0), t.proof(0), 1i128, 0u32, REASON_BALANCE_WRONG, ev.clone()).into_val(env);
    let d_inv = MockAuthInvoke { contract: &w.id, fn_name: "dispute", args: d_args, sub_invokes: &[] };
    env.set_auths(&[signed_entry(env, &board, &[&keys[1], &keys[2]], &d_inv, 15, false)]);
    assert!(w
        .c
        .try_dispute(&p, &7, &t.leaf(0), &t.proof(0), &1, &0, &REASON_BALANCE_WRONG, &ev)
        .is_err());
    env.set_auths(&[signed_entry(env, &board, &[&keys[1], &keys[2]], &d_inv, 16, false)]);
    w.c.dispute(&p, &7, &t.leaf(0), &t.proof(0), &1, &0, &REASON_BALANCE_WRONG, &ev);
    assert_eq!(w.c.tally(&p).unwrap().responded, 2);
}

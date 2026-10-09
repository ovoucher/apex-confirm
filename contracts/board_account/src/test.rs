#![cfg(test)]
extern crate std;

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, AuthorizedInvocation, BytesN as _, MockAuth, MockAuthInvoke,
};
use soroban_sdk::{vec, Address, IntoVal, Symbol};

/// Deterministic officer key `i` (test only).
fn officer(i: u8) -> SigningKey {
    SigningKey::from_bytes(&[i.wrapping_mul(7).wrapping_add(11); 32])
}

fn pk(env: &Env, k: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &k.verifying_key().to_bytes())
}

fn sign(env: &Env, k: &SigningKey, payload: &BytesN<32>) -> Sig {
    Sig {
        public_key: pk(env, k),
        signature: BytesN::from_array(env, &k.sign(&payload.to_array()).to_bytes()),
    }
}

/// Signatures sorted ascending by public key, as the account requires.
fn sorted(env: &Env, mut sigs: std::vec::Vec<Sig>) -> Vec<Sig> {
    sigs.sort_by(|a, b| a.public_key.to_array().cmp(&b.public_key.to_array()));
    let mut out = Vec::new(env);
    for s in sigs {
        out.push_back(s);
    }
    out
}

struct Setup {
    env: Env,
    addr: Address,
    client: BoardAccountClient<'static>,
    keys: [SigningKey; 3],
}

fn setup() -> Setup {
    let env = Env::default();
    let addr = env.register(BoardAccount, ());
    let client = BoardAccountClient::new(&env, &addr);
    let keys = [officer(1), officer(2), officer(3)];
    client.init(
        &vec![
            &env,
            pk(&env, &keys[0]),
            pk(&env, &keys[1]),
            pk(&env, &keys[2]),
        ],
        &2,
    );
    Setup {
        env,
        addr,
        client,
        keys,
    }
}

fn check(
    s: &Setup,
    payload: &BytesN<32>,
    sigs: Vec<Sig>,
) -> Result<(), Result<AccError, soroban_sdk::InvokeError>> {
    s.env.try_invoke_contract_check_auth::<AccError>(
        &s.addr,
        payload,
        sigs.into_val(&s.env),
        &Vec::new(&s.env),
    )
}

#[test]
fn two_of_three_valid_signatures_pass() {
    let s = setup();
    let payload = BytesN::random(&s.env);
    let sigs = sorted(
        &s.env,
        std::vec![
            sign(&s.env, &s.keys[0], &payload),
            sign(&s.env, &s.keys[2], &payload)
        ],
    );
    assert_eq!(check(&s, &payload, sigs), Ok(()));
    // All three also pass.
    let all = sorted(
        &s.env,
        std::vec![
            sign(&s.env, &s.keys[0], &payload),
            sign(&s.env, &s.keys[1], &payload),
            sign(&s.env, &s.keys[2], &payload)
        ],
    );
    assert_eq!(check(&s, &payload, all), Ok(()));
}

#[test]
fn one_valid_signature_is_not_enough() {
    let s = setup();
    let payload = BytesN::random(&s.env);
    let sigs = sorted(&s.env, std::vec![sign(&s.env, &s.keys[1], &payload)]);
    assert_eq!(
        check(&s, &payload, sigs),
        Err(Ok(AccError::NotEnoughSigners))
    );
    assert_eq!(
        check(&s, &payload, Vec::new(&s.env)),
        Err(Ok(AccError::NotEnoughSigners))
    );
}

#[test]
fn same_key_twice_is_rejected_as_not_sorted() {
    let s = setup();
    let payload = BytesN::random(&s.env);
    let one = sign(&s.env, &s.keys[0], &payload);
    let sigs = vec![&s.env, one.clone(), one];
    assert_eq!(check(&s, &payload, sigs), Err(Ok(AccError::NotSorted)));
}

#[test]
fn unsorted_order_is_rejected() {
    let s = setup();
    let payload = BytesN::random(&s.env);
    let asc = sorted(
        &s.env,
        std::vec![
            sign(&s.env, &s.keys[0], &payload),
            sign(&s.env, &s.keys[1], &payload)
        ],
    );
    let desc = vec![&s.env, asc.get(1).unwrap(), asc.get(0).unwrap()];
    assert_eq!(check(&s, &payload, desc), Err(Ok(AccError::NotSorted)));
}

#[test]
fn unknown_key_is_rejected() {
    let s = setup();
    let payload = BytesN::random(&s.env);
    let stranger = officer(9);
    let sigs = sorted(
        &s.env,
        std::vec![
            sign(&s.env, &s.keys[0], &payload),
            sign(&s.env, &stranger, &payload)
        ],
    );
    assert_eq!(check(&s, &payload, sigs), Err(Ok(AccError::UnknownSigner)));
}

#[test]
fn signature_over_a_different_payload_traps() {
    let s = setup();
    let payload = BytesN::random(&s.env);
    let other = BytesN::random(&s.env);
    let sigs = sorted(
        &s.env,
        std::vec![
            sign(&s.env, &s.keys[0], &other),
            sign(&s.env, &s.keys[1], &other)
        ],
    );
    let r = check(&s, &payload, sigs);
    // ed25519_verify traps: the host reports an invocation failure, not a contract error.
    assert!(matches!(r, Err(Err(_))), "expected a trap, got {:?}", r);
}

#[test]
fn init_twice_fails_and_bad_signer_sets_are_rejected() {
    let s = setup();
    let env = &s.env;
    let k = pk(env, &s.keys[0]);
    assert_eq!(
        s.client.try_init(&vec![env, k.clone()], &1),
        Err(Ok(AccError::AlreadyInitialised))
    );

    let fresh = BoardAccountClient::new(env, &env.register(BoardAccount, ()));
    // threshold 0, threshold above signer count, duplicate keys, more than 5 keys
    assert_eq!(
        fresh.try_init(&vec![env, k.clone()], &0),
        Err(Ok(AccError::BadSigners))
    );
    assert_eq!(
        fresh.try_init(&vec![env, k.clone()], &2),
        Err(Ok(AccError::BadSigners))
    );
    assert_eq!(
        fresh.try_init(&vec![env, k.clone(), k.clone()], &1),
        Err(Ok(AccError::BadSigners))
    );
    let mut six = Vec::new(env);
    for i in 0..6u8 {
        six.push_back(pk(env, &officer(20 + i)));
    }
    assert_eq!(fresh.try_init(&six, &2), Err(Ok(AccError::BadSigners)));
    // signers() on an uninitialised account
    assert_eq!(fresh.try_signers(), Err(Ok(AccError::NotInitialised)));
}

#[test]
fn rotate_needs_the_accounts_own_quorum() {
    let s = setup();
    let env = &s.env;
    let new_keys = vec![
        env,
        pk(env, &officer(4)),
        pk(env, &officer(5)),
        pk(env, &officer(6)),
    ];

    // No authorisation at all: rejected by the host.
    assert!(s.client.try_rotate(&new_keys, &2).is_err());
    assert_eq!(s.client.signers().1, 2);
    assert_eq!(s.client.signers().0.get(0).unwrap(), pk(env, &s.keys[0]));

    // Authorisation by some other address does not help.
    let outsider = Address::generate(env);
    let r = s
        .client
        .mock_auths(&[MockAuth {
            address: &outsider,
            invoke: &MockAuthInvoke {
                contract: &s.addr,
                fn_name: "rotate",
                args: (new_keys.clone(), 2u32).into_val(env),
                sub_invokes: &[],
            },
        }])
        .try_rotate(&new_keys, &2);
    assert!(r.is_err());

    // One officer's real signature is not the quorum.
    let invoke = MockAuthInvoke {
        contract: &s.addr,
        fn_name: "rotate",
        args: (new_keys.clone(), 3u32).into_val(env),
        sub_invokes: &[],
    };
    env.set_auths(&[crate::testutils::signed_entry(
        env,
        &s.addr,
        &[&s.keys[0]],
        &invoke,
        1,
        false,
    )]);
    assert!(s.client.try_rotate(&new_keys, &3).is_err());
    assert_eq!(s.client.signers().1, 2);

    // Two officers' real signatures over this exact invocation: accepted.
    env.set_auths(&[crate::testutils::signed_entry(
        env,
        &s.addr,
        &[&s.keys[0], &s.keys[2]],
        &invoke,
        2,
        false,
    )]);
    s.client.rotate(&new_keys, &3);
    assert_eq!(s.client.signers(), (new_keys.clone(), 3));

    // With mocked auth the recorded auth tree shows the account authorising itself.
    let s2 = setup();
    let new_keys = vec![
        &s2.env,
        pk(&s2.env, &officer(4)),
        pk(&s2.env, &officer(5)),
        pk(&s2.env, &officer(6)),
    ];
    s2.env.mock_all_auths();
    s2.client.rotate(&new_keys, &3);
    assert_eq!(
        s2.env.auths(),
        std::vec![(
            s2.addr.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s2.addr.clone(),
                    Symbol::new(&s2.env, "rotate"),
                    (new_keys.clone(), 3u32).into_val(&s2.env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );

    // Old officers can no longer authorise the rotated account.
    let env = &s.env;
    let payload = BytesN::random(env);
    let old = sorted(
        env,
        std::vec![
            sign(env, &s.keys[0], &payload),
            sign(env, &s.keys[1], &payload)
        ],
    );
    assert_eq!(check(&s, &payload, old), Err(Ok(AccError::UnknownSigner)));

    // Rotation validates like init.
    s2.env.mock_all_auths();
    assert_eq!(
        s2.client
            .try_rotate(&vec![&s2.env, pk(&s2.env, &officer(4))], &2),
        Err(Ok(AccError::BadSigners))
    );
}

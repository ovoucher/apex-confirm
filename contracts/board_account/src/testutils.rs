//! Test-only helper: build a `SorobanAuthorizationEntry` for a `board_account` address,
//! signed by real Ed25519 officer keys over the exact payload the host verifies.
//! Compiled only for tests or with the `testutils` feature; never part of the wasm.
extern crate std;

use crate::Sig;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::testutils::MockAuthInvoke;
use soroban_sdk::xdr::{
    self, HashIdPreimage, HashIdPreimageSorobanAuthorization, Limits, ScVal, SorobanAddressCredentials,
    SorobanAuthorizationEntry, SorobanAuthorizedInvocation, SorobanCredentials, WriteXdr,
};
use soroban_sdk::{Address, Bytes, BytesN, Env, IntoVal, TryFromVal, Vec};

/// Build an authorisation entry for `account` covering `invoke`, signed by `keys`.
/// Signatures are sorted by public key unless `keep_order` is set (to test rejection).
pub fn signed_entry(
    env: &Env,
    account: &Address,
    keys: &[&SigningKey],
    invoke: &MockAuthInvoke,
    nonce: i64,
    keep_order: bool,
) -> SorobanAuthorizationEntry {
    let invocation: SorobanAuthorizedInvocation = invoke.into();
    let expiration = env.ledger().sequence() + 1_000;
    let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
        network_id: xdr::Hash(env.ledger().network_id().to_array()),
        nonce,
        signature_expiration_ledger: expiration,
        invocation: invocation.clone(),
    });
    let bytes = preimage.to_xdr(Limits::none()).unwrap();
    let payload: BytesN<32> = env.crypto().sha256(&Bytes::from_slice(env, &bytes)).into();

    let mut sigs: std::vec::Vec<Sig> = keys
        .iter()
        .map(|k| Sig {
            public_key: BytesN::from_array(env, &k.verifying_key().to_bytes()),
            signature: BytesN::from_array(env, &k.sign(&payload.to_array()).to_bytes()),
        })
        .collect();
    if !keep_order {
        sigs.sort_by(|a, b| a.public_key.to_array().cmp(&b.public_key.to_array()));
    }
    let mut v: Vec<Sig> = Vec::new(env);
    for s in sigs {
        v.push_back(s);
    }
    let val: soroban_sdk::Val = v.into_val(env);
    let signature = ScVal::try_from_val(env, &val).unwrap();

    SorobanAuthorizationEntry {
        root_invocation: invocation,
        credentials: SorobanCredentials::Address(SorobanAddressCredentials {
            address: account.into(),
            nonce,
            signature_expiration_ledger: expiration,
            signature,
        }),
    }
}

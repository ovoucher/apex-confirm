//! `board_account`: a Soroban custom account that authorises when at least `threshold`
//! of its registered Ed25519 officer keys sign the authorisation payload.
//!
//! A SACCO board registers, for example, its chair, treasurer and secretary with a
//! threshold of 2. The account's address is what the registrar binds to the member
//! number in `apex_register`, so `board.require_auth()` in the register is satisfied only
//! when two of the three officers signed. The custodian bank's confirmation desk can use
//! the same account type with its own officer keys.
//!
//! Signature format: `Vec<Sig>` strictly ascending by `public_key`. Strict ordering makes
//! a duplicated key impossible to count twice.
#![no_std]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    BytesN, Env, Vec,
};

/// Largest number of officer keys an account may hold.
pub const MAX_SIGNERS: u32 = 5;

const DAY_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 30 * DAY_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AccError {
    AlreadyInitialised = 1,
    NotInitialised = 2,
    BadSigners = 3,
    NotSorted = 4,
    UnknownSigner = 5,
    NotEnoughSigners = 6,
}

/// One officer's signature over the Soroban authorisation payload.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Sig {
    pub public_key: BytesN<32>,
    pub signature: BytesN<64>,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Signers,
    Threshold,
}

#[contract]
pub struct BoardAccount;

fn validate(signers: &Vec<BytesN<32>>, threshold: u32) -> Result<(), AccError> {
    let n = signers.len();
    if threshold < 1 || threshold > n || n > MAX_SIGNERS {
        return Err(AccError::BadSigners);
    }
    for i in 0..n {
        for j in (i + 1)..n {
            if signers.get_unchecked(i) == signers.get_unchecked(j) {
                return Err(AccError::BadSigners);
            }
        }
    }
    Ok(())
}

fn store(env: &Env, signers: &Vec<BytesN<32>>, threshold: u32) {
    let s = env.storage().instance();
    s.set(&Key::Signers, signers);
    s.set(&Key::Threshold, &threshold);
    let max = env.storage().max_ttl();
    s.extend_ttl(TTL_THRESHOLD.min(max), max);
}

fn load(env: &Env) -> Result<(Vec<BytesN<32>>, u32), AccError> {
    let s = env.storage().instance();
    let signers: Vec<BytesN<32>> = s.get(&Key::Signers).ok_or(AccError::NotInitialised)?;
    let threshold: u32 = s.get(&Key::Threshold).ok_or(AccError::NotInitialised)?;
    Ok((signers, threshold))
}

#[contractimpl]
impl BoardAccount {
    /// One-time setup: `1 <= threshold <= signers.len() <= 5`, no duplicate keys.
    pub fn init(env: Env, signers: Vec<BytesN<32>>, threshold: u32) -> Result<(), AccError> {
        if env.storage().instance().has(&Key::Signers) {
            return Err(AccError::AlreadyInitialised);
        }
        validate(&signers, threshold)?;
        store(&env, &signers, threshold);
        Ok(())
    }

    /// Replace the officer set. Needs the current quorum (the account authorises itself).
    pub fn rotate(env: Env, signers: Vec<BytesN<32>>, threshold: u32) -> Result<(), AccError> {
        load(&env)?;
        env.current_contract_address().require_auth();
        validate(&signers, threshold)?;
        store(&env, &signers, threshold);
        Ok(())
    }

    /// Current officer keys and threshold.
    pub fn signers(env: Env) -> Result<(Vec<BytesN<32>>, u32), AccError> {
        load(&env)
    }
}

#[contractimpl]
impl CustomAccountInterface for BoardAccount {
    type Signature = Vec<Sig>;
    type Error = AccError;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signatures: Vec<Sig>,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), AccError> {
        let (signers, threshold) = load(&env)?;
        let payload = signature_payload.to_bytes();
        let mut prev: Option<BytesN<32>> = None;
        let mut count: u32 = 0;
        for sig in signatures.iter() {
            if let Some(p) = &prev {
                if sig.public_key <= *p {
                    return Err(AccError::NotSorted);
                }
            }
            if !signers.contains(&sig.public_key) {
                return Err(AccError::UnknownSigner);
            }
            // Traps (fails the whole authorisation) on an invalid signature.
            env.crypto()
                .ed25519_verify(&sig.public_key, &payload.clone().into(), &sig.signature);
            count += 1;
            prev = Some(sig.public_key.clone());
        }
        if count < threshold {
            return Err(AccError::NotEnoughSigners);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;

#[cfg(any(test, feature = "testutils"))]
pub mod testutils;

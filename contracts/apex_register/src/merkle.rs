//! Merkle sum tree hashing. The byte layout is specified in `docs/LEAF-FORMAT.md` and
//! reproduced byte for byte by `app/src/tree/*.ts`; `contracts/vectors/tree5.json` is the
//! shared test vector. All integers are big-endian; `i128` is 16 bytes (two's complement).

use crate::{Error, Leaf, Node, KIND_DEPOSIT, KIND_LOAN};
use soroban_sdk::{Bytes, BytesN, Env, Vec};

pub const LEAF_TAG: &[u8] = b"APEX-LEAF-v1";
pub const EMPTY_TAG: &[u8] = b"APEX-EMPTY-v1";
pub const NODE_TAG: &[u8] = b"APEX-NODE-v1";

/// Largest number of lines in one period's tree.
pub const MAX_LEAVES: u32 = 4096;

fn put_u32(b: &mut Bytes, v: u32) {
    b.extend_from_array(&v.to_be_bytes());
}

fn put_i128(b: &mut Bytes, v: i128) {
    b.extend_from_array(&v.to_be_bytes());
}

fn sha(env: &Env, b: &Bytes) -> BytesN<32> {
    env.crypto().sha256(b).into()
}

/// `sha256("APEX-LEAF-v1" ‖ period ‖ index ‖ cp ‖ kind ‖ line_ref ‖ balance ‖ arrears_days ‖ salt)`.
pub fn leaf_hash(env: &Env, leaf: &Leaf) -> BytesN<32> {
    let mut b = Bytes::from_slice(env, LEAF_TAG);
    put_u32(&mut b, leaf.period);
    put_u32(&mut b, leaf.index);
    put_u32(&mut b, leaf.cp);
    put_u32(&mut b, leaf.kind);
    b.append(&leaf.line_ref.clone().into());
    put_i128(&mut b, leaf.balance);
    put_u32(&mut b, leaf.arrears_days);
    b.append(&leaf.salt.clone().into());
    sha(env, &b)
}

/// The sum-tree node of a leaf: deposits count on the liability side, loans on the asset side.
pub fn leaf_node(env: &Env, leaf: &Leaf) -> Node {
    Node {
        hash: leaf_hash(env, leaf),
        dep: if leaf.kind == KIND_DEPOSIT {
            leaf.balance
        } else {
            0
        },
        loan: if leaf.kind == KIND_LOAN {
            leaf.balance
        } else {
            0
        },
    }
}

/// Padding leaf for indexes `leaf_count..2^depth`.
pub fn empty_node(env: &Env, period: u32, index: u32) -> Node {
    let mut b = Bytes::from_slice(env, EMPTY_TAG);
    put_u32(&mut b, period);
    put_u32(&mut b, index);
    Node {
        hash: sha(env, &b),
        dep: 0,
        loan: 0,
    }
}

/// `sha256("APEX-NODE-v1" ‖ L.hash ‖ L.dep ‖ L.loan ‖ R.hash ‖ R.dep ‖ R.loan)` with checked sums.
pub fn parent(env: &Env, l: &Node, r: &Node) -> Result<Node, Error> {
    let dep = l.dep.checked_add(r.dep).ok_or(Error::Overflow)?;
    let loan = l.loan.checked_add(r.loan).ok_or(Error::Overflow)?;
    let mut b = Bytes::from_slice(env, NODE_TAG);
    b.append(&l.hash.clone().into());
    put_i128(&mut b, l.dep);
    put_i128(&mut b, l.loan);
    b.append(&r.hash.clone().into());
    put_i128(&mut b, r.dep);
    put_i128(&mut b, r.loan);
    Ok(Node {
        hash: sha(env, &b),
        dep,
        loan,
    })
}

/// `ceil(log2(max(leaf_count, 2)))`.
pub fn depth_for(leaf_count: u32) -> u32 {
    let n = if leaf_count < 2 { 2 } else { leaf_count };
    let mut d = 0u32;
    while (1u32 << d) < n {
        d += 1;
    }
    d
}

/// Recompute the root from a leaf node and its sibling path. The direction at level `k`
/// is bit `k` of `index` (0 = the running node is the left child).
pub fn root_from_proof(
    env: &Env,
    start: Node,
    index: u32,
    proof: &Vec<Node>,
) -> Result<Node, Error> {
    let mut cur = start;
    let mut idx = index;
    for sib in proof.iter() {
        if sib.dep < 0 || sib.loan < 0 {
            return Err(Error::NegativeSum);
        }
        cur = if idx & 1 == 0 {
            parent(env, &cur, &sib)?
        } else {
            parent(env, &sib, &cur)?
        };
        idx >>= 1;
    }
    Ok(cur)
}

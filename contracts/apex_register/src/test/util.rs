//! Shared test harness: a world with registrar, apex, custodian and member boards, and a
//! Merkle sum tree builder that uses the contract's own hashing functions.
extern crate std;

use crate::merkle;
use crate::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Bytes, BytesN, Env, Symbol, Vec};

pub const DAY: u64 = 86_400;
/// 2026-08-31T00:00:00Z, the August balance date.
pub const AS_OF_AUG: u64 = 1_788_134_400;
/// 2026-09-01T07:00:00Z, when the August period is opened in the tests.
pub const T_OPEN: u64 = 1_788_246_000;
pub const CONFIRM_WINDOW: u64 = 10 * DAY;
pub const ATTEST_WINDOW: u64 = 5 * DAY;
pub const MAX_GAP: u64 = 45 * DAY;
pub const PERFORMING_MAX_DAYS: u32 = 90;
pub const ALERT_BPS: u32 = 10_000;
/// KES cents.
pub const KES: i128 = 100;

pub fn h(env: &Env, s: &str) -> BytesN<32> {
    env.crypto()
        .sha256(&Bytes::from_slice(env, s.as_bytes()))
        .into()
}

pub fn zero32(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

pub struct World {
    pub env: Env,
    pub id: Address,
    pub c: ApexRegisterClient<'static>,
    pub registrar: Address,
    pub apex: Address,
    pub custodian: Address,
    /// boards[no] is member `no`'s board (index 0 unused).
    pub boards: std::vec::Vec<Address>,
}

impl World {
    /// Registrar, apex and custodian set; `members` boards registered (1..=members).
    pub fn new(members: u32) -> World {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        env.mock_all_auths();
        env.ledger().set_timestamp(T_OPEN - DAY);
        let id = env.register(ApexRegister, ());
        let c = ApexRegisterClient::new(&env, &id);
        let registrar = Address::generate(&env);
        let apex = Address::generate(&env);
        let custodian = Address::generate(&env);
        c.init(
            &registrar,
            &apex,
            &Symbol::new(&env, "KES"),
            &2,
            &CONFIRM_WINDOW,
            &ATTEST_WINDOW,
            &MAX_GAP,
            &PERFORMING_MAX_DAYS,
            &ALERT_BPS,
        );
        let mut boards = std::vec![apex.clone()];
        for no in 1..=members {
            let b = Address::generate(&env);
            c.register_member(&no, &b, &h(&env, &std::format!("licence-{no}")));
            boards.push(b);
        }
        c.set_custodian(&custodian, &true);
        World {
            env,
            id,
            c,
            registrar,
            apex,
            custodian,
            boards,
        }
    }

    pub fn at(&self, t: u64) {
        self.env.ledger().set_timestamp(t);
    }

    pub fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    /// Open a period at `T_OPEN` for `AS_OF_AUG`, attest `cash`, post `tree`.
    pub fn open_post(&self, tree: &Tree, cash: i128) -> u32 {
        self.at(T_OPEN);
        let p = self.c.open_period(&AS_OF_AUG, &0);
        self.c.attest_cash(
            &p,
            &self.custodian,
            &cash,
            &AS_OF_AUG,
            &h(&self.env, "statement"),
        );
        self.c
            .post_root(&p, &tree.root(), &tree.leaf_count(), &h(&self.env, "file"));
        p
    }

    pub fn confirm(&self, p: u32, tree: &Tree, i: u32) {
        let l = tree.leaf(i);
        self.c.confirm(&p, &l.cp, &l, &tree.proof(i));
    }
}

/// A Merkle sum tree built exactly as `app/src/tree/build.ts` builds it.
#[allow(dead_code)]
pub struct Tree {
    pub env: Env,
    pub period: u32,
    pub leaves: std::vec::Vec<Leaf>,
    /// levels[0] = padded leaf nodes, last level = [root]
    pub levels: std::vec::Vec<std::vec::Vec<Node>>,
}

pub struct Line {
    pub cp: u32,
    pub kind: u32,
    pub balance: i128,
    pub arrears: u32,
}

pub fn dep(cp: u32, balance: i128) -> Line {
    Line {
        cp,
        kind: KIND_DEPOSIT,
        balance,
        arrears: 0,
    }
}

pub fn loan(cp: u32, balance: i128, arrears: u32) -> Line {
    Line {
        cp,
        kind: KIND_LOAN,
        balance,
        arrears,
    }
}

#[allow(dead_code)]
impl Tree {
    pub fn build(env: &Env, period: u32, lines: &[Line]) -> Tree {
        let leaves: std::vec::Vec<Leaf> = lines
            .iter()
            .enumerate()
            .map(|(i, l)| Leaf {
                period,
                index: i as u32,
                cp: l.cp,
                kind: l.kind,
                line_ref: h(env, &std::format!("REF-{period}-{i}")),
                balance: l.balance,
                arrears_days: l.arrears,
                salt: h(env, &std::format!("SALT-{period}-{i}")),
            })
            .collect();
        Self::from_leaves(env, period, leaves)
    }

    pub fn from_leaves(env: &Env, period: u32, leaves: std::vec::Vec<Leaf>) -> Tree {
        let n = leaves.len() as u32;
        let depth = merkle::depth_for(n);
        let width = 1u32 << depth;
        let mut level: std::vec::Vec<Node> = std::vec::Vec::new();
        for i in 0..width {
            if i < n {
                level.push(merkle::leaf_node(env, &leaves[i as usize]));
            } else {
                level.push(merkle::empty_node(env, period, i));
            }
        }
        let mut levels = std::vec![level];
        while levels.last().unwrap().len() > 1 {
            let prev = levels.last().unwrap();
            let next: std::vec::Vec<Node> = prev
                .chunks(2)
                .map(|p| merkle::parent(env, &p[0], &p[1]).unwrap())
                .collect();
            levels.push(next);
        }
        Tree {
            env: env.clone(),
            period,
            leaves,
            levels,
        }
    }

    pub fn root(&self) -> Node {
        self.levels.last().unwrap()[0].clone()
    }

    pub fn leaf_count(&self) -> u32 {
        self.leaves.len() as u32
    }

    pub fn depth(&self) -> u32 {
        (self.levels.len() - 1) as u32
    }

    pub fn leaf(&self, i: u32) -> Leaf {
        self.leaves[i as usize].clone()
    }

    pub fn proof(&self, i: u32) -> Vec<Node> {
        let mut out = Vec::new(&self.env);
        let mut idx = i as usize;
        for lvl in &self.levels[..self.levels.len() - 1] {
            out.push_back(lvl[idx ^ 1].clone());
            idx >>= 1;
        }
        out
    }

    /// Indexes of the lines booked to `cp`.
    pub fn lines_of(&self, cp: u32) -> std::vec::Vec<u32> {
        self.leaves
            .iter()
            .filter(|l| l.cp == cp)
            .map(|l| l.index)
            .collect()
    }
}

/// Assert a contract call failed with exactly this contract error.
#[macro_export]
macro_rules! assert_err {
    ($call:expr, $err:expr) => {
        match $call {
            Err(Ok(e)) => assert_eq!(e, $err),
            other => panic!("expected {:?}, got {:?}", $err, other),
        }
    };
}

// ------------------------------------------------------------------ JSON vector helpers

pub fn vectors_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("vectors")
}

pub fn load_vector(name: &str) -> serde_json::Value {
    let p = vectors_dir().join(name);
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&text).unwrap()
}

pub fn hex32(env: &Env, s: &str) -> BytesN<32> {
    assert_eq!(s.len(), 64, "expected 32-byte hex, got {s}");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    BytesN::from_array(env, &out)
}

pub fn js_i128(v: &serde_json::Value) -> i128 {
    match v {
        serde_json::Value::String(s) => s.parse().unwrap(),
        serde_json::Value::Number(n) => n.as_i64().unwrap() as i128,
        _ => panic!("not an integer: {v}"),
    }
}

pub fn js_u32(v: &serde_json::Value) -> u32 {
    v.as_u64().unwrap_or_else(|| panic!("not a u32: {v}")) as u32
}

pub fn js_u64(v: &serde_json::Value) -> u64 {
    v.as_u64().unwrap_or_else(|| panic!("not a u64: {v}"))
}

pub fn leaf_from_json(env: &Env, j: &serde_json::Value) -> Leaf {
    Leaf {
        period: js_u32(&j["period"]),
        index: js_u32(&j["index"]),
        cp: js_u32(&j["cp"]),
        kind: js_u32(&j["kind"]),
        line_ref: hex32(env, j["line_ref"].as_str().unwrap()),
        balance: js_i128(&j["balance"]),
        arrears_days: js_u32(&j["arrears_days"]),
        salt: hex32(env, j["salt"].as_str().unwrap()),
    }
}

pub fn node_from_json(env: &Env, j: &serde_json::Value) -> Node {
    Node {
        hash: hex32(env, j["hash"].as_str().unwrap()),
        dep: js_i128(&j["dep"]),
        loan: js_i128(&j["loan"]),
    }
}

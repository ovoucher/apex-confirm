//! Merkle vectors shared with the TypeScript tree builder (`app/src/tree`). The TypeScript
//! seed generator writes the files; these tests recompute every hash with the contract's
//! own `env.crypto().sha256` code path and require byte-for-byte equality.
extern crate std;

use super::util::*;
use crate::merkle;
use crate::*;
use soroban_sdk::{Env, Vec};

fn check_vector_file(name: &str) -> (Env, Tree, serde_json::Value) {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let v = load_vector(name);
    let period = js_u32(&v["period"]);
    let mut leaves = std::vec::Vec::new();
    for lj in v["leaves"].as_array().unwrap() {
        let leaf = leaf_from_json(&env, lj);
        // leaf hash and leaf node
        assert_eq!(merkle::leaf_hash(&env, &leaf), hex32(&env, lj["leaf_hash"].as_str().unwrap()), "leaf hash {}", leaf.index);
        assert_eq!(merkle::leaf_node(&env, &leaf), node_from_json(&env, &lj["node"]));
        leaves.push(leaf);
    }
    for pj in v["padding"].as_array().unwrap() {
        let idx = js_u32(&pj["index"]);
        assert_eq!(merkle::empty_node(&env, period, idx), node_from_json(&env, &pj["node"]), "padding {idx}");
    }
    let tree = Tree::from_leaves(&env, period, leaves);
    // every level, node by node
    let levels = v["levels"].as_array().unwrap();
    assert_eq!(levels.len(), tree.levels.len());
    for (k, lv) in levels.iter().enumerate() {
        for (i, nj) in lv.as_array().unwrap().iter().enumerate() {
            assert_eq!(tree.levels[k][i], node_from_json(&env, nj), "level {k} node {i}");
        }
    }
    assert_eq!(tree.root(), node_from_json(&env, &v["root"]));
    assert_eq!(tree.depth(), js_u32(&v["depth"]));
    // proofs as written by TypeScript verify here, and equal ours
    for (i, pj) in v["proofs"].as_array().unwrap().iter().enumerate() {
        let mut proof: Vec<Node> = Vec::new(&env);
        for nj in pj.as_array().unwrap() {
            proof.push_back(node_from_json(&env, nj));
        }
        assert_eq!(proof, tree.proof(i as u32));
        let r = merkle::root_from_proof(&env, merkle::leaf_node(&env, &tree.leaf(i as u32)), i as u32, &proof).unwrap();
        assert_eq!(r, tree.root());
    }
    (env, tree, v)
}

#[test]
fn five_leaf_vector_matches_typescript() {
    let (_env, tree, v) = check_vector_file("tree5.json");
    assert_eq!(tree.leaf_count(), 5);
    assert_eq!(tree.depth(), 3);
    assert_eq!(v["padding"].as_array().unwrap().len(), 3);
    // root sums: deposits 61,250,000.00 + 0.01; loans 18,400,000.50 + 9,990,000.00 + 100,000,000.00
    assert_eq!(tree.root().dep, 61_250_000_00 + 1);
    assert_eq!(tree.root().loan, 18_400_000_50 + 9_990_000_00 + 100_000_000_00);
}

#[test]
fn one_leaf_tree_has_depth_one() {
    let (env, tree, _v) = check_vector_file("tree1.json");
    assert_eq!(merkle::depth_for(1), 1);
    assert_eq!(tree.depth(), 1);
    assert_eq!(tree.proof(0).len(), 1);
    // the single sibling is the padding leaf for index 1
    assert_eq!(tree.proof(0).get(0).unwrap(), merkle::empty_node(&env, 1, 1));
    // and it confirms through the contract
    let w = World::new(1);
    let t = Tree::build(&w.env, 1, &[dep(1, 12_000_000 * KES)]);
    let p = w.open_post(&t, 0);
    assert_eq!(w.c.period(&p).unwrap().depth, 1);
    w.confirm(p, &t, 0);
}

#[test]
fn depth_formula() {
    assert_eq!(merkle::depth_for(2), 1);
    assert_eq!(merkle::depth_for(3), 2);
    assert_eq!(merkle::depth_for(5), 3);
    assert_eq!(merkle::depth_for(159), 8);
    assert_eq!(merkle::depth_for(4095), 12);
    assert_eq!(merkle::depth_for(4096), 12);
}

#[test]
fn a_4096_leaf_proof_verifies_at_depth_12() {
    let w = World::new(3);
    let mut lines = std::vec::Vec::new();
    for i in 0..4096u32 {
        lines.push(if i % 3 == 0 { dep(1 + i % 3, 1_000 + i as i128) } else { loan(1 + i % 3, 500 + i as i128, i % 100) });
    }
    let t = Tree::build(&w.env, 1, &lines);
    assert_eq!(t.depth(), 12);
    let p = w.open_post(&t, 0);
    assert_eq!(w.c.period(&p).unwrap().depth, 12);
    w.confirm(p, &t, 4095);
    w.confirm(p, &t, 0);
    w.confirm(p, &t, 2049);
    assert_eq!(w.c.tally(&p).unwrap().responded, 3);
}

#[test]
fn seed_period_roots_match_typescript() {
    for name in ["seed-period-1.json", "seed-period-2.json"] {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let v = load_vector(name);
        let period = js_u32(&v["period"]);
        let leaves: std::vec::Vec<Leaf> = v["leaves"].as_array().unwrap().iter().map(|j| leaf_from_json(&env, j)).collect();
        assert_eq!(leaves.len() as u32, js_u32(&v["leaf_count"]));
        let tree = Tree::from_leaves(&env, period, leaves);
        assert_eq!(tree.root(), node_from_json(&env, &v["root"]), "{name}");
        assert_eq!(tree.depth(), js_u32(&v["depth"]));
    }
}

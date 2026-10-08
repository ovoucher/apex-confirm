/**
 * Leaf encoding, identical to the contract:
 *   leaf  = sha256("APEX-LEAF-v1" ‖ period ‖ index ‖ cp ‖ kind ‖ line_ref ‖ balance ‖ arrears_days ‖ salt)
 *   empty = sha256("APEX-EMPTY-v1" ‖ period ‖ index)
 * u32 big-endian (4 bytes), i128 big-endian (16 bytes), line_ref and salt 32 bytes each.
 */
import { fromHex, hex, i128be, sha256, u32be } from "../util/hash.js";
import type { SumNode } from "./node.js";

export const LEAF_TAG = "APEX-LEAF-v1";
export const EMPTY_TAG = "APEX-EMPTY-v1";
export const KIND_DEPOSIT = 1;
export const KIND_LOAN = 2;

export interface Leaf {
  period: number;
  index: number;
  cp: number;
  kind: number;
  lineRef: Buffer;
  balance: bigint;
  arrearsDays: number;
  salt: Buffer;
}

/** JSON form used in tree.json, packs and the shared vectors. */
export interface LeafJson {
  period: number;
  index: number;
  cp: number;
  kind: number;
  line_ref: string;
  balance: string;
  arrears_days: number;
  salt: string;
}

export function leafBytes(l: Leaf): Buffer {
  if (l.lineRef.length !== 32 || l.salt.length !== 32) throw new Error("line_ref and salt must be 32 bytes");
  return Buffer.concat([
    Buffer.from(LEAF_TAG, "utf8"),
    u32be(l.period),
    u32be(l.index),
    u32be(l.cp),
    u32be(l.kind),
    l.lineRef,
    i128be(l.balance),
    u32be(l.arrearsDays),
    l.salt,
  ]);
}

export function leafHash(l: Leaf): Buffer {
  return sha256(leafBytes(l));
}

export function leafNode(l: Leaf): SumNode {
  return {
    hash: leafHash(l),
    dep: l.kind === KIND_DEPOSIT ? l.balance : 0n,
    loan: l.kind === KIND_LOAN ? l.balance : 0n,
  };
}

export function emptyNode(period: number, index: number): SumNode {
  return { hash: sha256(EMPTY_TAG, u32be(period), u32be(index)), dep: 0n, loan: 0n };
}

export function leafToJson(l: Leaf): LeafJson {
  return {
    period: l.period,
    index: l.index,
    cp: l.cp,
    kind: l.kind,
    line_ref: hex(l.lineRef),
    balance: l.balance.toString(),
    arrears_days: l.arrearsDays,
    salt: hex(l.salt),
  };
}

export function leafFromJson(j: LeafJson): Leaf {
  return {
    period: j.period,
    index: j.index,
    cp: j.cp,
    kind: j.kind,
    lineRef: fromHex(j.line_ref, 32),
    balance: BigInt(j.balance),
    arrearsDays: j.arrears_days,
    salt: fromHex(j.salt, 32),
  };
}

/** line_ref = sha256 of the apex's account or loan number (trimmed, as written in the book). */
export function lineRefHash(accountNo: string): Buffer {
  return sha256(accountNo.trim());
}

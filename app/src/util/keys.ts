/**
 * Deterministic TEST keys for the seed and the offline demo. Never use for anything real.
 */
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { sha256 } from "./hash.js";

export function testKeypair(label: string): Keypair {
  return Keypair.fromRawEd25519Seed(sha256(`apex-confirm-test-key/${label}`));
}

/** A stand-in contract address for member `no`'s board_account in offline runs. */
export function boardContractAddress(no: number): string {
  return StrKey.encodeContract(sha256(`apex-confirm-test-board/${no}`));
}

export function registerContractAddress(): string {
  return StrKey.encodeContract(sha256("apex-confirm-test-register"));
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { Account, Address, Keypair, Networks, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import { authPayload, boardSignatureScVal, buildTransaction, call, decodeInvocation, enc, entryAddress, signBoardEntry } from "../src/register/client.js";
import { errorFromHostMessage } from "../src/register/errors.js";
import { sha256 } from "../src/util/hash.js";
import { smallTree } from "./helpers.js";

const CONTRACT = StrKey.encodeContract(sha256("register"));
const BOARD = StrKey.encodeContract(sha256("board-7"));

test("leaf and node encode as ScMaps with sorted field names (contracttype layout)", () => {
  const t = smallTree(1, [[7, "L", 1_250_000_000n, 12], [7, "D", 5n]]);
  const v = enc.leaf(t.leaves[0]!);
  const keys = (v as any).map.map((e: any) => e.key.sym!.toString());
  assert.deepEqual(keys, ["arrears_days", "balance", "cp", "index", "kind", "line_ref", "period", "salt"]);
  const native = scValToNative(v) as Record<string, unknown>;
  assert.equal(native.balance, 1_250_000_000n);
  assert.equal(native.cp, 7);
  const n = enc.node(t.root);
  assert.deepEqual((n as any).map.map((e: any) => e.key.sym!.toString()), ["dep", "hash", "loan"]);
  // Vec<(Leaf, Vec<Node>)>
  const b = enc.batch([{ leaf: t.leaves[0]!, proof: t.proof(0) }]);
  assert.equal((b as any).vec.length, 1);
  assert.equal((b as any).vec[0].vec.length, 2);
});

test("transactions build offline and decode back to the same invocation", () => {
  const t = smallTree(3, [[7, "L", 99n, 0], [8, "D", 5n]]);
  const inv = call.dispute(CONTRACT, 3, 7, t.leaves[0]!, t.proof(0), 40n, 0, 1, sha256("evidence.pdf"));
  const src = new Account(Keypair.fromRawEd25519Seed(sha256("src")).publicKey(), "41");
  const tx = buildTransaction(src, inv, Networks.TESTNET);
  assert.equal(tx.sequence, "42");
  const back = decodeInvocation(tx);
  assert.equal(back.contractId, CONTRACT);
  assert.equal(back.method, "dispute");
  assert.equal(back.args.length, 8);
  assert.equal(scValToNative(back.args[4]!), 40n);
  const close = decodeInvocation(buildTransaction(src, call.closePeriod(CONTRACT, 9), Networks.TESTNET));
  assert.equal(close.method, "close_period");
  assert.equal(scValToNative(close.args[0]!), 9);
  assert.throws(() => enc.bytes32(Buffer.alloc(31)));
});

function unsignedEntry(): xdr.SorobanAuthorizationEntry {
  const t = smallTree(1, [[7, "L", 99n, 0], [8, "D", 5n]]);
  const inv = call.confirm(CONTRACT, 1, 7, t.leaves[0]!, t.proof(0));
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: new Address(BOARD).toScAddress(), nonce: 1234n, signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: new Address(CONTRACT).toScAddress(), functionName: "confirm", args: inv.args }),
      ),
      subInvocations: [],
    }),
  });
}

test("board_account auth entry: two officers sign the exact payload, sorted by public key", async () => {
  const officers = [1, 2, 3].map((i) => Keypair.fromRawEd25519Seed(sha256(`officer-${i}`)));
  const entry = unsignedEntry();
  assert.equal(entryAddress(entry), BOARD);
  const signed = await signBoardEntry(entry, [officers[2]!, officers[0]!], 5000, Networks.TESTNET);
  const creds = (signed.credentials as unknown as { address: xdr.SorobanAddressCredentials }).address;
  assert.equal(creds.signatureExpirationLedger, 5000);
  assert.equal(creds.nonce, 1234n);
  const sigs = scValToNative(creds.signature) as { public_key: Buffer; signature: Buffer }[];
  assert.equal(sigs.length, 2);
  assert.ok(Buffer.compare(Buffer.from(sigs[0]!.public_key), Buffer.from(sigs[1]!.public_key)) < 0, "ascending by key");
  const payload = authPayload(signed, 5000, Networks.TESTNET);
  for (const s of sigs) {
    const kp = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(Buffer.from(s.public_key)));
    assert.ok(kp.verify(payload, Buffer.from(s.signature)), "signature verifies over the payload");
  }
  // a different network gives a different payload
  assert.ok(!authPayload(signed, 5000, Networks.PUBLIC).equals(payload));
});

test("the signature value is Vec<Sig{public_key, signature}>", () => {
  const k = Keypair.fromRawEd25519Seed(sha256("o"));
  const v = boardSignatureScVal(Buffer.alloc(32, 7), [k]);
  const m = (v as any).vec[0].map;
  assert.deepEqual(m.map((e: any) => e.key.sym!.toString()), ["public_key", "signature"]);
  assert.equal((scValToNative(m[1].val) as Buffer).length, 64);
});

test("host error messages map to contract error names", () => {
  assert.equal(errorFromHostMessage("HostError: Error(Contract, #23)"), "BadProof");
  assert.equal(errorFromHostMessage("Error(Contract, #33) ..."), "CustodianMissing");
  assert.equal(errorFromHostMessage("Error(Auth, InvalidAction)"), null);
});

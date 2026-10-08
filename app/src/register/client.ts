/**
 * Live register client: argument encoding, transaction building, board-account auth entry
 * signing, simulation and submission against a Soroban RPC. Everything up to `submit` is
 * pure and tested offline; `LiveRegister` talks to the network and was not exercised from
 * this environment (testnet RPC unreachable).
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  contract as contractNs,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Leaf } from "../tree/leaf.js";
import type { SumNode } from "../tree/node.js";
import { errorFromHostMessage } from "./errors.js";

export interface LiveConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  allowHttp?: boolean;
}

// ------------------------------------------------------------------ ScVal encoders

const sym = (s: string): xdr.ScVal => xdr.ScVal.scvSymbol(s);

/** A `#[contracttype]` struct is an ScMap keyed by field-name symbols, sorted. */
function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k]! })),
  );
}

export const enc = {
  u32: (n: number): xdr.ScVal => nativeToScVal(n, { type: "u32" }),
  u64: (n: number | bigint): xdr.ScVal => nativeToScVal(BigInt(n), { type: "u64" }),
  i128: (n: bigint): xdr.ScVal => nativeToScVal(n, { type: "i128" }),
  bool: (b: boolean): xdr.ScVal => xdr.ScVal.scvBool(b),
  symbol: sym,
  address: (a: string): xdr.ScVal => new Address(a).toScVal(),
  bytes32: (b: Buffer): xdr.ScVal => {
    if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
    return xdr.ScVal.scvBytes(b);
  },
  node: (n: SumNode): xdr.ScVal => struct({ hash: enc.bytes32(n.hash), dep: enc.i128(n.dep), loan: enc.i128(n.loan) }),
  proof: (p: SumNode[]): xdr.ScVal => xdr.ScVal.scvVec(p.map(enc.node)),
  leaf: (l: Leaf): xdr.ScVal =>
    struct({
      period: enc.u32(l.period),
      index: enc.u32(l.index),
      cp: enc.u32(l.cp),
      kind: enc.u32(l.kind),
      line_ref: enc.bytes32(l.lineRef),
      balance: enc.i128(l.balance),
      arrears_days: enc.u32(l.arrearsDays),
      salt: enc.bytes32(l.salt),
    }),
  /** Vec<(Leaf, Vec<Node>)>: a tuple is an ScVec. */
  batch: (items: { leaf: Leaf; proof: SumNode[] }[]): xdr.ScVal =>
    xdr.ScVal.scvVec(items.map((it) => xdr.ScVal.scvVec([enc.leaf(it.leaf), enc.proof(it.proof)]))),
};

// ------------------------------------------------------------------ invocations

export interface Invocation {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}

export const call = {
  init: (c: string, p: { registrar: string; apex: string; currency: string; decimals: number; confirm: number; attest: number; gap: number; performing: number; alertBps: number }): Invocation => ({
    contractId: c,
    method: "init",
    args: [enc.address(p.registrar), enc.address(p.apex), enc.symbol(p.currency), enc.u32(p.decimals), enc.u64(p.confirm), enc.u64(p.attest), enc.u64(p.gap), enc.u32(p.performing), enc.u32(p.alertBps)],
  }),
  registerMember: (c: string, no: number, board: string, licenceHash: Buffer): Invocation => ({ contractId: c, method: "register_member", args: [enc.u32(no), enc.address(board), enc.bytes32(licenceHash)] }),
  setMemberActive: (c: string, no: number, active: boolean): Invocation => ({ contractId: c, method: "set_member_active", args: [enc.u32(no), enc.bool(active)] }),
  rotateBoard: (c: string, no: number, board: string): Invocation => ({ contractId: c, method: "rotate_board", args: [enc.u32(no), enc.address(board)] }),
  setCustodian: (c: string, custodian: string, active: boolean): Invocation => ({ contractId: c, method: "set_custodian", args: [enc.address(custodian), enc.bool(active)] }),
  openPeriod: (c: string, asOf: number, supersedes: number): Invocation => ({ contractId: c, method: "open_period", args: [enc.u64(asOf), enc.u32(supersedes)] }),
  postRoot: (c: string, period: number, root: SumNode, leafCount: number, fileHash: Buffer): Invocation => ({
    contractId: c,
    method: "post_root",
    args: [enc.u32(period), enc.node(root), enc.u32(leafCount), enc.bytes32(fileHash)],
  }),
  confirm: (c: string, period: number, member: number, leaf: Leaf, proof: SumNode[]): Invocation => ({ contractId: c, method: "confirm", args: [enc.u32(period), enc.u32(member), enc.leaf(leaf), enc.proof(proof)] }),
  confirmBatch: (c: string, period: number, member: number, items: { leaf: Leaf; proof: SumNode[] }[]): Invocation => ({ contractId: c, method: "confirm_batch", args: [enc.u32(period), enc.u32(member), enc.batch(items)] }),
  dispute: (c: string, period: number, member: number, leaf: Leaf, proof: SumNode[], claimed: bigint, claimedArrears: number, reason: number, evidence: Buffer): Invocation => ({
    contractId: c,
    method: "dispute",
    args: [enc.u32(period), enc.u32(member), enc.leaf(leaf), enc.proof(proof), enc.i128(claimed), enc.u32(claimedArrears), enc.u32(reason), enc.bytes32(evidence)],
  }),
  claimOmitted: (c: string, period: number, member: number, claimed: bigint, evidence: Buffer): Invocation => ({ contractId: c, method: "claim_omitted", args: [enc.u32(period), enc.u32(member), enc.i128(claimed), enc.bytes32(evidence)] }),
  attestCash: (c: string, period: number, custodian: string, balance: bigint, asOf: number, statementHash: Buffer): Invocation => ({
    contractId: c,
    method: "attest_cash",
    args: [enc.u32(period), enc.address(custodian), enc.i128(balance), enc.u64(asOf), enc.bytes32(statementHash)],
  }),
  closePeriod: (c: string, period: number): Invocation => ({ contractId: c, method: "close_period", args: [enc.u32(period)] }),
  markOverdue: (c: string, period: number, max: number): Invocation => ({ contractId: c, method: "mark_overdue", args: [enc.u32(period), enc.u32(max)] }),
  flagStaleApex: (c: string): Invocation => ({ contractId: c, method: "flag_stale_apex", args: [] }),
  view: (c: string, method: string, args: xdr.ScVal[] = []): Invocation => ({ contractId: c, method, args }),
};

export function invocationOp(inv: Invocation): xdr.Operation {
  return new Contract(inv.contractId).call(inv.method, ...inv.args);
}

export function buildTransaction(source: Account, inv: Invocation, networkPassphrase: string, fee: string = BASE_FEE, timeoutSeconds = 120): Transaction {
  return new TransactionBuilder(source, { fee, networkPassphrase }).addOperation(invocationOp(inv)).setTimeout(timeoutSeconds).build();
}

export function decodeInvocation(tx: Transaction): Invocation {
  const op = tx.operations[0] as Operation.InvokeHostFunction | undefined;
  if (!op || op.type !== "invokeHostFunction") throw new Error("not an invoke host function op");
  const fn = op.func;
  if (fn.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract invocation");
  const ic = fn.invokeContract;
  return { contractId: Address.fromScAddress(ic.contractAddress).toString(), method: String(ic.functionName), args: [...ic.args] };
}

// ------------------------------------------------------------------ board_account auth entries

/** The 32-byte payload a Soroban custom account's `__check_auth` receives for this entry. */
export function authPayload(entry: xdr.SorobanAuthorizationEntry, validUntilLedger: number, networkPassphrase: string): Buffer {
  return Buffer.from(hash(Buffer.from(buildAuthorizationEntryPreimage(entry, validUntilLedger, networkPassphrase).toXdr())));
}

/** `Vec<Sig>` for board_account: one `{public_key, signature}` struct per officer, ascending by key. */
export function boardSignatureScVal(payload: Uint8Array, officers: Keypair[]): xdr.ScVal {
  const sigs = officers
    .map((k) => ({ pk: Buffer.from(k.rawPublicKey()), sig: Buffer.from(k.sign(Buffer.from(payload))) }))
    .sort((a, b) => Buffer.compare(a.pk, b.pk))
    .map((x) => struct({ public_key: xdr.ScVal.scvBytes(x.pk), signature: xdr.ScVal.scvBytes(x.sig) }));
  return xdr.ScVal.scvVec(sigs);
}

/**
 * Sign an address-credential auth entry for a `board_account` with officer keys, through the
 * SDK's `authorizeEntry` (which sets the expiration and computes the preimage).
 */
export async function signBoardEntry(entry: xdr.SorobanAuthorizationEntry, officers: Keypair[], validUntilLedger: number, networkPassphrase: string): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeEntry(entry, async (_preimage, payload) => ({ signatureScVal: boardSignatureScVal(payload, officers) }), validUntilLedger, networkPassphrase);
}

/** Address of an entry's credentials, or null for source-account credentials. */
export function entryAddress(entry: xdr.SorobanAuthorizationEntry): string | null {
  const c = entry.credentials;
  if (c.type !== "sorobanCredentialsAddress") return null;
  return Address.fromScAddress(c.address.address).toString();
}

// ------------------------------------------------------------------ network (not exercised here)

export class LiveError extends Error {
  constructor(message: string, public readonly contractError: string | null) {
    super(message);
  }
}

export class LiveRegister {
  readonly server: rpc.Server;
  constructor(public readonly cfg: LiveConfig) {
    this.server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.allowHttp ?? cfg.rpcUrl.startsWith("http://") });
  }

  /** Read-only call through simulation. */
  async view(method: string, args: xdr.ScVal[] = []): Promise<unknown> {
    const src = new Account(contractNs.NULL_ACCOUNT, "0");
    const tx = buildTransaction(src, call.view(this.cfg.contractId, method, args), this.cfg.networkPassphrase);
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new LiveError(sim.error, errorFromHostMessage(sim.error));
    return sim.result ? scValToNative(sim.result.retval) : null;
  }

  /**
   * Simulate, sign any board_account auth entries with officer keys, re-simulate, assemble,
   * sign the envelope with `source` (the fee payer) and submit.
   */
  async submit(inv: Invocation, source: Keypair, boards: { address: string; officers: Keypair[] }[] = []): Promise<{ hash: string; returnValue: unknown }> {
    const account = await this.server.getAccount(source.publicKey());
    let tx = buildTransaction(account, inv, this.cfg.networkPassphrase, "1000000");
    let sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new LiveError(sim.error, errorFromHostMessage(sim.error));
    const entries = sim.result?.auth ?? [];
    if (boards.length && entries.length) {
      const latest = await this.server.getLatestLedger();
      const until = latest.sequence + 100;
      const signed = await Promise.all(
        entries.map((e) => {
          const addr = entryAddress(e);
          const b = boards.find((x) => x.address === addr);
          return b ? signBoardEntry(e, b.officers, until, this.cfg.networkPassphrase) : Promise.resolve(e);
        }),
      );
      const op = tx.operations[0] as Operation.InvokeHostFunction;
      const account2 = await this.server.getAccount(source.publicKey());
      tx = new TransactionBuilder(account2, { fee: "1000000", networkPassphrase: this.cfg.networkPassphrase })
        .addOperation(Operation.invokeHostFunction({ func: op.func, auth: signed }))
        .setTimeout(120)
        .build();
      sim = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) throw new LiveError(sim.error, errorFromHostMessage(sim.error));
    }
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(source);
    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR") throw new LiveError(`send failed: ${JSON.stringify(sent.errorResult)}`, null);
    for (let i = 0; i < 30; i++) {
      const got = await this.server.getTransaction(sent.hash);
      if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { hash: sent.hash, returnValue: got.returnValue ? scValToNative(got.returnValue) : null };
      }
      if (got.status === rpc.Api.GetTransactionStatus.FAILED) throw new LiveError(`transaction ${sent.hash} failed`, null);
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new LiveError(`transaction ${sent.hash} not confirmed after 30s`, null);
  }
}

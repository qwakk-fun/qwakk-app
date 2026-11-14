/**
 * Accounts, clients and chain reads for the Pond Vault CLI.
 *
 * Keys live only in this process, read from environment variables the owner
 * sets locally (contracts/.env, never committed). Nothing here prints a secret.
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  deriveUnifiedAccount,
  getNetwork,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { PRECOMPILE_ADDRESSES, classifyEvmWindowRejection, evmWindowStatus, qorechainTestnet, type EvmWindow } from "@qorechain/evm";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PQC_KEY_STATUS_ABI } from "./abi.js";

/**
 * Local rehearsal only: POND_DEVNET_RPC points the CLI at an anvil node whose
 * 0xA01/0xA02 hold the mock precompiles from test/utils/DevnetPrecompiles.sol.
 * QoreChain's window checks are skipped there (anvil has no native lane) and
 * the mock verifier accepts any well-formed signature. Never used on Diana.
 */
export function devnetRpc(): string | undefined {
  return process.env.POND_DEVNET_RPC?.trim() || undefined;
}

/** Diana only: the PQC precompiles are not active on mainnet (docs: developer-guide/evm-precompiles). */
export function network() {
  const devnet = devnetRpc();
  if (devnet) {
    return { chainId: "devnet", rest: "", rpc: "", evmRpc: devnet, evmChainId: Number(process.env.POND_DEVNET_CHAIN_ID?.trim() || "31337") };
  }
  const name = (process.env.QORE_NETWORK?.trim() || "testnet") as "testnet" | "mainnet";
  if (name !== "testnet") {
    throw new Error("The Pond Vault runs on QoreChain Diana (QORE_NETWORK=testnet) only: pqcVerify and pqcKeyStatus are not active on mainnet.");
  }
  const n = getNetwork("testnet");
  return {
    chainId: n.chainId,
    rest: process.env.QORE_REST_URL?.trim() || n.endpoints.rest,
    rpc: process.env.QORE_RPC_URL?.trim() || n.endpoints.rpc,
    evmRpc: process.env.QORE_EVM_RPC_URL?.trim() || qorechainTestnet.rpcUrls.default.http[0],
    evmChainId: qorechainTestnet.id,
  };
}

export const EXPLORER_TX = "https://explore.qore.network/tx/";
/** Explorer link on QoreChain; a bare hash on a local rehearsal node. */
export const txLink = (hash: string) => (devnetRpc() ? `local tx ${hash}` : `${EXPLORER_TX}${hash}`);

export function chain() {
  const net = network();
  // Plain fields of @qorechain/evm's qorechainTestnet, with an RPC override.
  return defineChain({
    id: net.evmChainId,
    name: qorechainTestnet.name,
    nativeCurrency: qorechainTestnet.nativeCurrency,
    rpcUrls: { default: { http: [net.evmRpc] } },
    blockExplorers: { default: { name: "QoreChain Explorer", url: "https://explore.qore.network" } },
  });
}

export function publicClient(): PublicClient {
  return createPublicClient({ chain: chain(), transport: http() }) as PublicClient;
}

function mnemonicFrom(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function accountIndex(name: string): number {
  const raw = process.env[name]?.trim() || "0";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
  return n;
}

/** The owner: sends every vault transaction and opens its EVM windows. */
export async function ownerAccount(): Promise<UnifiedAccount> {
  const m = mnemonicFrom("QORE_MNEMONIC");
  if (!m) throw new Error("Set QORE_MNEMONIC in contracts/.env (a testnet-only mnemonic; see .env.example).");
  return deriveUnifiedAccount(m, accountIndex("QORE_ACCOUNT_INDEX"));
}

/**
 * The approver: its registered ML-DSA-87 key signs approvals. Defaults to the
 * owner's account; set QORE_APPROVER_MNEMONIC to keep it on another machine.
 */
export async function approverAccount(): Promise<UnifiedAccount> {
  const m = mnemonicFrom("QORE_APPROVER_MNEMONIC") ?? mnemonicFrom("QORE_MNEMONIC");
  if (!m) throw new Error("Set QORE_APPROVER_MNEMONIC or QORE_MNEMONIC in contracts/.env.");
  const index = process.env.QORE_APPROVER_MNEMONIC?.trim() ? accountIndex("QORE_APPROVER_ACCOUNT_INDEX") : accountIndex("QORE_ACCOUNT_INDEX");
  return deriveUnifiedAccount(m, index);
}

export function walletClient(acc: UnifiedAccount) {
  return createWalletClient({ account: privateKeyToAccount(acc.privateKey as Hex), chain: chain(), transport: http() });
}

export function vaultAddress(required = true): Address | undefined {
  const raw = process.env.POND_VAULT_ADDRESS?.trim();
  if (!raw) {
    if (required) throw new Error("Set POND_VAULT_ADDRESS in contracts/.env (printed by `npm run pond -- deploy`).");
    return undefined;
  }
  if (!isAddress(raw, { strict: false })) throw new Error("POND_VAULT_ADDRESS is not a 0x address");
  return getAddress(raw);
}

/**
 * The precompile addresses from @qorechain/evm, normalised: the package spells
 * them `0x...0A01` / `0x...0A02`, which is not a valid EIP-55 checksum, so viem
 * refuses them as given (found in the anvil rehearsal, 2026-11-14).
 */
export const PQC_VERIFY_ADDRESS = getAddress(PRECOMPILE_ADDRESSES.pqcVerify.toLowerCase());
export const PQC_KEY_STATUS_ADDRESS = getAddress(PRECOMPILE_ADDRESSES.pqcKeyStatus.toLowerCase());

/** pqcKeyStatus over the precompile, the same answer the vault reads. */
export async function keyStatus(client: PublicClient, account: Address) {
  const [registered, algorithmId, pubkey, possessionProven] = await client.readContract({
    address: PQC_KEY_STATUS_ADDRESS,
    abi: PQC_KEY_STATUS_ABI,
    functionName: "pqcKeyStatus",
    args: [account],
  });
  return { registered, algorithmId, pubkey, possessionProven };
}

export async function windowStatus(acc: UnifiedAccount): Promise<EvmWindow> {
  if (devnetRpc()) {
    // anvil has no authorisation window: report an unlimited one.
    const big = 1n << 64n;
    return { found: true, live: true, openedHeight: 0n, expiryHeight: big, maxTxs: big, usedTxs: 0n, maxValue: big, usedValue: 0n, remainingBlocks: big, remainingTxs: big, remainingValue: big, nativeOnly: false, allowedTargets: [] };
  }
  return evmWindowStatus({ rest: network().rest, address: acc.cosmos });
}

/**
 * Refuse early, with the fix, when the window cannot admit a transaction to `target`.
 * The chain enforces this anyway; checking first saves a refused transaction.
 */
export async function requireWindowFor(acc: UnifiedAccount, target: Address | "create", costUqor: bigint): Promise<EvmWindow> {
  const w = await windowStatus(acc);
  if (!w.found || !w.live) throw new Error("No live EVM window. Open one first: npm run pond -- window vault (or window deploy).");
  if (w.remainingTxs < 1n) throw new Error("The EVM window has no transactions left. Open a new one.");
  if (w.remainingValue < costUqor) {
    throw new Error(`The EVM window has ${w.remainingValue} uqor left but this transaction may use up to ${costUqor} uqor. Open a larger window.`);
  }
  const scoped = w.allowedTargets.length > 0 || w.nativeOnly;
  if (target === "create" && scoped) throw new Error("A scoped window refuses contract creation. Open an unscoped one: npm run pond -- window deploy.");
  if (target !== "create" && w.allowedTargets.length > 0 && !w.allowedTargets.some((t) => t.toLowerCase() === target.toLowerCase())) {
    throw new Error(`The EVM window is scoped to ${w.allowedTargets.join(", ")}, not ${target}. Open one for the vault: npm run pond -- window vault.`);
  }
  return w;
}

/** Turn a refused EVM transaction into the step that fixes it. */
export function explainEvmError(error: unknown): string {
  const kind = classifyEvmWindowRejection(error);
  if (kind === "no-pqc-key") return "The account has no registered ML-DSA-87 key. Run: npm run pond -- register";
  if (kind === "no-window") return "No EVM window is open. Run: npm run pond -- window vault";
  if (kind === "exhausted") return "The EVM window is used up or the target is outside its scope. Open a new one.";
  if (kind === "invalid") return "The chain refused the window parameters.";
  const e = error as { shortMessage?: string; message?: string; cause?: { data?: { errorName?: string } } };
  const named = e?.cause?.data?.errorName;
  const short = (e?.shortMessage ?? e?.message ?? String(error)).split("\n")[0];
  return named ? `The vault refused it: ${named}` : short;
}

export type NativeMessages = Parameters<EthNativeSigner["sign"]>[0]["messages"];

/** A hybrid-signed (or, only for key registration, classical) native-lane transaction. */
export async function broadcastNative(acc: UnifiedAccount, mode: "hybrid" | "classical", messages: NativeMessages): Promise<string> {
  if (devnetRpc()) throw new Error("POND_DEVNET_RPC is set: native-lane transactions only exist on QoreChain.");
  const net = network();
  const res = await fetch(`${net.rest}/cosmos/auth/v1beta1/accounts/${acc.cosmos}`);
  if (res.status === 404) throw new Error(`${acc.cosmos} does not exist on chain yet: get test QOR from the faucet first.`);
  if (!res.ok) throw new Error(`account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const a = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: net.rest });
  const transport = await StargateClient.connect(net.rpc);
  try {
    // Same fee as the create-qorechain-dapp window helper: hybrid txs are large.
    const result = await signer.signAndBroadcast(transport, {
      chainId: net.chainId,
      accountNumber: BigInt(a.account_number ?? "0"),
      sequence: BigInt(a.sequence ?? "0"),
      fee: { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" },
      messages,
    });
    if (result.code !== 0) {
      throw new Error(`QoreChain refused the native transaction (code ${result.code}): ${txLink(result.transactionHash)}`);
    }
    return result.transactionHash;
  } finally {
    transport.disconnect();
  }
}

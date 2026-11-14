/**
 * Server-side, read-only view of the Qwakk Pond Vault for the /vault page.
 *
 * Reads the vault over the QoreChain EVM JSON-RPC (one batch request, plus
 * eth_getLogs for transaction links) and the owner's EVM window over REST
 * (`/qorechain/pqc/v1/evm_window/{qor1}`, the route `evmWindowStatus` in
 * @qorechain/evm reads). Nothing here signs or sends anything. Errors never
 * reach the browser: a failed read becomes `{ status: "unavailable" }`.
 */
import { DIANA_ASSETS } from "./qwakk-assets";
import {
  ZERO_ADDRESS,
  POND_VAULT_TOPICS,
  asAddress,
  asBool,
  asUint,
  decodeAction,
  displayAmount,
  encodeCall,
  isEvmAddress,
  words,
  type VaultActionName,
  type VaultStatusName,
} from "./qwakk-vault-abi";

/** Diana's public EVM RPC answers at most 10,000 blocks per eth_getLogs (checked 2026-11-14). */
export const LOG_CHUNK_BLOCKS = BigInt(9_999);
/** About 12 hours of Diana blocks (0.7 blocks per second, measured 2026-11-14). */
export const LOG_CHUNKS = 3;
export const RECENT_ACTIONS = 10;

/** QOR on the EVM lane uses the 18-decimal extended denom (aqor); 1 uqor = 10^12 wei. */
export const EVM_QOR_DECIMALS = 18;

export type VaultAsset = {
  symbol: string;
  /** The native denom, so the page can reuse TokenIcon. */
  denom: string;
  token: string;
  /** "Unavailable" when the token contract did not answer. */
  balance: string;
  dailyCap: string;
  remainingToday: string;
  /** Base units, as a decimal string, for comparing with queued withdrawals. */
  remainingTodayRaw: string;
};

export type VaultActionRow = {
  id: string;
  action: VaultActionName;
  status: VaultStatusName;
  eta: number;
  symbol: string | null;
  /** The token a withdrawal or cap change is about (0x0 for QOR), else null. */
  token: string | null;
  to: string | null;
  amount: string | null;
  /** Base units, as a decimal string, for withdrawals and cap changes. */
  amountRaw: string | null;
  queuedTx: string | null;
  settledTx: string | null;
};

export type VaultWindow = {
  found: boolean;
  live: boolean;
  remainingBlocks: string;
  remainingTxs: string;
  scope: "vault" | "elsewhere" | "unscoped" | "native-only";
};

export type VaultSnapshot =
  | { status: "unconfigured" }
  | { status: "unavailable" }
  | {
      status: "ok";
      address: string;
      owner: string;
      approver: string;
      guardian: string | null;
      paused: boolean;
      timelockSeconds: number;
      nonce: string;
      actionCount: string;
      approverKeyUsable: boolean;
      chainTime: number;
      assets: VaultAsset[];
      actions: VaultActionRow[];
      ownerWindow: VaultWindow | null;
    };

export type VaultReadConfig = {
  vault: string;
  evmRpcUrl: string;
  restUrl: string;
  /** qor1 form of an EVM address (the same 20 bytes). */
  toQorAddress: (evm: string) => string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** Validated vault address from the environment, or null. Testnet only: the PQC precompiles are off on mainnet. */
export function vaultAddressFromEnv(env: Readonly<Record<string, string | undefined>>, networkId: string): string | null {
  const raw = env.QWAKK_VAULT_ADDRESS?.trim() ?? "";
  if (networkId !== "testnet" || !isEvmAddress(raw) || raw.toLowerCase() === ZERO_ADDRESS) return null;
  return raw;
}

/** The ERC-20 tokens of the Diana registry, with their EVM addresses. */
export function vaultTokens() {
  return DIANA_ASSETS.filter((asset) => asset.denom.startsWith("erc20:0x")).map((asset) => ({
    symbol: asset.symbol,
    denom: asset.denom,
    token: asset.denom.slice("erc20:".length),
    decimals: asset.decimals,
  }));
}

type RpcRequest = { method: string; params: unknown[] };
type RpcReply = { id?: number; result?: unknown; error?: unknown };

/** Marks one call of a batch that the node answered with an error. */
const FAILED = Symbol("rpc call failed");

/** One HTTP request for many calls. A per-call error comes back as FAILED, not as a throw. */
async function rpcBatchSettled(config: VaultReadConfig, requests: RpcRequest[]): Promise<unknown[]> {
  const doFetch = config.fetch ?? fetch;
  const body = requests.map((r, id) => ({ jsonrpc: "2.0", id, method: r.method, params: r.params }));
  const response = await doFetch(config.evmRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(config.timeoutMs ?? 6_000),
  });
  if (!response.ok) throw new Error("rpc status");
  const replies = (await response.json()) as RpcReply[];
  if (!Array.isArray(replies)) throw new Error("rpc shape");
  const byId = new Map(replies.map((r) => [r.id, r]));
  return requests.map((_, id) => {
    const reply = byId.get(id);
    return !reply || reply.error !== undefined ? FAILED : reply.result;
  });
}

/** Every call must succeed: for the vault's own state, where a gap would mislead. */
async function rpcBatch(config: VaultReadConfig, requests: RpcRequest[]): Promise<unknown[]> {
  const results = await rpcBatchSettled(config, requests);
  if (results.includes(FAILED)) throw new Error("rpc error");
  return results;
}

/** A token's balance, or null when the token contract reverts, has no code or answers oddly. */
function tokenBalance(result: unknown): bigint | null {
  try {
    if (result === FAILED) return null;
    const data = hex(result);
    return data === "0x" ? null : asUint(words(data)[0]);
  } catch {
    return null;
  }
}

const call = (to: string, data: string): RpcRequest => ({ method: "eth_call", params: [{ to, data }, "latest"] });
const hex = (value: unknown) => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) throw new Error("not hex");
  return value;
};

export function parseWindow(body: unknown, vault: string): VaultWindow | null {
  if (!body || typeof body !== "object") return null;
  const w = body as Record<string, unknown>;
  if (typeof w.found !== "boolean") return null;
  const targets = Array.isArray(w.allowed_targets) ? w.allowed_targets.filter((t): t is string => typeof t === "string") : [];
  const scope: VaultWindow["scope"] = w.native_only === true
    ? "native-only"
    : targets.length === 0
      ? "unscoped"
      : targets.every((t) => t.toLowerCase() === vault.toLowerCase())
        ? "vault"
        : "elsewhere";
  const whole = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? v : "0");
  return { found: w.found, live: w.live === true, remainingBlocks: whole(w.remaining_blocks), remainingTxs: whole(w.remaining_txs), scope };
}

/** One read of everything the dashboard shows. Never throws. */
export async function readVaultSnapshot(config: VaultReadConfig): Promise<VaultSnapshot> {
  try {
    const vault = config.vault;
    const tokens = vaultTokens();
    const head = [
      call(vault, encodeCall("owner()")),
      call(vault, encodeCall("approver()")),
      call(vault, encodeCall("guardian()")),
      call(vault, encodeCall("paused()")),
      call(vault, encodeCall("timelock()")),
      call(vault, encodeCall("nonce()")),
      call(vault, encodeCall("actionCount()")),
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      { method: "eth_getBalance", params: [vault, "latest"] },
      call(vault, encodeCall("dailyCap(address)", ZERO_ADDRESS)),
      call(vault, encodeCall("remainingToday(address)", ZERO_ADDRESS)),
      ...tokens.flatMap((t) => [
        call(vault, encodeCall("dailyCap(address)", t.token)),
        call(vault, encodeCall("remainingToday(address)", t.token)),
      ]),
    ];
    // The vault's own state must be complete; token balances may fail one by one.
    const [r, balances] = await Promise.all([
      rpcBatch(config, head),
      rpcBatchSettled(config, tokens.map((t) => call(t.token, encodeCall("balanceOf(address)", vault)))),
    ]);
    // A vault address without code answers "0x": treat as unavailable, not as zeros.
    const first = hex(r[0]);
    if (first === "0x") return { status: "unavailable" };
    const owner = asAddress(words(first)[0]);
    const approver = asAddress(words(hex(r[1]))[0]);
    const guardianRaw = asAddress(words(hex(r[2]))[0]);
    const paused = asBool(words(hex(r[3]))[0]);
    const timelock = asUint(words(hex(r[4]))[0]);
    const nonce = asUint(words(hex(r[5]))[0]);
    const actionCount = asUint(words(hex(r[6]))[0]);
    const block = r[7] as { number?: unknown; timestamp?: unknown } | null;
    const latest = BigInt(hex(block?.number));
    const chainTime = Number(BigInt(hex(block?.timestamp)));
    const qorBalance = BigInt(hex(r[8]));

    const assets: VaultAsset[] = [
      {
        symbol: "QOR",
        denom: "uqor",
        token: ZERO_ADDRESS,
        balance: displayAmount(qorBalance, EVM_QOR_DECIMALS),
        dailyCap: displayAmount(asUint(words(hex(r[9]))[0]), EVM_QOR_DECIMALS),
        remainingToday: displayAmount(asUint(words(hex(r[10]))[0]), EVM_QOR_DECIMALS),
        remainingTodayRaw: asUint(words(hex(r[10]))[0]).toString(),
      },
    ];
    tokens.forEach((t, i) => {
      const base = 11 + i * 2;
      // A token contract that reverts or does not answer must not hide the rest of the vault.
      const balance = tokenBalance(balances[i]);
      const remaining = asUint(words(hex(r[base + 1]))[0]);
      assets.push({
        symbol: t.symbol,
        denom: t.denom,
        token: t.token,
        balance: balance === null ? "Unavailable" : displayAmount(balance, t.decimals),
        dailyCap: displayAmount(asUint(words(hex(r[base]))[0]), t.decimals),
        remainingToday: displayAmount(remaining, t.decimals),
        remainingTodayRaw: remaining.toString(),
      });
    });

    // Newest actions first, plus their transaction hashes from recent logs.
    const ids: bigint[] = [];
    for (let id = actionCount; id >= BigInt(1) && ids.length < RECENT_ACTIONS; id--) ids.push(id);
    const logRequests: RpcRequest[] = [];
    for (let i = 0; i < LOG_CHUNKS; i++) {
      const to = latest - BigInt(i) * (LOG_CHUNK_BLOCKS + BigInt(1));
      if (to < BigInt(0)) break;
      const from = to > LOG_CHUNK_BLOCKS ? to - LOG_CHUNK_BLOCKS : BigInt(0);
      logRequests.push({
        method: "eth_getLogs",
        params: [{ address: vault, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [Object.values(POND_VAULT_TOPICS)] }],
      });
    }
    const actionReplies = ids.length ? await rpcBatch(config, ids.map((id) => call(vault, encodeCall("getAction(uint256)", id)))) : [];
    const txFor = await readActionTxs(config, logRequests);

    const symbolFor = (token: string) => (token === ZERO_ADDRESS ? "QOR" : tokens.find((t) => t.token.toLowerCase() === token)?.symbol ?? null);
    const decimalsFor = (token: string) => (token === ZERO_ADDRESS ? EVM_QOR_DECIMALS : tokens.find((t) => t.token.toLowerCase() === token)?.decimals ?? null);
    const actions: VaultActionRow[] = ids.map((id, i) => {
      const a = decodeAction(hex(actionReplies[i]));
      const moves = a.action === "Withdraw" || a.action === "SetDailyCap";
      const decimals = moves ? decimalsFor(a.token) : null;
      let amount: string | null = null;
      if (a.action === "SetTimelock") amount = `${a.amount} s`;
      else if (moves && decimals !== null) amount = displayAmount(a.amount, decimals);
      return {
        id: id.toString(),
        action: a.action,
        status: a.status,
        eta: Number(a.eta),
        symbol: moves ? symbolFor(a.token) : null,
        token: moves ? a.token : null,
        to: a.to === ZERO_ADDRESS ? null : a.to,
        amount,
        amountRaw: moves ? a.amount.toString() : null,
        queuedTx: txFor.queued.get(id.toString()) ?? null,
        settledTx: txFor.settled.get(id.toString()) ?? null,
      };
    });

    const ownerWindow = await readWindow(config, owner, vault);
    const keyReply = await rpcBatch(config, [call(vault, encodeCall("keyStatus(address)", approver))]);

    return {
      status: "ok",
      address: vault,
      owner,
      approver,
      guardian: guardianRaw === ZERO_ADDRESS ? null : guardianRaw,
      paused,
      timelockSeconds: Number(timelock),
      nonce: nonce.toString(),
      actionCount: actionCount.toString(),
      approverKeyUsable: asBool(words(hex(keyReply[0]))[0]),
      chainTime,
      assets,
      actions,
      ownerWindow,
    };
  } catch {
    return { status: "unavailable" };
  }
}

/** Transaction hashes per action id. Logs are a nicety: a failed read leaves the links out. */
async function readActionTxs(config: VaultReadConfig, requests: RpcRequest[]) {
  const queued = new Map<string, string>();
  const settled = new Map<string, string>();
  if (!requests.length) return { queued, settled };
  try {
    const replies = await rpcBatch(config, requests);
    for (const reply of replies) {
      if (!Array.isArray(reply)) continue;
      for (const log of reply as { topics?: unknown; transactionHash?: unknown }[]) {
        const topics = Array.isArray(log.topics) ? log.topics : [];
        const hash = typeof log.transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash) ? log.transactionHash : null;
        if (!hash || typeof topics[0] !== "string" || typeof topics[1] !== "string") continue;
        const id = asUint(topics[1].slice(2)).toString();
        if (topics[0].toLowerCase() === POND_VAULT_TOPICS["ActionQueued(uint256,uint8,address,address,uint256,uint64,uint64)"]) queued.set(id, hash);
        else settled.set(id, hash);
      }
    }
  } catch {
    // links are optional
  }
  return { queued, settled };
}

async function readWindow(config: VaultReadConfig, owner: string, vault: string): Promise<VaultWindow | null> {
  try {
    const doFetch = config.fetch ?? fetch;
    const response = await doFetch(`${config.restUrl}/qorechain/pqc/v1/evm_window/${config.toQorAddress(owner)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(config.timeoutMs ?? 6_000),
    });
    if (!response.ok) return null;
    return parseWindow(await response.json(), vault);
  } catch {
    return null;
  }
}

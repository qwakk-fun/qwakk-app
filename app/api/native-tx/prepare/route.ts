import { nativeActionAllowed, nativeActionsEnabled } from "@/lib/features";
import { readAmmParams, readAmmPool, readAmmPoolByDenoms, readBalances, readQuoteExactIn, readQuoteExactOut, type ChainExactOutQuote, type ChainQuote } from "@/lib/qwakk-amm-chain";
import { checkChainId } from "@/lib/qwakk-chain-guard";
import { getServerQwakkFeeConfig, type ServerQwakkFeeConfig } from "@/lib/qwakk-fee-config";
import { alignDepositToPool } from "@/lib/qwakk-liquidity-route";
import { encodedMessagesForAction, exactOutQuoteCheck, interfaceFeeInMessages, parseNativeAction, type NativeAction } from "@/lib/qwakk-native-actions";
import { isBlocked, nativeBlocklist } from "@/lib/qwakk-native-guards";
import { prepareWalletTx, type SimulationFailure } from "@/lib/qwakk-native-tx";
import { getQwakkNetwork, requiresChainQuote } from "@/lib/qwakk-network";
import { createPoolPrecheck } from "@/lib/qwakk-pool-route";
import { buildExactInQuoteRequest } from "@/lib/qwakk-quote";
import { PREPARE_GUARD_COPY, SIMULATION_FAILURE_COPY, networkCopy, type PrepareGuardKey } from "@/lib/qwakk-tx-copy";

type PrecheckFailure = SimulationFailure | Extract<PrepareGuardKey, "blocked" | "quote_unavailable" | "exact_out_unsupported">;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function copy(text: string) {
  return networkCopy(text, getQwakkNetwork());
}

function refused(failure: PrecheckFailure) {
  if (failure === "blocked" || failure === "quote_unavailable") {
    return json({ error: copy(PREPARE_GUARD_COPY[failure]), failure }, failure === "blocked" ? 403 : 503);
  }
  if (failure === "exact_out_unsupported") return json({ error: copy(PREPARE_GUARD_COPY[failure]), failure }, 422);
  return json({ error: copy(SIMULATION_FAILURE_COPY[failure]), failure }, 422);
}

function guard(key: Extract<PrepareGuardKey, "action_disabled" | "wrong_network" | "unreachable">, status: number) {
  return json({ error: copy(PREPARE_GUARD_COPY[key]), failure: key }, status);
}

/**
 * On mainnet a swap is prepared only when QoreChain's own QuoteExactIn (or
 * QuoteExactOut for an exact-out swap) answers for the amount at the AMM; Qwakk's local x*y=k estimate is never
 * enough to sign against there. Chain refusals map to the matching copy.
 */
function chainQuoteFailure(quote: ChainQuote | ChainExactOutQuote): PrecheckFailure | null {
  if (quote.ok) return null;
  switch (quote.failure) {
    case "pool_not_found": return "pool_not_found";
    case "pool_paused": return "pool_paused";
    case "impact_too_high": return "impact_too_high";
    case "insufficient_liquidity": return "insufficient_liquidity";
    case "invalid": return "rejected";
    default: return "quote_unavailable";
  }
}

/**
 * Checks the action against live pool state and AMM params before anything is
 * simulated, so the common reasons are explained precisely. Returns the action
 * to build (deposits put in pool order) or a fixed failure.
 */
async function precheck(action: NativeAction, fee: ServerQwakkFeeConfig): Promise<{ action: NativeAction } | { failure: PrecheckFailure }> {
  const blocklist = nativeBlocklist();
  if (action.kind === "create_pool" && isBlocked(blocklist, { denoms: [action.denomA, action.denomB] })) return { failure: "blocked" };
  if (action.kind !== "create_pool" && isBlocked(blocklist, { poolId: action.poolId, denoms: [] })) return { failure: "blocked" };

  const params = await readAmmParams();
  if (!params.enabled) return { failure: "module_disabled" };
  if (action.kind === "create_pool") {
    if (!/^\d+$/.test(action.amountA) || !/^\d+$/.test(action.amountB)) return { action };
    const reason = createPoolPrecheck(action, params);
    if (reason) return { failure: reason };
    if (action.denomA && action.denomB && action.denomA !== action.denomB && await readAmmPoolByDenoms(action.denomA, action.denomB)) return { failure: "pool_exists" };
    return { action };
  }
  const pool = await readAmmPool(action.poolId);
  if (!pool) return { failure: "pool_not_found" };
  if (isBlocked(blocklist, { denoms: [pool.tokenA, pool.tokenB] })) return { failure: "blocked" };
  if (pool.status !== "active") return { failure: "pool_paused" };
  if (action.kind === "swap") {
    const pair = (action.denomIn === pool.tokenA && action.denomOut === pool.tokenB) || (action.denomIn === pool.tokenB && action.denomOut === pool.tokenA);
    if (!pair) return { failure: "pool_not_found" };
    if (action.mode === "exact_out") {
      // QoreChain quotes exact out only on constant-product pools.
      if (pool.poolType !== "constant_product") return { failure: "exact_out_unsupported" };
      // Input the builder rejects is rejected again, with a 400, below.
      if (!/^\d+$/.test(action.amountOut) || BigInt(action.amountOut) <= BigInt(0)) return { action };
      // On every network: the interface fee is set from the client's quoted
      // total, so the chain's own QuoteExactOut must back that total. Without
      // it the fee basis cannot be checked, so the swap waits.
      const chainQuote = await readQuoteExactOut(action.poolId, action.denomOut, action.amountOut);
      if (!chainQuote.ok) return { failure: chainQuoteFailure(chainQuote) ?? "quote_unavailable" };
      const checked = exactOutQuoteCheck(action, fee, chainQuote.amountIn);
      if (checked !== "ok") return { failure: checked };
    } else if (requiresChainQuote(getQwakkNetwork())) {
      // The same split the quote route and the swap builder use. Input the split
      // rejects is rejected again, with a 400, by the swap builder below.
      let request;
      try {
        request = buildExactInQuoteRequest({ poolId: action.poolId, denomIn: action.denomIn, amountIn: action.amountIn, fee });
      } catch {
        return { action };
      }
      const failure = chainQuoteFailure(await readQuoteExactIn(request.poolId, request.denomIn, request.swapAmountIn));
      if (failure) return { failure };
    }
  }
  if (action.kind === "add_liquidity") {
    const aligned = alignDepositToPool(action, pool);
    if (!aligned) return { failure: "pool_not_found" };
    return { action: aligned };
  }
  return { action };
}

/**
 * Prepares one native action for QoreX `signAndBroadcast`.
 *
 * Request: `{ address: "qor1…", action: NativeAction }`.
 * Response: `{ chainId, messages: [{ typeUrl, value: base64 }], memo, gasLimit,
 * fee: { amount, denom: "uqor" }, interfaceFee: { denom, amount } | null,
 * pqcKeyRegistered, simulated }`. `interfaceFee` is read back from the encoded
 * fee transfer, because QoreX lists only message types when a transaction has
 * several. `simulated` carries what QoreChain's keeper reported in simulation,
 * such as the exact swap output.
 *
 * The messages are built here from the action, with the connected address as
 * sender and the interface fee taken from server configuration (capped at
 * 30 bps). Before that the route checks the action's own switch, the live
 * chain id of the configured endpoints and the operator blocklist; on mainnet
 * a swap also needs QoreChain's own quote, and an exact-out swap needs it on
 * every network, so its fee basis matches the chain. They are checked against the live
 * pool and AMM params, simulated against the configured network (QoreChain
 * Diana by default) so a failing action is explained before the wallet
 * opens, and checked against the wallet's balance including the network fee
 * and, for a new pool, the pool creation fee. QoreX builds, signs and
 * broadcasts the transaction itself. Nothing is signed or broadcast here.
 */
export async function POST(request: Request) {
  if (!nativeActionsEnabled()) return json({ error: "Not found" }, 404);
  const network = getQwakkNetwork();

  const input = await request.json().catch(() => null) as { address?: unknown; action?: unknown } | null;
  const address = typeof input?.address === "string" ? input.address.trim() : "";
  if (!/^qor1[0-9a-z]{20,}$/i.test(address)) return json({ error: "Connect a QoreChain wallet first" }, 400);

  let action: NativeAction;
  try {
    action = parseNativeAction(input?.action);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Check the transaction details" }, 400);
  }
  // Per-action switch: QWAKK_NATIVE_ACTIONS can allow only some actions.
  if (!nativeActionAllowed(action.kind)) return guard("action_disabled", 403);

  // The configured endpoints must serve the configured chain before anything
  // is prepared for QoreX to sign (cached, see lib/qwakk-chain-guard.ts).
  const chain = await checkChainId();
  if (chain.state === "mismatch") return guard("wrong_network", 503);
  if (chain.state === "unreachable") return guard("unreachable", 502);

  const fee = getServerQwakkFeeConfig();
  try {
    const checked = await precheck(action, fee);
    if ("failure" in checked) return refused(checked.failure);
    action = checked.action;
  } catch {
    return guard("unreachable", 502);
  }

  let encoded;
  try {
    encoded = encodedMessagesForAction(address, action, fee);
  } catch (error) {
    // Builder errors are fixed strings written in this codebase, never chain text.
    return json({ error: error instanceof Error ? error.message : "Check the transaction details" }, 400);
  }

  try {
    const params = await readAmmParams();
    const outcome = await prepareWalletTx({
      address,
      chainId: network.chainId,
      encoded,
      balanceCheck: {
        poolCreationFee: action.kind === "create_pool" ? BigInt(params.poolCreationFee) : undefined,
        readBalances,
      },
    });
    if (!outcome.ok && outcome.reason === "unfunded") return json({ error: network.id === "mainnet" ? "Fund this wallet with QOR first" : "Fund this wallet with test QOR first" }, 400);
    if (!outcome.ok) return refused(outcome.failure);
    return json({ ...outcome.prepared, interfaceFee: interfaceFeeInMessages(encoded) });
  } catch {
    return guard("unreachable", 502);
  }
}

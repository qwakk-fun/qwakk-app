import { QORECHAIN_CHAIN_ID } from "@/lib/qorechain-endpoints";
import { nativeActionsEnabled } from "@/lib/features";
import { readAmmParams, readAmmPool, readAmmPoolByDenoms, readBalances } from "@/lib/qwakk-amm-chain";
import { getServerQwakkFeeConfig } from "@/lib/qwakk-fee-config";
import { alignDepositToPool } from "@/lib/qwakk-liquidity-route";
import { encodedMessagesForAction, interfaceFeeInMessages, parseNativeAction, type NativeAction } from "@/lib/qwakk-native-actions";
import { prepareWalletTx, type SimulationFailure } from "@/lib/qwakk-native-tx";
import { createPoolPrecheck } from "@/lib/qwakk-pool-route";
import { SIMULATION_FAILURE_COPY } from "@/lib/qwakk-tx-copy";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function refused(failure: SimulationFailure) {
  return json({ error: SIMULATION_FAILURE_COPY[failure], failure }, 422);
}

/**
 * Checks the action against live pool state and AMM params before anything is
 * simulated, so the common reasons are explained precisely. Returns the action
 * to build (deposits put in pool order) or a fixed failure.
 */
async function precheck(action: NativeAction): Promise<{ action: NativeAction } | { failure: SimulationFailure }> {
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
  if (pool.status !== "active") return { failure: "pool_paused" };
  if (action.kind === "swap") {
    const pair = (action.denomIn === pool.tokenA && action.denomOut === pool.tokenB) || (action.denomIn === pool.tokenB && action.denomOut === pool.tokenA);
    if (!pair) return { failure: "pool_not_found" };
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
 * 30 bps). They are checked against the live pool and AMM params, simulated
 * against QoreChain Diana so a failing action is explained before the wallet
 * opens, and checked against the wallet's balance including the network fee
 * and, for a new pool, the pool creation fee. QoreX builds, signs and
 * broadcasts the transaction itself. Nothing is signed or broadcast here.
 */
export async function POST(request: Request) {
  if (!nativeActionsEnabled()) return json({ error: "Not found" }, 404);

  const input = await request.json().catch(() => null) as { address?: unknown; action?: unknown } | null;
  const address = typeof input?.address === "string" ? input.address.trim() : "";
  if (!/^qor1[0-9a-z]{20,}$/i.test(address)) return json({ error: "Connect a QoreChain wallet first" }, 400);

  let action: NativeAction;
  try {
    action = parseNativeAction(input?.action);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Check the transaction details" }, 400);
  }

  try {
    const checked = await precheck(action);
    if ("failure" in checked) return refused(checked.failure);
    action = checked.action;
  } catch {
    return json({ error: "QoreChain Diana could not be reached. Try again shortly." }, 502);
  }

  let encoded;
  try {
    encoded = encodedMessagesForAction(address, action, getServerQwakkFeeConfig());
  } catch (error) {
    // Builder errors are fixed strings written in this codebase, never chain text.
    return json({ error: error instanceof Error ? error.message : "Check the transaction details" }, 400);
  }

  try {
    const params = await readAmmParams();
    const outcome = await prepareWalletTx({
      address,
      chainId: QORECHAIN_CHAIN_ID,
      encoded,
      balanceCheck: {
        poolCreationFee: action.kind === "create_pool" ? BigInt(params.poolCreationFee) : undefined,
        readBalances,
      },
    });
    if (!outcome.ok && outcome.reason === "unfunded") return json({ error: "Fund this wallet with test QOR first" }, 400);
    if (!outcome.ok) return refused(outcome.failure);
    return json({ ...outcome.prepared, interfaceFee: interfaceFeeInMessages(encoded) });
  } catch {
    return json({ error: "QoreChain Diana could not be reached. Try again shortly." }, 502);
  }
}

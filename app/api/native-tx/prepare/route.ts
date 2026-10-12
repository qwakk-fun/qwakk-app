import { QORECHAIN_CHAIN_ID } from "@/lib/qorechain-endpoints";
import { nativeActionsEnabled } from "@/lib/features";
import { getServerQwakkFeeConfig } from "@/lib/qwakk-fee-config";
import { encodedMessagesForAction, interfaceFeeInMessages, parseNativeAction } from "@/lib/qwakk-native-actions";
import { prepareWalletTx } from "@/lib/qwakk-native-tx";
import { SIMULATION_FAILURE_COPY } from "@/lib/qwakk-tx-copy";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Prepares one native action for QoreX `signAndBroadcast`.
 *
 * Request: `{ address: "qor1…", action: NativeAction }`.
 * Response: `{ chainId, messages: [{ typeUrl, value: base64 }], memo, gasLimit,
 * fee: { amount, denom: "uqor" }, interfaceFee: { denom, amount } | null,
 * pqcKeyRegistered }`. `interfaceFee` is read back from the encoded fee transfer,
 * because QoreX lists only message types when a transaction has several.
 *
 * The messages are built here from the action, with the connected address as
 * sender and the interface fee taken from server configuration (capped at
 * 30 bps), then simulated against QoreChain Diana so a failing action is
 * explained before the wallet opens and the gas limit comes from simulated gas.
 * QoreX builds, signs and broadcasts the transaction itself. Nothing is signed
 * or broadcast here.
 */
export async function POST(request: Request) {
  if (!nativeActionsEnabled()) return json({ error: "Not found" }, 404);

  const input = await request.json().catch(() => null) as { address?: unknown; action?: unknown } | null;
  const address = typeof input?.address === "string" ? input.address.trim() : "";
  if (!/^qor1[0-9a-z]{20,}$/i.test(address)) return json({ error: "Connect a QoreChain wallet first" }, 400);

  let encoded;
  try {
    encoded = encodedMessagesForAction(address, parseNativeAction(input?.action), getServerQwakkFeeConfig());
  } catch (error) {
    // Builder errors are fixed strings written in this codebase, never chain text.
    return json({ error: error instanceof Error ? error.message : "Check the transaction details" }, 400);
  }

  try {
    const outcome = await prepareWalletTx({ address, chainId: QORECHAIN_CHAIN_ID, encoded });
    if (!outcome.ok && outcome.reason === "unfunded") return json({ error: "Fund this wallet with test QOR first" }, 400);
    if (!outcome.ok) return json({ error: SIMULATION_FAILURE_COPY[outcome.failure], failure: outcome.failure }, 422);
    return json({ ...outcome.prepared, interfaceFee: interfaceFeeInMessages(encoded) });
  } catch {
    return json({ error: "QoreChain Diana could not be reached. Try again shortly." }, 502);
  }
}

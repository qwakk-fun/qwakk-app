import { QORECHAIN_CHAIN_ID } from "@/lib/qorechain-endpoints";
import { nativeActionsEnabled } from "@/lib/features";
import { getServerQoraFeeConfig } from "@/lib/qora-fee-config";
import { messagesForAction, parseNativeAction } from "@/lib/qora-native-actions";
import {
  buildUnsignedNativeTx,
  bytesToBase64,
  classicalAddressFromPublicKey,
  feeForSimulatedGas,
  parseCompressedPublicKey,
  readAccountAuth,
  simulateTx,
} from "@/lib/qora-native-tx";
import { SIMULATION_FAILURE_COPY } from "@/lib/qora-tx-copy";

/** Used only for the first simulation. Kept small so a low balance is not refused for a fee it would never pay. */
const DRAFT_FEE = { amount: [{ denom: "uqor", amount: "30000" }], gas: "1000000" };

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Builds an unsigned native transaction for the connected wallet. It is first
 * simulated against QoreChain Diana, so a transaction that would fail is
 * explained before the wallet is asked to sign, and the fee comes from the
 * simulated gas. Nothing is signed or broadcast here.
 */
export async function POST(request: Request) {
  if (!nativeActionsEnabled()) return json({ error: "Not found" }, 404);

  const input = await request.json().catch(() => null) as { address?: unknown; publicKey?: unknown; action?: unknown } | null;
  const address = typeof input?.address === "string" ? input.address.trim() : "";
  if (!/^qor1[0-9a-z]{20,}$/i.test(address)) return json({ error: "Connect a QoreChain wallet first" }, 400);

  let publicKey: Uint8Array;
  try {
    publicKey = parseCompressedPublicKey(typeof input?.publicKey === "string" ? input.publicKey : "");
  } catch {
    return json({ error: "The wallet did not share a usable public key" }, 400);
  }
  // QoreX signs with its classical signer only; see lib/qorex-native.ts.
  if (classicalAddressFromPublicKey(publicKey) !== address) {
    return json({ error: "This QoreX account type cannot sign app transactions yet. Use a standard QoreX account." }, 400);
  }

  let messages;
  try {
    messages = messagesForAction(address, parseNativeAction(input?.action), getServerQoraFeeConfig());
  } catch (error) {
    // Builder errors are fixed strings written in this codebase, never chain text.
    return json({ error: error instanceof Error ? error.message : "Check the transaction details" }, 400);
  }

  try {
    const account = await readAccountAuth(address);
    if (!account) return json({ error: "Fund this wallet with test QOR first" }, 400);

    const simulation = await simulateTx(buildUnsignedNativeTx({ messages, publicKey, keyType: "secp256k1", account, fee: DRAFT_FEE }));
    if (!simulation.ok) return json({ error: SIMULATION_FAILURE_COPY[simulation.failure], failure: simulation.failure }, 422);

    const fee = feeForSimulatedGas(simulation.gasUsed);
    const unsigned = buildUnsignedNativeTx({ messages, publicKey, keyType: "secp256k1", account, fee });
    return json({
      chainId: QORECHAIN_CHAIN_ID,
      accountNumber: unsigned.accountNumber.toString(),
      bodyBytes: bytesToBase64(unsigned.bodyBytes),
      authInfoBytes: bytesToBase64(unsigned.authInfoBytes),
      fee: { amount: fee.amount[0].amount, denom: "uqor", gas: fee.gas },
      messageCount: messages.length,
    });
  } catch {
    return json({ error: "QoreChain Diana could not be reached. Try again shortly." }, 502);
  }
}

import { amm } from "@qorechain/sdk";

import { QORECHAIN_CHAIN_ID } from "@/lib/qorechain-endpoints";
import {
  buildUnsignedNativeTx,
  bytesToBase64,
  classicalAddressFromPublicKey,
  parseCompressedPublicKey,
  readAccountAuth,
} from "@/lib/qora-native-tx";

/** A pool ID far beyond anything Diana has created, so the swap cannot execute. */
const PROBE_POOL_ID = "999999999";
const PROBE_FEE = { amount: [{ denom: "uqor", amount: "60000" }], gas: "300000" };

type ProbeRequest = { address?: string; publicKey?: string };

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Development-only signing probe. It builds a classical-only native AMM swap
 * against a pool that does not exist. CheckTx then shows whether Diana accepts
 * a QoreX signature without the post-quantum layer, while the swap itself
 * always fails in the block. The only cost is the network fee.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return json({ error: "Not found" }, 404);

  const input = await request.json().catch(() => null) as ProbeRequest | null;
  const address = input?.address?.trim() ?? "";
  if (!/^qor1[0-9a-z]{20,}$/i.test(address)) return json({ error: "A valid QoreChain address is required" }, 400);

  let publicKey: Uint8Array;
  try {
    publicKey = parseCompressedPublicKey(input?.publicKey ?? "");
  } catch {
    return json({ error: "The wallet did not share a usable public key" }, 400);
  }

  // QoreX 0.3.4 signs only with its classical signer. A unified eth account's
  // address does not match that signer, so QoreX fails even after approval.
  if (classicalAddressFromPublicKey(publicKey) !== address) {
    return json({ error: "This QoreX account uses the unified key type, which QoreX cannot yet sign app transactions with. Try a standard QoreX account." }, 400);
  }

  try {
    const account = await readAccountAuth(address);
    if (!account) return json({ error: "Fund this wallet with test QOR before running the probe" }, 400);

    const unsigned = buildUnsignedNativeTx({
      messages: [amm.swapExactIn({
        sender: address,
        poolId: PROBE_POOL_ID,
        tokenIn: { denom: "uqor", amount: "1" },
        denomOut: "uprobe",
        minOut: "1",
      })],
      publicKey,
      keyType: "secp256k1",
      account,
      fee: PROBE_FEE,
      memo: "Qora signing probe",
    });

    return json({
      chainId: QORECHAIN_CHAIN_ID,
      accountNumber: unsigned.accountNumber.toString(),
      sequence: account.sequence.toString(),
      bodyBytes: bytesToBase64(unsigned.bodyBytes),
      authInfoBytes: bytesToBase64(unsigned.authInfoBytes),
      fee: PROBE_FEE,
    });
  } catch {
    return json({ error: "QoreChain Diana could not be reached. Try again shortly." }, 502);
  }
}

import {
  RELAYABLE_MESSAGE_TYPES,
  assembleSignedTx,
  base64ToBytes,
  broadcastTxSync,
  messageTypesInBody,
} from "@/lib/qora-native-tx";

type BroadcastRequest = { bodyBytes?: string; authInfoBytes?: string; signature?: string };

const MAX_PART_BYTES = 64 * 1024;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Relays a transaction the user already signed in their own wallet. Qora never
 * signs here: it only checks that the body holds native AMM messages, joins the
 * signed parts and submits them to QoreChain server-side to avoid browser CORS.
 */
export async function POST(request: Request) {
  const input = await request.json().catch(() => null) as BroadcastRequest | null;

  let bodyBytes: Uint8Array;
  let authInfoBytes: Uint8Array;
  let signature: Uint8Array;
  try {
    bodyBytes = base64ToBytes(input?.bodyBytes ?? "");
    authInfoBytes = base64ToBytes(input?.authInfoBytes ?? "");
    signature = base64ToBytes(input?.signature ?? "");
    if (!bodyBytes.length || !authInfoBytes.length || bodyBytes.length > MAX_PART_BYTES || authInfoBytes.length > MAX_PART_BYTES) {
      throw new Error("Invalid transaction size");
    }
    const types = messageTypesInBody(bodyBytes);
    if (!types.length || types.some((type) => !RELAYABLE_MESSAGE_TYPES.has(type))) {
      return json({ error: "Qora only submits native AMM transactions" }, 400);
    }
  } catch {
    return json({ error: "The signed transaction could not be read" }, 400);
  }

  let txBytes: Uint8Array;
  try {
    txBytes = assembleSignedTx(bodyBytes, authInfoBytes, signature);
  } catch {
    return json({ error: "The wallet signature could not be used" }, 400);
  }

  try {
    const result = await broadcastTxSync(txBytes);
    // Chain logs stay in the server console. The browser only gets codes.
    if (result.code !== 0) console.warn("QoreChain CheckTx refused a transaction", result);
    return json({ txhash: result.txhash, accepted: result.code === 0, code: result.code, codespace: result.codespace });
  } catch {
    return json({ error: "QoreChain Diana could not accept the transaction right now" }, 502);
  }
}

import { bank } from "@qorechain/sdk";

import { BRAND } from "@/lib/brand";
import { QORECHAIN_CHAIN_ID } from "@/lib/qorechain-endpoints";
import { encodeAsAny, prepareWalletTx } from "@/lib/qwakk-native-tx";
import { SIMULATION_FAILURE_COPY } from "@/lib/qwakk-tx-copy";

const PROBE_MEMO = `${BRAND.name} signing probe`;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Development-only signing probe. It prepares a 1 uqor transfer from the
 * connected address to itself, in the same `signAndBroadcast` shape as a real
 * action. It needs no pool, and it proves both the wallet-built post-quantum
 * transaction and the bank transfer Qwakk uses for its interface fee. The only
 * cost is the network fee.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return json({ error: "Not found" }, 404);

  const input = await request.json().catch(() => null) as { address?: unknown } | null;
  const address = typeof input?.address === "string" ? input.address.trim() : "";
  if (!/^qor1[0-9a-z]{20,}$/i.test(address)) return json({ error: "A valid QoreChain address is required" }, 400);

  const encoded = encodeAsAny([bank.send({ fromAddress: address, toAddress: address, amount: [{ denom: "uqor", amount: "1" }] })]);
  try {
    const outcome = await prepareWalletTx({ address, chainId: QORECHAIN_CHAIN_ID, encoded, memo: PROBE_MEMO });
    if (!outcome.ok && outcome.reason === "unfunded") return json({ error: "Fund this wallet with test QOR before running the probe" }, 400);
    if (!outcome.ok) return json({ error: SIMULATION_FAILURE_COPY[outcome.failure], failure: outcome.failure }, 422);
    return json(outcome.prepared);
  } catch {
    return json({ error: "QoreChain Diana could not be reached. Try again shortly." }, 502);
  }
}

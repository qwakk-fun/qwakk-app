import { hexToBech32 } from "@qorechain/sdk";
import { QORECHAIN_EVM_RPC_URL, QORECHAIN_NETWORK, QORECHAIN_REST_URL } from "@/lib/qorechain-endpoints";
import { cachedJsonResponse, createServerCache, type CachedJson } from "@/lib/qwakk-server-cache";
import { readVaultSnapshot, vaultAddressFromEnv } from "@/lib/qwakk-vault";

/**
 * Read-only Pond Vault state for /vault. The browser cannot call the QoreChain
 * EVM RPC or REST directly (no CORS headers on REST), so the server reads and
 * relays. Every open page polls, so one read is shared for a few seconds.
 */
const vaultCache = createServerCache<CachedJson>({
  maxEntries: 1,
  ttlMs: (result) => (result.status === 200 ? 8_000 : 3_000),
});

async function load(): Promise<CachedJson> {
  const vault = vaultAddressFromEnv(process.env, QORECHAIN_NETWORK.id);
  if (!vault) return { status: 200, body: { status: "unconfigured" } };
  const snapshot = await readVaultSnapshot({
    vault,
    evmRpcUrl: QORECHAIN_EVM_RPC_URL,
    restUrl: QORECHAIN_REST_URL,
    toQorAddress: (evm) => hexToBech32(evm, "qor"),
  });
  return { status: snapshot.status === "unavailable" ? 502 : 200, body: snapshot };
}

export async function GET() {
  return cachedJsonResponse(await vaultCache("vault", load));
}

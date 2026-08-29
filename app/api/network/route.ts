const TESTNET_API = "https://api-testnet.qore.host";
const TESTNET_RPC = "https://rpc-testnet.qore.host";

export async function GET() {
  try {
    const [statusResponse, poolsResponse] = await Promise.all([
      fetch(`${TESTNET_RPC}/status`, { cache: "no-store" }),
      fetch(`${TESTNET_API}/qorechain/amm/v1/pools`, { cache: "no-store" }),
    ]);

    if (!statusResponse.ok || !poolsResponse.ok) {
      return Response.json({ error: "QoreChain Diana testnet is unavailable" }, { status: 502 });
    }

    const [status, poolData] = await Promise.all([statusResponse.json(), poolsResponse.json()]);
    return Response.json(
      {
        height: status?.result?.sync_info?.latest_block_height ?? null,
        pools: Array.isArray(poolData?.pools) ? poolData.pools : [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Unable to reach QoreChain Diana testnet" }, { status: 502 });
  }
}

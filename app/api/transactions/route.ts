const TESTNET_API = "https://api-testnet.qore.host";
const PAGE_SIZE = 8;

type ChainMessage = { "@type"?: string; from_address?: string; to_address?: string; amount?: Array<{ denom?: string; amount?: string }> };
type ChainTx = { txhash?: string; timestamp?: string; code?: number; tx?: { body?: { messages?: ChainMessage[] } } };

function isQoreAddress(value: string) {
  return /^qor1[0-9a-z]{20,}$/i.test(value);
}

function summarizeMessage(message: ChainMessage, address: string) {
  const type = message["@type"] ?? "";
  if (type === "/cosmos.bank.v1beta1.MsgSend") {
    const amount = message.amount?.[0];
    return {
      label: message.from_address === address ? "Sent" : "Received",
      direction: message.from_address === address ? "out" : "in",
      amount: amount?.amount ?? "",
      denom: amount?.denom ?? "",
    };
  }
  if (type === "/qorechain.amm.v1.MsgCreatePool") return { label: "Created a pool", direction: "action", amount: "", denom: "" };
  if (type === "/qorechain.amm.v1.MsgAddLiquidity") return { label: "Added liquidity", direction: "action", amount: "", denom: "" };
  if (type === "/qorechain.amm.v1.MsgRemoveLiquidity") return { label: "Removed liquidity", direction: "action", amount: "", denom: "" };
  if (type === "/qorechain.amm.v1.MsgSwapExactIn" || type === "/qorechain.amm.v1.MsgSwapExactOut") return { label: "Swapped assets", direction: "action", amount: "", denom: "" };
  return { label: "On-chain activity", direction: "action", amount: "", denom: "" };
}

/** Reads public transaction history only; no wallet permission or private data is used. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address")?.trim() ?? "";
  if (!isQoreAddress(address)) return Response.json({ error: "A valid QoreChain address is required" }, { status: 400 });

  try {
    const readQuery = async (query: string) => {
      const response = await fetch(
        `${TESTNET_API}/cosmos/tx/v1beta1/txs?${new URLSearchParams({ query, "pagination.limit": String(PAGE_SIZE), order_by: "ORDER_BY_DESC" })}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("Transaction query failed");
      const data = await response.json();
      return Array.isArray(data?.tx_responses) ? data.tx_responses as ChainTx[] : [];
    };

    const result = await Promise.allSettled([
      readQuery(`message.sender='${address}'`),
      readQuery(`transfer.recipient='${address}'`),
    ]);
    const responses = [...new Map(
      result.flatMap((entry) => entry.status === "fulfilled" ? entry.value : [])
        .map((tx) => [tx.txhash, tx]),
    ).values()]
      .sort((a, b) => Date.parse(b.timestamp ?? "") - Date.parse(a.timestamp ?? ""))
      .slice(0, PAGE_SIZE);
    if (!result.some((entry) => entry.status === "fulfilled")) throw new Error("Transaction query failed");
    const transactions = responses.map((tx) => {
      const firstMessage = tx.tx?.body?.messages?.[0] ?? {};
      return {
        hash: tx.txhash ?? "",
        timestamp: tx.timestamp ?? "",
        status: tx.code === 0 ? "success" : "failed",
        ...summarizeMessage(firstMessage, address),
      };
    }).filter((tx) => tx.hash);
    return Response.json({ transactions }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Unable to read recent activity" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

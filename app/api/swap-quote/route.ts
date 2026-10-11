import { QORECHAIN_REST_URL } from "@/lib/qorechain-endpoints";
import { getServerQwakkFeeConfig } from "@/lib/qwakk-fee-config";
import { buildExactInQuoteRequest, calculateMinimumOut } from "@/lib/qwakk-quote";

type ChainQuote = {
  amount_out?: string;
  fee?: string;
};

function parseSlippage(value: string | null) {
  if (value === null || value === "") return undefined;
  if (!/^\d+$/.test(value)) return Number.NaN;
  return Number(value);
}

/** Returns a read-only Diana AMM quote. It never signs or broadcasts a transaction. */
export async function GET(request: Request) {
  const url = new URL(request.url);

  try {
    const quoteRequest = buildExactInQuoteRequest({
      poolId: url.searchParams.get("poolId") ?? "",
      denomIn: url.searchParams.get("denomIn") ?? "",
      amountIn: url.searchParams.get("amountIn") ?? "",
      slippageBps: parseSlippage(url.searchParams.get("slippageBps")),
      fee: getServerQwakkFeeConfig(),
    });

    const query = new URLSearchParams({
      pool_id: quoteRequest.poolId,
      denom_in: quoteRequest.denomIn,
      amount_in: quoteRequest.swapAmountIn,
    });
    const response = await fetch(`${QORECHAIN_REST_URL}/qorechain/amm/v1/quote/exact_in?${query}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      const status = response.status === 404 ? 404 : 502;
      return Response.json(
        { error: status === 404 ? "Quote is not available for this pool" : "The QoreChain Diana quote service is temporarily unavailable" },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }

    const quote = (await response.json()) as ChainQuote;
    if (!quote.amount_out || !/^\d+$/.test(quote.amount_out) || BigInt(quote.amount_out) <= BigInt(0)) {
      return Response.json(
        { error: "QoreChain Diana did not return a usable quote" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(
      {
        network: "qorechain-diana",
        poolId: quoteRequest.poolId,
        denomIn: quoteRequest.denomIn,
        totalAmountIn: quoteRequest.totalAmountIn,
        swapAmountIn: quoteRequest.swapAmountIn,
        amountOut: quote.amount_out,
        minOut: calculateMinimumOut(quote.amount_out, quoteRequest.slippageBps),
        nativeAmmFee: quote.fee ?? "0",
        slippageBps: quoteRequest.slippageBps,
        interfaceFee: {
          enabled: quoteRequest.interfaceFeeEnabled,
          amount: quoteRequest.interfaceFee,
          denom: quoteRequest.denomIn,
          feeBps: quoteRequest.interfaceFeeBps,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to prepare quote";
    const safeMessages = new Set([
      "A valid pool ID is required",
      "A valid input denom is required",
      "Swap amount must be a positive integer",
      "Swap amount is too small after the interface fee",
      "Slippage must be between 1 and 500 bps",
    ]);

    return Response.json(
      { error: safeMessages.has(message) ? message : "Unable to reach the QoreChain Diana quote service" },
      { status: safeMessages.has(message) ? 400 : 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

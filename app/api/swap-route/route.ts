import { getServerQoraFeeConfig } from "@/lib/qora-fee-config";
import { buildQoraSwapRoute } from "@/lib/qora-swap-route";

type SwapRouteRequest = {
  sender?: string;
  poolId?: string;
  denomIn?: string;
  amountIn?: string;
  denomOut?: string;
  minOut?: string;
};

/**
 * Builds an unsigned transaction plan using the deployment-owned treasury.
 * It never accepts a private key, signs, broadcasts, or holds user assets.
 */
export async function POST(request: Request) {
  const fee = getServerQoraFeeConfig();
  if (!fee.enabled) {
    return Response.json(
      { error: "Qora fee is not configured yet" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const input = (await request.json()) as SwapRouteRequest;
    const route = buildQoraSwapRoute({
      sender: input.sender ?? "",
      poolId: input.poolId ?? "",
      denomIn: input.denomIn ?? "",
      amountIn: input.amountIn ?? "",
      denomOut: input.denomOut ?? "",
      minOut: input.minOut ?? "",
      fee,
    });

    return Response.json(
      {
        feeBps: fee.feeBps,
        recipient: fee.recipient,
        swapAmount: route.swapAmount,
        interfaceFee: route.interfaceFee,
        messageTypes: route.messages.map((message) => message.typeUrl),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to build swap route";
    return Response.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}

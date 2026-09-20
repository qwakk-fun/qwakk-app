import { buildLiquidityRoute, type LiquidityRouteInput } from "@/lib/qora-liquidity-route";

/** Builds an unsigned liquidity plan. It never signs, broadcasts, or holds assets. */
export async function POST(request: Request) {
  try {
    const input = await request.json() as Partial<LiquidityRouteInput>;
    const plan = input.action === "remove"
      ? buildLiquidityRoute({
        action: "remove",
        sender: input.sender ?? "",
        poolId: input.poolId ?? "",
        lpAmount: input.lpAmount ?? "",
        minAmountA: input.minAmountA ?? "",
        minAmountB: input.minAmountB ?? "",
      })
      : buildLiquidityRoute({
        action: "add",
        sender: input.sender ?? "",
        poolId: input.poolId ?? "",
        denomA: input.denomA ?? "",
        amountA: input.amountA ?? "",
        denomB: input.denomB ?? "",
        amountB: input.amountB ?? "",
        minLpOut: input.minLpOut ?? "",
      });

    return Response.json(
      { action: plan.action, messageType: plan.message.typeUrl, readyForSignature: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to prepare liquidity action";
    return Response.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}

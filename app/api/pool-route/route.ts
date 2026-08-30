import { buildCreatePoolPlan } from "@/lib/qora-pool-route";

type CreatePoolRequest = {
  creator?: string;
  poolType?: "constant_product" | "stable_swap";
  denomA?: string;
  amountA?: string;
  denomB?: string;
  amountB?: string;
  amplificationCoefficient?: number;
};

/** Creates an unsigned native pool-creation plan for wallet confirmation. */
export async function POST(request: Request) {
  try {
    const input = (await request.json()) as CreatePoolRequest;
    const plan = buildCreatePoolPlan({
      creator: input.creator ?? "",
      poolType: input.poolType ?? "constant_product",
      denomA: input.denomA?.trim() ?? "",
      amountA: input.amountA?.trim() ?? "",
      denomB: input.denomB?.trim() ?? "",
      amountB: input.amountB?.trim() ?? "",
      amplificationCoefficient: input.amplificationCoefficient,
    });
    return Response.json(
      {
        poolType: plan.poolType,
        messageType: plan.message.typeUrl,
        readyForSignature: true,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to prepare pool creation";
    return Response.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}

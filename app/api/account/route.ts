import { QORECHAIN_REST_URL } from "@/lib/qorechain-endpoints";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address")?.trim() ?? "";

  if (!/^qor1[0-9a-z]{20,}$/i.test(address)) {
    return Response.json({ error: "A valid QoreChain address is required" }, { status: 400 });
  }

  try {
    const response = await fetch(`${QORECHAIN_REST_URL}/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error("Balance query failed");
    const data = await response.json();
    return Response.json(
      { balances: Array.isArray(data?.balances) ? data.balances : [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Unable to read wallet balances" }, { status: 502 });
  }
}

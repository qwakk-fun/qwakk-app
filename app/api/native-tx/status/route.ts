import { readTxResult } from "@/lib/qwakk-native-tx";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Reports whether a broadcast transaction is in a block and how it ended. */
export async function GET(request: Request) {
  const hash = new URL(request.url).searchParams.get("hash")?.trim() ?? "";
  if (!/^[0-9A-F]{64}$/i.test(hash)) return json({ error: "A valid transaction hash is required" }, 400);

  try {
    const result = await readTxResult(hash);
    if (!result) return json({ state: "pending" });
    if (result.code !== 0) console.warn("QoreChain transaction failed in block", result);
    return json({ state: "included", success: result.code === 0, code: result.code, codespace: result.codespace });
  } catch {
    return json({ error: "Transaction status is temporarily unavailable" }, 502);
  }
}

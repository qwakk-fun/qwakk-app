import { QORECHAIN_REST_URL } from "@/lib/qorechain-endpoints";
import { isQoreAddress, rewardsClaimContract } from "@/lib/qwakk-native-rewards";
import { getQwakkNetwork } from "@/lib/qwakk-network";
import { rewardsEnabled } from "@/lib/qwakk-rewards";
import { isClaimedQueryPath, parseIsClaimed, parseStageList } from "@/lib/qwakk-rewards-view";
import { createServerCache } from "@/lib/qwakk-server-cache";

const READ_TIMEOUT_MS = 8_000;

/**
 * One `is_claimed` answer per contract, stage and address. A claim is final,
 * so "claimed" is kept for a while; "not claimed" only merges bursts, so the
 * reload after a confirmed claim sees it. A failed read is not kept.
 */
const claimedCache = createServerCache<boolean | null>({
  maxEntries: 5_000,
  ttlMs: (claimed) => (claimed === true ? 300_000 : claimed === false ? 4_000 : 0),
});

async function readClaimed(contract: string, stageId: number, address: string): Promise<boolean | null> {
  try {
    const response = await fetch(`${QORECHAIN_REST_URL}${isClaimedQueryPath(contract, stageId, address)}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseIsClaimed(await response.json());
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Whether an address already claimed the given stages, read from the rewards
 * contract (`?stages=1,2`). Answers `{ claimed: { "1": true } }`; a stage that
 * could not be read is left out, so the page treats it as unknown.
 */
export async function GET(request: Request, context: { params: Promise<{ address: string }> }) {
  if (!rewardsEnabled()) return json({ error: "Not found" }, 404);
  const contract = rewardsClaimContract(process.env, getQwakkNetwork().id);
  if (!contract) return json({ error: "Not found" }, 404);

  const address = (await context.params).address.trim().toLowerCase();
  if (!isQoreAddress(address)) return json({ error: "A valid QoreChain address is required" }, 400);
  const stages = parseStageList(new URL(request.url).searchParams.get("stages"));
  if (!stages) return json({ error: "Choose valid reward stages" }, 400);

  const results = await Promise.all(stages.map((stage) => claimedCache(`${contract}|${stage}|${address}`, () => readClaimed(contract, stage, address))));
  const claimed: Record<string, boolean> = {};
  stages.forEach((stage, index) => {
    const value = results[index];
    if (value !== null) claimed[String(stage)] = value;
  });
  return json({ claimed });
}

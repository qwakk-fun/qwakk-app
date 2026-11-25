import { redirect } from "next/navigation";
import { SwapView } from "../../components/SwapView";
import { pairCandidates } from "../../lib/qwakk-pair-server";
import { resolvePairParam } from "../../lib/qwakk-pair-slug";

// Reads the legacy ?pool= query, so the page renders per request.
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * The swap page without a pair. A legacy `/swap?pool=6` link moves to its
 * readable form (`/swap/qwakk-qor`); when the indexer cannot say which pair
 * that is, the page opens the pool by id and fixes the address itself.
 */
export default async function SwapPage({ searchParams }: Props) {
  const query = await searchParams;
  const requested = query.pool;
  if (typeof requested === "string" && requested) {
    const candidates = await pairCandidates();
    const match = candidates ? resolvePairParam(requested, candidates) : null;
    if (match?.swapSlug) {
      // Every other parameter (utm_source and the like) travels along; only `pool` is replaced by the path.
      const rest = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (key === "pool" || value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) rest.append(key, item);
      }
      const search = rest.toString();
      redirect(`/swap/${match.swapSlug}${search ? `?${search}` : ""}`);
    }
  }
  return <SwapView />;
}

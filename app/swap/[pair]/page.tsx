import { redirect } from "next/navigation";
import { SwapView } from "../../../components/SwapView";
import { pairCandidates, pairMetadata } from "../../../lib/qwakk-pair-server";
import { matchSymbols, resolvePairParam } from "../../../lib/qwakk-pair-slug";

// Slugs follow the live pool list, so the page resolves per request.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ pair: string }> };

export async function generateMetadata({ params }: Params) {
  const candidates = await pairCandidates();
  const match = candidates ? resolvePairParam((await params).pair, candidates) : null;
  if (!match) return {};
  const { pay, receive } = matchSymbols(match);
  return pairMetadata(`Swap ${pay} for ${receive}`);
}

/**
 * The swap page for one pair. The order is the direction: `/swap/qor-qwakk`
 * pays QOR for QWAKK, `/swap/qwakk-qor` pays QWAKK for QOR. A pool id or
 * another letter case moves to the readable lowercase link. The page itself
 * resolves the pair again from the chain's pools, so it still opens the
 * right pool when the indexer is down.
 */
export default async function SwapPairPage({ params }: Params) {
  const raw = (await params).pair;
  const candidates = await pairCandidates();
  const match = candidates ? resolvePairParam(raw, candidates) : null;
  if (match?.swapSlug && raw !== match.swapSlug) redirect(`/swap/${match.swapSlug}`);
  return <SwapView pair={raw} />;
}

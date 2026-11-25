import { BRAND } from "./brand";
import { indexerRead } from "./qwakk-market";
import { withAssetOverrides } from "./qwakk-assets";
import { marketPairCandidate, type PairCandidate } from "./qwakk-pair-slug";
import type { QuoteMarket } from "./qwakk-market-view";
import { createServerCache } from "./qwakk-server-cache";

/**
 * Server side of the readable pair links (lib/qwakk-pair-slug.ts): the
 * indexed pools as slug candidates, with the same curated symbols the
 * browser shows. One indexer read serves a page and its metadata.
 */

type Candidates = PairCandidate[] | null;

const candidatesCache = createServerCache<Candidates>({
  maxEntries: 1,
  ttlMs: (value) => (value ? 10_000 : 2_000),
});

async function loadCandidates(): Promise<Candidates> {
  const data = await indexerRead("/markets") as { markets?: unknown } | null;
  if (!data || !Array.isArray(data.markets)) return null;
  return (data.markets as Array<QuoteMarket & { id: string | number }>)
    .filter((market) => market && market.id !== undefined && typeof market.token_a === "string" && typeof market.token_b === "string")
    .map((market) => marketPairCandidate(withAssetOverrides(market)));
}

/** Null when the indexer cannot be read. */
export function pairCandidates() {
  return candidatesCache("markets", loadCandidates);
}

/** Title and share card for one pair page. The site description and image stay. */
export function pairMetadata(title: string) {
  const full = `${title} | ${BRAND.name}`;
  return {
    title: full,
    openGraph: {
      title: full,
      description: BRAND.description,
      images: [{ url: "/og.png", width: 1200, height: 630, alt: full }],
    },
    twitter: {
      card: "summary_large_image" as const,
      title: full,
      description: BRAND.description,
      images: ["/og.png"],
    },
  };
}

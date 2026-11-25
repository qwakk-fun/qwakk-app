import { redirect } from "next/navigation";
import { PoolDetailView } from "../../../components/PoolDetailView";
import { pairCandidates, pairMetadata } from "../../../lib/qwakk-pair-server";
import { parsePairParam, resolvePairParam } from "../../../lib/qwakk-pair-slug";

// Slugs follow the live pool list, so the page resolves per request.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params) {
  const candidates = await pairCandidates();
  const match = candidates ? resolvePairParam((await params).id, candidates) : null;
  return match ? pairMetadata(`${match.pool.base.symbol} / ${match.pool.quote.symbol} pool`) : {};
}

/**
 * One pool, by pair ("/pools/qwakk-qor", either order) or by id ("/pools/6").
 * Every form that names a pool with a slug of its own moves to that slug, so
 * the address bar always shows the readable link. An id stays as it is when
 * the pool has no slug (another pool owns the pair), or when the indexer is
 * behind or down: the view then reads the pool itself.
 */
export default async function PoolDetailPage({ params }: Params) {
  const raw = (await params).id;
  const param = parsePairParam(raw);
  if (param.kind === "invalid") return <PoolDetailView poolId="" unresolved="missing" />;

  const candidates = await pairCandidates();
  const match = candidates ? resolvePairParam(param, candidates) : null;
  if (match?.poolSlug && raw !== match.poolSlug) redirect(`/pools/${match.poolSlug}`);
  if (match) return <PoolDetailView key={match.pool.id} poolId={match.pool.id} slug={match.poolSlug} />;
  if (param.kind === "id") return <PoolDetailView key={param.id} poolId={param.id} />;
  // The indexer did not answer: the view retries the link on its own.
  return candidates ? <PoolDetailView poolId="" unresolved="missing" /> : <PoolDetailView poolId="" unresolved="unavailable" pair={raw} />;
}

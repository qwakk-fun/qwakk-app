import { PoolDetailView } from "../../../components/PoolDetailView";

export default async function PoolDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PoolDetailView poolId={id} />;
}

import { VaultView } from "../../components/VaultView";
import { BRAND } from "../../lib/brand";

export const metadata = {
  title: `Pond Vault | ${BRAND.name}`,
  description: `${BRAND.name}'s post-quantum vault on QoreChain: balances, guards and a live queue. Withdrawals and rule changes need an ML-DSA-87 approval.`,
};

/** Read-only dashboard for the Pond Vault. Data comes from /api/vault. */
export default function VaultPage() {
  return <VaultView />;
}

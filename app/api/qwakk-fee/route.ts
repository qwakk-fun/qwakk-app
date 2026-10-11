import { getServerQwakkFeeConfig } from "@/lib/qwakk-fee-config";

/**
 * Public fee disclosure. The recipient becomes visible in the signed
 * transaction anyway; this endpoint lets the interface show it before signing.
 */
export async function GET() {
  const config = getServerQwakkFeeConfig();
  return Response.json(config, { headers: { "Cache-Control": "no-store" } });
}

import { DEFAULT_QORA_INTERFACE_FEE_BPS } from "@/lib/qora-swap-route";

const MAX_QORA_INTERFACE_FEE_BPS = 100;

export type ServerQoraFeeConfig =
  | { enabled: true; recipient: string; feeBps: number }
  | { enabled: false; feeBps: number };

function isQoreAddress(value: string) {
  return /^qor1[0-9a-z]{20,}$/i.test(value);
}

function configuredFeeBps() {
  const value = process.env.QORA_SWAP_FEE_BPS?.trim();
  if (!value) return DEFAULT_QORA_INTERFACE_FEE_BPS;
  if (!/^\d+$/.test(value)) return DEFAULT_QORA_INTERFACE_FEE_BPS;

  const feeBps = Number(value);
  return feeBps >= 0 && feeBps <= MAX_QORA_INTERFACE_FEE_BPS
    ? feeBps
    : DEFAULT_QORA_INTERFACE_FEE_BPS;
}

/**
 * Treasury ownership stays in deployment configuration. A missing or invalid
 * recipient disables Qora's application fee rather than guessing an address.
 */
export function getServerQoraFeeConfig(): ServerQoraFeeConfig {
  const recipient = process.env.QORA_TREASURY_ADDRESS?.trim() ?? "";
  const feeBps = configuredFeeBps();

  if (!recipient || !isQoreAddress(recipient)) return { enabled: false, feeBps };
  return { enabled: true, recipient, feeBps };
}

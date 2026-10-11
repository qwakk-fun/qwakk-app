import { DEFAULT_QWAKK_INTERFACE_FEE_BPS, MAX_QWAKK_INTERFACE_FEE_BPS } from "@/lib/qwakk-swap-route";

export type ServerQwakkFeeConfig =
  | { enabled: true; recipient: string; feeBps: number }
  | { enabled: false; feeBps: number };

function isQoreAddress(value: string) {
  return /^qor1[0-9a-z]{20,}$/i.test(value);
}

function configuredFeeBps() {
  const value = process.env.QWAKK_SWAP_FEE_BPS?.trim();
  if (!value) return DEFAULT_QWAKK_INTERFACE_FEE_BPS;
  if (!/^\d+$/.test(value)) return DEFAULT_QWAKK_INTERFACE_FEE_BPS;

  const feeBps = Number(value);
  return feeBps >= 0 && feeBps <= MAX_QWAKK_INTERFACE_FEE_BPS
    ? feeBps
    : DEFAULT_QWAKK_INTERFACE_FEE_BPS;
}

/**
 * Treasury ownership stays in deployment configuration. A missing or invalid
 * recipient disables Qwakk's application fee rather than guessing an address.
 */
export function getServerQwakkFeeConfig(): ServerQwakkFeeConfig {
  const recipient = process.env.QWAKK_TREASURY_ADDRESS?.trim() ?? "";
  const feeBps = configuredFeeBps();

  if (!recipient || !isQoreAddress(recipient)) return { enabled: false, feeBps };
  return { enabled: true, recipient, feeBps };
}

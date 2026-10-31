import { isValidBech32 } from "@qorechain/sdk";

import { DEFAULT_QWAKK_INTERFACE_FEE_BPS, MAX_QWAKK_INTERFACE_FEE_BPS } from "@/lib/qwakk-swap-route";

export type ServerQwakkFeeConfig =
  | { enabled: true; recipient: string; feeBps: number }
  | { enabled: false; feeBps: number };

export type FeeEnv = Readonly<Record<string, string | undefined>>;

/**
 * A `qor1` account address with a valid bech32 checksum. `isValidBech32` is
 * from `@qorechain/sdk` 0.8.2 (`dist/index.d.ts`: "structurally valid bech32
 * string (correct checksum) and ... its prefix matches").
 */
export function isQoreAccountAddress(value: string) {
  return /^qor1[0-9a-z]{20,}$/.test(value) && isValidBech32(value, "qor");
}

/**
 * Resolves the interface fee from deployment configuration. Pure, so tests
 * can call it. It fails closed:
 *
 * - no `QWAKK_TREASURY_ADDRESS`: no fee (the normal state until a treasury is approved);
 * - a treasury that is not a valid `qor1` address: no fee, with a warning;
 * - `QWAKK_SWAP_FEE_BPS` unset: the default 10 bps;
 * - `QWAKK_SWAP_FEE_BPS` not a whole number, or above the 30 bps public cap: no fee, with a warning;
 * - `QWAKK_SWAP_FEE_BPS=0`: no fee.
 *
 * A disabled config still carries the planned rate in `feeBps` (the fees page
 * says what the fee will be once it is on); every path that charges checks
 * `enabled` first.
 */
export function resolveQwakkFeeConfig(env: FeeEnv): { config: ServerQwakkFeeConfig; warnings: string[] } {
  const warnings: string[] = [];
  const recipient = env.QWAKK_TREASURY_ADDRESS?.trim() ?? "";
  const rawBps = env.QWAKK_SWAP_FEE_BPS?.trim() ?? "";

  let feeBps = DEFAULT_QWAKK_INTERFACE_FEE_BPS;
  if (rawBps) {
    if (!/^\d+$/.test(rawBps) || Number(rawBps) > MAX_QWAKK_INTERFACE_FEE_BPS) {
      warnings.push(`QWAKK_SWAP_FEE_BPS="${rawBps}" is not a whole number from 0 to ${MAX_QWAKK_INTERFACE_FEE_BPS}. The interface fee is off.`);
      return { config: { enabled: false, feeBps: DEFAULT_QWAKK_INTERFACE_FEE_BPS }, warnings };
    }
    feeBps = Number(rawBps);
  }

  if (!recipient) return { config: { enabled: false, feeBps }, warnings };
  if (!isQoreAccountAddress(recipient)) {
    warnings.push("QWAKK_TREASURY_ADDRESS is not a valid qor1 address. The interface fee is off.");
    return { config: { enabled: false, feeBps }, warnings };
  }
  if (feeBps === 0) return { config: { enabled: false, feeBps: 0 }, warnings };
  return { config: { enabled: true, recipient, feeBps }, warnings };
}

const warned = new Set<string>();

/**
 * Treasury ownership stays in deployment configuration. Read per request, so
 * a CapRover change applies without a rebuild. Each warning is logged once.
 */
export function getServerQwakkFeeConfig(): ServerQwakkFeeConfig {
  const { config, warnings } = resolveQwakkFeeConfig(process.env);
  for (const warning of warnings) {
    if (warned.has(warning)) continue;
    warned.add(warning);
    console.warn(`[qwakk-fee] ${warning}`);
  }
  return config;
}

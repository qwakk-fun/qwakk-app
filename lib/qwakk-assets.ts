export type QwakkAsset = {
  denom: string;
  symbol: string;
  name: string;
  decimals: number;
  icon: "qor" | "usd" | "generic";
};

const KNOWN_ASSETS: Record<string, QwakkAsset> = {
  uqor: { denom: "uqor", symbol: "QOR", name: "Qore", decimals: 6, icon: "qor" },
  uusdc: { denom: "uusdc", symbol: "USDC", name: "USD Coin", decimals: 6, icon: "usd" },
};

export function assetForDenom(denom: string): QwakkAsset | undefined {
  return KNOWN_ASSETS[denom.toLowerCase()];
}

export function displaySymbol(denom: string) {
  return assetForDenom(denom)?.symbol ?? denom.replace(/^u/, "").toUpperCase();
}

export function formatBaseAmount(amount: string, decimals: number, maximumFractionDigits = 4) {
  if (!/^\d+$/.test(amount) || !Number.isInteger(decimals) || decimals < 0) return amount;
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "").slice(0, maximumFractionDigits);
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Converts a human-readable token amount to the chain's integer base unit. */
export function toBaseAmount(value: string, decimals: number) {
  const amount = value.trim();
  if (!/^\d*(?:\.\d*)?$/.test(amount) || amount === "" || amount === ".") {
    throw new Error("Enter a valid amount");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Use a valid token decimal setting");

  const [wholeInput = "0", fractionInput = ""] = amount.split(".");
  if (fractionInput.length > decimals) throw new Error(`This token supports up to ${decimals} decimal places`);
  const whole = wholeInput || "0";
  const fraction = fractionInput.padEnd(decimals, "0");
  const base = BigInt(whole) * (BigInt(10) ** BigInt(decimals)) + BigInt(fraction || "0");
  if (base <= BigInt(0)) throw new Error("Amount must be greater than zero");
  return base.toString();
}

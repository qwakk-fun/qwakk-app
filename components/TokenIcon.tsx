import { assetForDenom, displaySymbol } from "../lib/qwakk-assets";

export function TokenIcon({ denom, size = "regular" }: { denom: string; size?: "small" | "regular" | "large" | "avatar" }) {
  const asset = assetForDenom(denom);
  if (asset?.icon === "qor") return <img className={`token-icon ${size} qor-icon`} src="/qorechain-mark.png" alt="" aria-hidden="true" />;
  return <span className={`token-icon ${size} ${asset?.icon === "usd" ? "usd-icon" : "generic-icon"}`} aria-hidden="true">{asset?.icon === "usd" ? "$" : displaySymbol(denom).slice(0, 1)}</span>;
}

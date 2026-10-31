import { assetForDenom, displaySymbol } from "../lib/qwakk-assets";

/**
 * Coin marks. QOR and ATOM use their official marks (QoreChain's, and the
 * Cosmos Hub ATOM mark from cosmos/chain-registry). The Diana test tokens
 * fUSD, fETH and fBTC have no official artwork, so they get a plain colored
 * badge. fETH and fBTC use plain letters, so a test token never borrows the
 * ETH or BTC sign. Anything else shows its first letter.
 */
const BADGE_GLYPH = { usd: "$", eth: "E", btc: "B" } as const;

export function TokenIcon({ denom, size = "regular" }: { denom: string; size?: "small" | "regular" | "large" | "avatar" }) {
  const asset = assetForDenom(denom);
  if (asset?.icon === "qor") return <img className={`token-icon ${size} qor-icon`} src="/qorechain-mark.png" alt="" aria-hidden="true" />;
  if (asset?.icon === "atom") return <img className={`token-icon ${size} atom-icon`} src="/tokens/atom.svg" alt="" aria-hidden="true" />;
  if (asset && (asset.icon === "usd" || asset.icon === "eth" || asset.icon === "btc")) {
    return <span className={`token-icon ${size} ${asset.icon}-icon`} aria-hidden="true">{BADGE_GLYPH[asset.icon]}</span>;
  }
  const letter = displaySymbol(denom).replace(/^(0x|IBC )/i, "").charAt(0).toUpperCase() || "?";
  return <span className={`token-icon ${size} generic-icon`} aria-hidden="true">{letter}</span>;
}

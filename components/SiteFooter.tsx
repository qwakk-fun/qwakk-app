import { BRAND } from "../lib/brand";

/** One slim line: data credits and outbound links. Navigation lives in the rail. */
export function SiteFooter() {
  return <footer className="site-footer">
    <span>{BRAND.name} never holds your keys or funds.</span>
    <span className="site-footer-links">
      QOR data from <a href="https://www.coingecko.com/en/coins/qorechain" target="_blank" rel="noreferrer">CoinGecko</a>
      <i aria-hidden="true">·</i>
      Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView</a>
      <i aria-hidden="true">·</i>
      <a href="https://docs.qorechain.io/" target="_blank" rel="noreferrer">QoreChain docs</a>
    </span>
  </footer>;
}

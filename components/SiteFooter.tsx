import Link from "next/link";
import { BRAND } from "../lib/brand";
import { BrandMark } from "./BrandMark";

export function SiteFooter() {
  return <footer className="site-footer">
    <div className="container site-footer-inner">
      <span className="brand"><BrandMark size={22} /><span>{BRAND.name}</span></span>
      <nav aria-label="Footer">
        <Link href="/swap">Trade</Link>
        <Link href="/pools">Pools</Link>
        <Link href="/profile">Portfolio</Link>
        <a href="https://docs.qorechain.io/" target="_blank" rel="noreferrer">QoreChain docs ↗</a>
        <a href="https://explore.qore.network/" target="_blank" rel="noreferrer">Explorer ↗</a>
      </nav>
      <span>QOR market data from <a href="https://www.coingecko.com/en/coins/qorechain" target="_blank" rel="noreferrer">CoinGecko</a>. Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView</a>.</span>
    </div>
  </footer>;
}

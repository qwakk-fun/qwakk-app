import { QoraHeader } from "../components/QoraHeader";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

export default function Home() {
  return <main className="landing-shell">
    <QoraHeader page="home" />
    <section className="landing-hero" aria-labelledby="landing-title">
      <div className="landing-copy">
        <p className="eyebrow"><span className="status-dot online" /> QORECHAIN DIANA</p>
        <h1 id="landing-title">Simple swaps.<br /><em>On QoreChain.</em></h1>
        <p>Qora is a clear, non-custodial way to swap and provide liquidity on QoreChain. Every on-chain action is designed to feel straightforward.</p>
        <div className="landing-actions"><Link className="landing-primary" href="/swap">Open Qora <ArrowUpRight size={17} strokeWidth={2.4} /></Link><Link className="landing-secondary" href="/pools">Explore pools</Link></div>
        <div className="landing-trust"><span>Non-custodial</span><i /><span>Clear approvals</span><i /><span>Built on QoreChain</span></div>
      </div>
      <div className="landing-art" aria-label="Qora and QoreChain">
        <span className="landing-ring ring-one" /><span className="landing-grid" />
        <div className="qora-orb"><img src="/qora-mark.png" alt="Qora" /></div>
      </div>
    </section>

    <section className="landing-proof" aria-label="Qora principles">
      <article><span>01</span><h2>Made to feel clear.</h2><p>Simple amounts, simple prices, and a calm confirmation flow without unnecessary trading clutter.</p></article>
      <article><span>02</span><h2>Your wallet stays yours.</h2><p>Qora never takes custody. You review every on-chain action in your own wallet before it happens.</p></article>
      <article><span>03</span><h2>Ready for what&apos;s next.</h2><p>Qora is built around QoreChain&apos;s native liquidity layer and its quantum-safe security foundation.</p></article>
    </section>

    <footer><span>QORA / QORECHAIN</span><span>Simple swaps on QoreChain</span><a href="https://docs.qorechain.io/" target="_blank" rel="noreferrer">Explore QoreChain ↗</a></footer>
  </main>;
}

import Link from "next/link";
import { ArrowRight, ArrowUpRight, Eye, KeyRound, Layers, ShieldCheck } from "lucide-react";
import { PoolBoard, StatsStrip, TickerCard } from "../components/LandingLive";
import { QoraHeader } from "../components/QoraHeader";
import { SiteFooter } from "../components/SiteFooter";
import { BRAND } from "../lib/brand";

const BAND_WORDS = ["Non-custodial", "Native AMM", "Visible fees", "Quantum-safe network", "QoreChain Diana"];

export default function Home() {
  return <div className="app-shell">
    <QoraHeader page="home" />
    <main className="landing">
      <section className="container hero" aria-labelledby="landing-title">
        <div className="hero-main">
          <span className="sticker"><Layers size={14} />Built on the QoreChain AMM module</span>
          <h1 id="landing-title" className="display">Simple <span className="hl">swaps</span><br />on QoreChain.</h1>
          <p className="hero-copy">{BRAND.name} is a fast, non-custodial exchange for the QoreChain native network. Clear prices, visible fees, and your keys never leave your wallet.</p>
          <div className="hero-actions">
            <Link className="btn btn-primary btn-lg btn-pop" href="/swap">Open app <ArrowRight size={17} /></Link>
            <Link className="btn btn-ghost btn-lg" href="/pools">Explore pools</Link>
          </div>
          <div className="hero-trust">
            <span><KeyRound size={15} />Non-custodial</span>
            <span><ShieldCheck size={15} />Quantum-safe network</span>
            <span><Eye size={15} />Fees shown up front</span>
          </div>
        </div>
        <TickerCard />
      </section>

      <div className="band" aria-hidden="true">
        <div className="band-track">{[0, 1].map((copy) => <span className="band-half" key={copy}>{[...BAND_WORDS, ...BAND_WORDS].map((word, index) => <span key={index}>{word}<i>✦</i></span>)}</span>)}</div>
      </div>

      <div className="container"><StatsStrip /></div>

      <section className="container section" aria-labelledby="board-title">
        <div className="section-head section-head-row">
          <div>
            <span className="kicker">Live board</span>
            <h2 id="board-title">Busiest pools right now.</h2>
          </div>
          <Link className="btn btn-ghost btn-sm" href="/pools">All pools <ArrowUpRight size={14} /></Link>
        </div>
        <PoolBoard />
      </section>

      <section className="container section" aria-labelledby="features-title">
        <div className="section-head">
          <span className="kicker">Why {BRAND.name}</span>
          <h2 id="features-title">A calmer way to trade on QoreChain.</h2>
          <p>Everything you need to judge a trade sits on one screen, with nothing hidden behind extra steps.</p>
        </div>
        <div className="feature-grid">
          <article className="feature">
            <span className="feature-index mono">01</span>
            <span className="feature-icon"><Layers size={20} /></span>
            <h3>Native to QoreChain</h3>
            <p>Pools and quotes come straight from the chain&apos;s own AMM module. No wrapped tokens and no separate contract layer.</p>
          </article>
          <article className="feature">
            <span className="feature-index mono">02</span>
            <span className="feature-icon is-pink"><KeyRound size={20} /></span>
            <h3>Your wallet stays yours</h3>
            <p>{BRAND.name} never holds keys or funds. Every on-chain action is approved in your own QoreX wallet.</p>
          </article>
          <article className="feature">
            <span className="feature-index mono">03</span>
            <span className="feature-icon is-blue"><Eye size={20} /></span>
            <h3>Prices you can read</h3>
            <p>Expected output, price protection and every fee are shown in plain numbers before anything reaches the chain.</p>
          </article>
        </div>
      </section>

      <section className="container section">
        <div className="cta-band">
          <div>
            <h2 className="display">Follow QOR and every pool in one place.</h2>
            <p>Live QOR pricing, QoreChain Diana pools and your wallet, side by side.</p>
          </div>
          <Link className="btn btn-ink btn-lg" href="/swap">Start trading <ArrowRight size={17} /></Link>
        </div>
      </section>
    </main>
    <SiteFooter />
  </div>;
}

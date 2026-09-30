import Link from "next/link";
import { ArrowRight, Eye, KeyRound, Layers, ShieldCheck } from "lucide-react";
import { StatsStrip, TickerCard } from "../components/LandingLive";
import { QoraHeader } from "../components/QoraHeader";
import { SiteFooter } from "../components/SiteFooter";
import { BRAND } from "../lib/brand";

export default function Home() {
  return <div className="app-shell">
    <QoraHeader page="home" />
    <main className="landing">
      <section className="container hero" aria-labelledby="landing-title">
        <div>
          <span className="hero-badge"><b>Native</b>Built on the QoreChain AMM module</span>
          <h1 id="landing-title">Simple swaps<br /><em>on QoreChain.</em></h1>
          <p className="hero-copy">{BRAND.name} is a fast, non-custodial exchange for the QoreChain native network. Clear prices, visible fees, and your keys never leave your wallet.</p>
          <div className="hero-actions">
            <Link className="btn btn-primary btn-lg" href="/swap">Open app <ArrowRight size={17} /></Link>
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

      <div className="container"><StatsStrip /></div>

      <section className="container section" aria-labelledby="features-title">
        <div className="section-head">
          <span className="kicker">Why {BRAND.name}</span>
          <h2 id="features-title">A calmer way to trade on QoreChain.</h2>
          <p>Everything you need to judge a trade sits on one screen, with nothing hidden behind extra steps.</p>
        </div>
        <div className="feature-grid">
          <article className="panel feature">
            <span className="feature-icon"><Layers size={19} /></span>
            <h3>Native to QoreChain</h3>
            <p>Pools and quotes come straight from the chain&apos;s own AMM module. No wrapped tokens and no separate contract layer.</p>
          </article>
          <article className="panel feature">
            <span className="feature-icon"><KeyRound size={19} /></span>
            <h3>Your wallet stays yours</h3>
            <p>{BRAND.name} never holds keys or funds. Every on-chain action is approved in your own QoreX wallet.</p>
          </article>
          <article className="panel feature">
            <span className="feature-icon"><Eye size={19} /></span>
            <h3>Prices you can read</h3>
            <p>Expected output, price protection and every fee are shown in plain numbers before anything reaches the chain.</p>
          </article>
        </div>
      </section>

      <section className="container">
        <div className="panel cta-band">
          <div>
            <h2>Follow QOR and every pool in one place.</h2>
            <p>Live QOR pricing, QoreChain Diana pools and your wallet, side by side.</p>
          </div>
          <Link className="btn btn-primary btn-lg" href="/swap">Open app <ArrowRight size={17} /></Link>
        </div>
      </section>
    </main>
    <SiteFooter />
  </div>;
}

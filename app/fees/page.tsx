import { Coins, Droplets, Gauge, Network, ShieldCheck } from "lucide-react";
import { QwakkHeader } from "../../components/QwakkHeader";
import { SiteFooter } from "../../components/SiteFooter";
import { BRAND } from "../../lib/brand";
import { getServerQwakkFeeConfig } from "../../lib/qwakk-fee-config";
import { MAX_QWAKK_INTERFACE_FEE_BPS } from "../../lib/qwakk-swap-route";
import { QORECHAIN_REST_URL } from "../../lib/qorechain-endpoints";

export const metadata = {
  title: `Fees | ${BRAND.name}`,
  description: `Every fee on ${BRAND.name}, in plain numbers, with a hard cap on the interface fee.`,
};

function percent(bps: number) {
  return `${(bps / 100).toFixed(2)}%`;
}

/** The native AMM's swap fee, read live from QoreChain. Null when the chain cannot be reached. */
async function poolFeeBps() {
  try {
    const response = await fetch(`${QORECHAIN_REST_URL}/qorechain/amm/v1/params`, { cache: "no-store", signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return null;
    const data = await response.json() as { params?: { swap_fee_bps?: number | string } };
    const value = Number(data.params?.swap_fee_bps);
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

const EXAMPLE_QOR = 1_000;

export default async function FeesPage() {
  const fee = getServerQwakkFeeConfig();
  const poolBps = await poolFeeBps();
  const cap = percent(MAX_QWAKK_INTERFACE_FEE_BPS);
  const interfacePct = percent(fee.feeBps);
  const exampleInterface = fee.enabled ? (EXAMPLE_QOR * fee.feeBps) / 10_000 : 0;
  const examplePool = poolBps === null ? null : ((EXAMPLE_QOR - exampleInterface) * poolBps) / 10_000;
  const qor = (value: number) => `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value)} QOR`;

  return <div className="app-shell">
    <QwakkHeader page="fees" />
    <main className="app-main">
      <div className="container fees">
        <section className="page-head">
          <div>
            <span className="kicker">Pricing</span>
            <h1>Fees</h1>
            <p>Every swap shows its full cost before you approve it in QoreX. No hidden spread, no surprises.</p>
          </div>
        </section>

        <section className="fee-promise" aria-labelledby="promise-title">
          <span className="fee-promise-icon"><ShieldCheck size={22} /></span>
          <div>
            <h2 id="promise-title">Never more than {cap}</h2>
            <p>The {BRAND.name} interface fee has a hard cap written into the code, so nobody can quietly raise it.</p>
          </div>
        </section>

        <section className="fee-grid" aria-label="Fee breakdown">
          <article className="fee-card">
            <span className="fee-card-icon"><Coins size={18} /></span>
            <h3>Interface fee</h3>
            <strong className="num">{fee.enabled ? interfacePct : "None today"}</strong>
            <p>{fee.enabled
              ? `Taken from the amount you pay and sent to the public ${BRAND.name} treasury in the same transaction. Listed on every quote before you sign.`
              : `${BRAND.name} charges no interface fee right now. Once it is switched on it will be ${interfacePct} of the amount you pay, listed on every quote before you sign.`}</p>
            {fee.enabled && <p className="fee-address"><span>Treasury</span><code>{fee.recipient}</code></p>}
          </article>
          <article className="fee-card">
            <span className="fee-card-icon"><Droplets size={18} /></span>
            <h3>Pool fee</h3>
            <strong className="num">{poolBps === null ? "Set by QoreChain" : percent(poolBps)}</strong>
            <p>Set by the QoreChain native AMM and applied inside the pool. It is already part of the quoted output and is never paid to {BRAND.name}.</p>
          </article>
          <article className="fee-card">
            <span className="fee-card-icon"><Network size={18} /></span>
            <h3>Network fee</h3>
            <strong>Paid in QOR</strong>
            <p>A small QoreChain transaction fee that goes to the network. QoreX shows the exact amount before you approve.</p>
          </article>
        </section>

        <div className="fee-split">
          <section className="panel" aria-labelledby="example-title">
            <div className="panel-head"><span className="panel-title" id="example-title">Example: paying {qor(EXAMPLE_QOR)}</span></div>
            <div className="info-list">
              <div><span>Interface fee</span><b className="num">{fee.enabled ? qor(exampleInterface) : "None"}</b></div>
              <div><span>Pool fee</span><b className="num">{examplePool === null ? "Shown on the quote" : `About ${qor(examplePool)}`}</b></div>
              <div><span>Network fee</span><b>Shown in QoreX</b></div>
            </div>
            <p className="panel-note">The pool fee applies to the amount that reaches the pool, after the interface fee.</p>
          </section>
          <section className="panel fee-note" aria-labelledby="protection-title">
            <div className="panel-head"><span className="panel-title" id="protection-title"><Gauge size={16} />Price protection is not a fee</span></div>
            <p className="panel-body">Price protection is the most the price may move before your swap cancels itself. It keeps you from a bad fill and never costs anything extra.</p>
          </section>
        </div>
      </div>
    </main>
    <SiteFooter />
  </div>;
}

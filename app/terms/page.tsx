import Link from "next/link";
import { LegalPage } from "../../components/LegalPage";
import { BRAND } from "../../lib/brand";
import { MAX_QWAKK_INTERFACE_FEE_BPS } from "../../lib/qwakk-swap-route";

export const metadata = {
  title: `Terms of Use | ${BRAND.name}`,
  description: `The rules for using the ${BRAND.name} interface.`,
};

// Draft for legal review. Governing law, venue and a contact address are added once the operating entity exists.
export default function TermsPage() {
  const name = BRAND.name;
  return <LegalPage href="/terms" title="Terms of Use" intro={`These terms apply whenever you use the ${name} website and interface. By using it you agree to them. If you do not agree, do not use ${name}.`}>
    <section>
      <h2>1. What {name} is</h2>
      <p>{name} is software: a website that helps you read data from the QoreChain network and prepare transactions for its native automated market maker (AMM), such as swapping tokens, adding or removing liquidity and creating pools, where those features are switched on. {name} is not an exchange, broker, bank, custodian or financial adviser, and it does not create or issue tokens. Swaps happen in pools on QoreChain itself, not on {name}.</p>
      <p>{name} can connect to a QoreChain test network, such as QoreChain Diana, or to QoreChain mainnet. The app shows which network it is connected to.</p>
    </section>
    <section>
      <h2>2. Who can use {name}</h2>
      <ul>
        <li>You must be at least 18 years old and able to enter into a binding agreement.</li>
        <li>You must not be located in, or a resident or national of, a country or region under comprehensive sanctions imposed by the United Nations, the United States, the European Union or the United Kingdom (for example North Korea, Iran or Cuba). You must also not appear on any of their sanctions lists. People in the sanctioning countries themselves can use {name} as normal.</li>
        <li>You must not use {name} where doing so is against the law that applies to you. You are responsible for knowing and following that law.</li>
      </ul>
      <p>We may block or limit access from any region at any time.</p>
    </section>
    <section>
      <h2>3. You keep control of your funds</h2>
      <p>{name} never holds your private keys, seed phrase or funds and cannot move them. Every transaction is created in the interface and signed by you in your own wallet, such as QoreX, which is third-party software. Once a transaction is broadcast to QoreChain, nobody, including us, can cancel, reverse or recover it.</p>
    </section>
    <section>
      <h2>4. No advice</h2>
      <p>Nothing on {name} is financial, investment, legal or tax advice, or a recommendation to buy, sell or hold any asset. Prices, charts, trending lists, rankings and labels such as &quot;Hot&quot; are generated automatically from on-chain and third-party data. We owe you no fiduciary duty.</p>
    </section>
    <section>
      <h2>5. Third parties</h2>
      <p>QoreChain, its AMM module, QoreX, the tokens and pools shown, CoinGecko price data and other services are run by third parties. We do not control, verify or endorse them, and we are not responsible for their availability, accuracy or behavior. Anyone can create a pool on QoreChain. A token&apos;s name or symbol says nothing about who issued it.</p>
    </section>
    <section>
      <h2>6. Fees</h2>
      <p>{name} may charge an interface fee on swaps. When it applies, it is taken from the amount you pay and sent to the {name} treasury as a separate transfer inside the same transaction as your swap. {name} shows the fee amount before you sign, and it will never exceed {(MAX_QWAKK_INTERFACE_FEE_BPS / 100).toFixed(2)}% of the amount you pay. Your wallet may list this transfer without showing the fee amount.</p>
      <p>Pool fees, the pool creation fee and network fees are set by QoreChain and are never paid to {name}. See <Link href="/fees">Fees</Link> for details.</p>
    </section>
    <section>
      <h2>7. Test networks</h2>
      <p>On a QoreChain test network, such as QoreChain Diana, tokens are for testing only and have no monetary value. A test network can be paused, changed or reset by its operators at any time, and activity there says nothing about how mainnet will behave.</p>
    </section>
    <section>
      <h2>8. Points</h2>
      <p>{name} may run a points program that ranks public on-chain activity. Points have no monetary value, are not a token and cannot be sold, transferred or exchanged. They come with no promise of any future token, payment or benefit. We may change the rules, correct scores or reset points at any time, and a change can apply to past activity too.</p>
    </section>
    <section>
      <h2>9. Your responsibilities</h2>
      <ul>
        <li>Before you sign, check the token, amount, minimum received and fees shown in {name}, and review the transaction in your wallet.</li>
        <li>Keep your wallet, device and recovery phrase secure.</li>
        <li>Do your own research and only trade what you can afford to lose.</li>
        <li>Report and pay any taxes that apply to you.</li>
      </ul>
    </section>
    <section>
      <h2>10. What you must not do</h2>
      <p>Do not use {name} to break any law, evade sanctions, launder money, finance terrorism, manipulate markets, infringe anyone&apos;s rights, or attack, overload, scrape at harmful volume or interfere with the interface or its servers.</p>
    </section>
    <section>
      <h2>11. Provided as is</h2>
      <p>{name} is provided &quot;as is&quot; and &quot;as available&quot;, without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, accuracy and non-infringement. We do not promise that it will be uninterrupted, secure or error free, or that any data shown is correct or current.</p>
    </section>
    <section>
      <h2>12. Limitation of liability</h2>
      <p>To the fullest extent permitted by law, {name} and the people behind it are not liable for any indirect, incidental, special, consequential or punitive damages, or for any loss of funds, tokens, profits, data or opportunity, arising from your use of {name}, your transactions, third-party services, network failures, bugs, or the actions of other users. To the same extent, our total liability for any claim is limited to the interface fees you paid to {name} in the 12 months before the claim. Nothing in these terms limits liability that cannot be limited under applicable law.</p>
    </section>
    <section>
      <h2>13. Indemnity</h2>
      <p>You agree to cover {name} and the people behind it against claims, losses and costs caused by your breach of these terms, your misuse of {name} or your violation of any law or third-party right.</p>
    </section>
    <section>
      <h2>14. Changes</h2>
      <p>We may change, suspend or discontinue any part of {name}, and we may update these terms. When the terms change in a meaningful way, the app asks you to accept the new version before you continue.</p>
    </section>
  </LegalPage>;
}

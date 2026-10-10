import { LegalPage } from "../../components/LegalPage";
import { BRAND } from "../../lib/brand";

export const metadata = {
  title: `Privacy Policy | ${BRAND.name}`,
  description: `What ${BRAND.name} stores, and what it does not.`,
};

// Draft for legal review. Keep it in step with the code: storage keys, server logs and third-party calls.
export default function PrivacyPage() {
  const name = BRAND.name;
  return <LegalPage href="/privacy" title="Privacy Policy" intro={`${name} is built to know as little about you as possible. There are no accounts, no cookies and no trackers.`}>
    <section>
      <h2>What we do not collect</h2>
      <p>We do not ask for your name, email address, phone number or identity documents. {name} sets no cookies and uses no analytics, advertising or tracking tools.</p>
    </section>
    <section>
      <h2>What stays in your browser</h2>
      <p>To make the app work, your browser keeps a few small values in its local storage on your device:</p>
      <ul>
        <li>The public address of the wallet you connected.</li>
        <li>Display choices, such as grid or table view.</li>
        <li>Which version of our legal documents you accepted, and that you accepted it.</li>
      </ul>
      <p>These values never leave your device unless the app needs them for a request described below. You can remove them at any time by clearing your browser&apos;s site data.</p>
    </section>
    <section>
      <h2>What our servers see</h2>
      <p>When the app loads balances, positions or activity, it sends your public wallet address to our server, which reads the matching public data from QoreChain. Our hosting may also keep standard server logs, such as IP address, time and the page requested, for security and troubleshooting, for a limited period.</p>
    </section>
    <section>
      <h2>Public blockchain data</h2>
      <p>Wallet addresses, balances and transactions on QoreChain are public by design and visible to anyone. {name} only reads them. We cannot change or delete anything recorded on the blockchain.</p>
    </section>
    <section>
      <h2>Third parties</h2>
      <p>Our server, not your browser, contacts QoreChain network endpoints and CoinGecko for market data. Your wallet, such as QoreX, is separate software with its own privacy policy. We do not sell or share data with advertisers.</p>
    </section>
    <section>
      <h2>Your rights</h2>
      <p>Depending on where you live, for example under the GDPR, you may have rights to access, correct or delete personal data and to object to its use. Because {name} keeps almost nothing, clearing your browser&apos;s site data removes everything stored on your side.</p>
    </section>
    <section>
      <h2>Changes</h2>
      <p>If we start collecting anything new, we will update this policy first and ask you to accept the new version in the app.</p>
    </section>
  </LegalPage>;
}

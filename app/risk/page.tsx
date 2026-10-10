import { LegalPage } from "../../components/LegalPage";
import { BRAND } from "../../lib/brand";

export const metadata = {
  title: `Risk Disclosure | ${BRAND.name}`,
  description: "The risks of swapping and providing liquidity on QoreChain, in plain words.",
};

const RISKS = [
  { title: "You can lose everything you put in", body: "Crypto asset prices move fast and can fall to zero. Only trade what you can afford to lose completely." },
  { title: "Transactions are final", body: "Once a transaction is on QoreChain it cannot be cancelled, reversed or refunded. A mistake in the token, amount or address is permanent." },
  { title: "Prices move while you swap", body: "Thin pools and large trades move the price. Price protection cancels a swap that would move too far, but you can still receive less than the price you first saw." },
  { title: "Anyone can create a token", body: "Tokens and pools can be created by anyone, including scammers who copy well-known names and symbols. Always check what you are buying." },
  { title: "Liquidity has its own risks", body: "Providing liquidity can return less value than simply holding the two tokens, because the pool rebalances as prices change (impermanent loss)." },
  { title: "Technology can fail", body: "QoreChain, its AMM module, wallets such as QoreX and this website are software. Bugs, upgrades, outages or attacks can delay, block or break transactions." },
  { title: "Data can be wrong or late", body: "Prices, charts and rankings come from the blockchain, our indexer and third parties such as CoinGecko. They can be delayed or inaccurate." },
  { title: "Rules can change", body: "Laws and regulations on crypto assets differ by country and change often. Access to some features may become restricted where you live." },
  { title: "Taxes are your responsibility", body: "Swaps and liquidity may create tax obligations. Ask a tax adviser where you live." },
];

export default function RiskPage() {
  return <LegalPage href="/risk" title="Risk Disclosure" intro={`${BRAND.name} makes swapping simple, but the risks underneath stay real. Please read these before you trade.`}>
    <ol className="risk-list">
      {RISKS.map((risk) => <li key={risk.title}><h2>{risk.title}</h2><p>{risk.body}</p></li>)}
    </ol>
  </LegalPage>;
}

import { Board } from "../components/Board";
import { QoraHeader } from "../components/QoraHeader";
import { SiteFooter } from "../components/SiteFooter";

export default function Home() {
  return <div className="app-shell">
    <QoraHeader page="home" />
    <main className="board-main">
      <Board />
    </main>
    <SiteFooter />
  </div>;
}

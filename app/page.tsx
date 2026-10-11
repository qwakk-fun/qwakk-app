import { Board } from "../components/Board";
import { QwakkHeader } from "../components/QwakkHeader";
import { SiteFooter } from "../components/SiteFooter";

export default function Home() {
  return <div className="app-shell">
    <QwakkHeader page="home" />
    <main className="board-main">
      <Board />
    </main>
    <SiteFooter />
  </div>;
}

import Link from "next/link";
import type { ReactNode } from "react";
import { QwakkHeader } from "./QwakkHeader";
import { SiteFooter } from "./SiteFooter";
import { LEGAL_PAGES, LEGAL_UPDATED } from "../lib/legal";

/** Shared frame for the Terms, Privacy Policy and Risk Disclosure. */
export function LegalPage({ href, title, intro, children }: { href: string; title: string; intro: string; children: ReactNode }) {
  return <div className="app-shell">
    <QwakkHeader page="legal" />
    <main className="app-main">
      <div className="container legal">
        <nav className="legal-nav" aria-label="Legal documents">
          {LEGAL_PAGES.map((page) => <Link key={page.href} href={page.href} aria-current={page.href === href ? "page" : undefined}>{page.label}</Link>)}
        </nav>
        <article className="legal-doc">
          <header>
            <span className="kicker">Last updated {LEGAL_UPDATED}</span>
            <h1>{title}</h1>
            <p className="legal-intro">{intro}</p>
          </header>
          {children}
        </article>
      </div>
    </main>
    <SiteFooter />
  </div>;
}

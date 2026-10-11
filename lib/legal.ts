/**
 * Version of the Terms, Privacy Policy and Risk Disclosure. Bump it whenever
 * any of them changes materially: every visitor is asked to accept again.
 */
export const LEGAL_VERSION = "2026-10-10";
export const LEGAL_UPDATED = "October 10, 2026";

export const CONSENT_KEY = "qwakk-legal-consent";
/** Asks the consent dialog to open, for example before a wallet connects. */
export const CONSENT_EVENT = "qwakk:request-consent";

export const LEGAL_PAGES = [
  { href: "/terms", label: "Terms of Use" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/risk", label: "Risk Disclosure" },
] as const;

export function hasConsent() {
  try {
    return window.localStorage.getItem(CONSENT_KEY) === LEGAL_VERSION;
  } catch {
    return false;
  }
}

export function saveConsent() {
  try {
    window.localStorage.setItem(CONSENT_KEY, LEGAL_VERSION);
  } catch {
    // Without storage the dialog simply asks again on the next visit.
  }
}

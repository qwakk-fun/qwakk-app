/**
 * Phone browsers cannot run the QoreX extension, so a visitor on Chrome or
 * Safari for mobile has no `window.qorex`. The QoreX mobile app has an in-app
 * dApp browser that injects the same `window.qorex` provider
 * (docs.qorechain.io/qorex/dapp-browser), so the way in is to open Qwakk there.
 *
 * `https://link.qore.network/browse?url=<encoded https address>` opens a page
 * straight in that dApp browser (QoreChain, 2026-11-18; QoreX iOS 1.2.2
 * release note "Links can now open a page directly in the QoreX browser").
 * link.qore.network's apple-app-site-association lists `/browse*` for
 * `3J8ZG52AM3.io.qorechain.qorex`, and its assetlinks.json verifies
 * `network.qore.qorex` for all URLs. Without the app the same address shows
 * QoreX's own "open this link in the QoreX app" page, so the sheet keeps the
 * store links and the copy-and-paste route as a fallback.
 */

/** From qorechain.io/qorex ("how to access"), checked 2026-11-15. */
export const QOREX_APP_STORE_URL = "https://apps.apple.com/us/app/qorex/id6791256626";
export const QOREX_PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=network.qore.qorex";

export type MobilePlatform = "ios" | "android" | "other";

/** The parts of `navigator` the check reads, so tests can pass plain objects. */
export type NavigatorLike = {
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean } | null;
};

/**
 * The phone or tablet platform, or null on a desktop browser.
 *
 * iPadOS Safari reports a Mac user agent, so a "Macintosh" with a touch screen
 * counts as iOS. Chromium's `userAgentData.mobile` covers phones whose user
 * agent string was reduced. This says nothing about QoreX: callers check
 * `window.qorex` first, so the QoreX in-app browser never reaches it.
 */
export function mobilePlatform(nav: NavigatorLike | undefined | null): MobilePlatform | null {
  if (!nav) return null;
  const agent = nav.userAgent ?? "";
  if (/Android/i.test(agent)) return "android";
  if (/iPhone|iPad|iPod/i.test(agent)) return "ios";
  if (/Macintosh/i.test(agent) && (nav.maxTouchPoints ?? 0) > 1) return "ios";
  if (nav.userAgentData?.mobile === true || /Mobi/i.test(agent)) return "other";
  return null;
}

/** The current browser's platform; null on the server and on desktops. */
export function currentMobilePlatform(): MobilePlatform | null {
  if (typeof navigator === "undefined") return null;
  return mobilePlatform(navigator as NavigatorLike);
}

/** The store links worth showing: the visitor's own store, or both when unknown. */
export function qorexStoreLinks(platform: MobilePlatform) {
  const appStore = { id: "app-store", label: "App Store", href: QOREX_APP_STORE_URL } as const;
  const playStore = { id: "google-play", label: "Google Play", href: QOREX_PLAY_STORE_URL } as const;
  if (platform === "ios") return [appStore];
  if (platform === "android") return [playStore];
  return [appStore, playStore];
}

/** The address to paste into the dApp browser: this page without its hash. */
export function pageAddressForQoreX(location: Pick<Location, "origin" | "pathname" | "search">) {
  return `${location.origin}${location.pathname}${location.search}`;
}

/** QoreX's link that opens a page in the QoreX app's dApp browser. */
export const QOREX_BROWSE_LINK = "https://link.qore.network/browse";

/**
 * The link that opens `pageAddress` in the QoreX app, or null when the address
 * is not an https page: the dApp browser only connects https sites
 * (docs.qorechain.io/qorex/dapp-browser), so a local http page gets the
 * copy-and-paste route instead.
 */
export function qorexBrowseLink(pageAddress: string): string | null {
  let page: URL;
  try {
    page = new URL(pageAddress);
  } catch {
    return null;
  }
  if (page.protocol !== "https:") return null;
  return `${QOREX_BROWSE_LINK}?url=${encodeURIComponent(page.href)}`;
}

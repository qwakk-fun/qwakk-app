/**
 * Phone browsers cannot run the QoreX extension, so a visitor on Chrome or
 * Safari for mobile has no `window.qorex`. The QoreX mobile app has an in-app
 * dApp browser that injects the same `window.qorex` provider
 * (docs.qorechain.io/qorex/dapp-browser), so the way in is to open Qwakk there.
 *
 * There is no documented deep link that opens a URL in the dApp browser. The
 * documented `qorex://` hosts are `auth-callback`, `connect?session=`,
 * `tx?request=` and `link?code=` (docs.qorechain.io/qorex/dapp-browser,
 * platform notes; docs.qorechain.io/dashboard/wallet), all tied to QoreChain
 * Dashboard sessions. Qwakk therefore links to the stores and lets the visitor
 * copy the page address instead of guessing a link format.
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

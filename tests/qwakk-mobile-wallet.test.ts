import assert from "node:assert/strict";
import test from "node:test";

import {
  QOREX_APP_STORE_URL,
  QOREX_BROWSE_LINK,
  QOREX_PLAY_STORE_URL,
  mobilePlatform,
  pageAddressForQoreX,
  qorexBrowseLink,
  qorexStoreLinks,
} from "../lib/qwakk-mobile-wallet";
import { QOREX_MAINNET_NETWORK_COPY, QOREX_MOBILE_NETWORK_COPY, QOREX_NETWORK_COPY, qorexNetworkCopy } from "../lib/qwakk-tx-copy";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

test("phone browsers are told apart from desktops", () => {
  assert.equal(mobilePlatform({ userAgent: IPHONE }), "ios");
  assert.equal(mobilePlatform({ userAgent: ANDROID }), "android");
  // iPadOS Safari sends a Mac user agent; the touch screen gives it away.
  assert.equal(mobilePlatform({ userAgent: MAC, maxTouchPoints: 5 }), "ios");
  assert.equal(mobilePlatform({ userAgent: MAC, maxTouchPoints: 0 }), null);
  assert.equal(mobilePlatform({ userAgent: WINDOWS }), null);
  assert.equal(mobilePlatform({ userAgent: WINDOWS, userAgentData: { mobile: true } }), "other");
  assert.equal(mobilePlatform({ userAgent: "Mozilla/5.0 (Mobile; rv:120.0) Gecko/120.0 Firefox/120.0" }), "other");
  assert.equal(mobilePlatform(undefined), null);
});

test("each platform gets its own store, unknown phones get both", () => {
  assert.deepEqual(qorexStoreLinks("ios").map((link) => link.href), [QOREX_APP_STORE_URL]);
  assert.deepEqual(qorexStoreLinks("android").map((link) => link.href), [QOREX_PLAY_STORE_URL]);
  assert.deepEqual(qorexStoreLinks("other").map((link) => link.href), [QOREX_APP_STORE_URL, QOREX_PLAY_STORE_URL]);
});

test("the address to paste keeps the path and query, not the hash", () => {
  assert.equal(pageAddressForQoreX({ origin: "https://app.qwakk.fun", pathname: "/swap", search: "?pool=1" }), "https://app.qwakk.fun/swap?pool=1");
});

test("the QoreX browse link carries the whole page address, encoded, and only for https pages", () => {
  assert.equal(QOREX_BROWSE_LINK, "https://link.qore.network/browse");
  const page = "https://app.qwakk.fun/swap?from=QOR&to=uqwakk";
  const link = qorexBrowseLink(page);
  assert.equal(link, "https://link.qore.network/browse?url=https%3A%2F%2Fapp.qwakk.fun%2Fswap%3Ffrom%3DQOR%26to%3Duqwakk");
  // The page address comes back out unchanged, path and query included.
  assert.equal(new URL(link!).searchParams.get("url"), page);
  assert.equal(new URL(link!).searchParams.size, 1);
  assert.equal(qorexBrowseLink(pageAddressForQoreX({ origin: "https://app.qwakk.fun", pathname: "/pools/7", search: "" })), "https://link.qore.network/browse?url=https%3A%2F%2Fapp.qwakk.fun%2Fpools%2F7");
  // The dApp browser only connects https sites; a local dev page gets the copy route.
  assert.equal(qorexBrowseLink("http://localhost:3000/swap"), null);
  assert.equal(qorexBrowseLink("javascript:alert(1)"), null);
  assert.equal(qorexBrowseLink(""), null);
});

test("the wrong-network hint matches the QoreX the visitor is using", () => {
  assert.equal(qorexNetworkCopy({ id: "testnet" }, false), QOREX_NETWORK_COPY);
  assert.equal(qorexNetworkCopy({ id: "testnet" }, true), QOREX_MOBILE_NETWORK_COPY);
  assert.equal(qorexNetworkCopy({ id: "mainnet" }, true), QOREX_MAINNET_NETWORK_COPY);
  assert.equal(qorexNetworkCopy({ id: "mainnet" }, false), QOREX_MAINNET_NETWORK_COPY);
});

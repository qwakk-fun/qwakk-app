import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the live board", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>[^<|]+ \| Simple swaps on QoreChain<\/title>/i);
  assert.match(html, /Simple swaps/);
  assert.match(html, /Trending/);
  assert.match(html, /Live trades/);
  assert.match(html, /Top traders/);
  assert.match(html, /Non-custodial/);
  assert.match(html, /href="\/swap"/);
  assert.match(html, /href="\/pools"/);
  assert.doesNotMatch(html, /codex-preview|Building your site|Starter Project/i);
});

test("keeps the retired Sites preview out of the Qwakk application", async () => {
  const [page, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<Board \/>/);
  assert.match(layout, /BRAND\.tagline/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/i);
  assert.doesNotMatch(layout, /SkeletonPreview|codex-preview/i);

  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../public/_sites-preview", import.meta.url)));
});

test("server-renders the QoreChain Diana quote workspace", async () => {
  const response = await render("/swap");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /QoreChain Diana pools/);
  assert.match(html, /Checking QoreChain Diana/);
  assert.match(html, /Price protection/);
  assert.match(html, /Interface fee/);
  assert.match(html, /QOR price in USD/);
  // No wallet action is rendered until native signing works end to end.
  assert.doesNotMatch(html, /Connect wallet to continue|Review live quote|Waiting for first pool|Review swap|Confirm in QoreX/);
});

test("server-renders markets without unavailable pool actions", async () => {
  const response = await render("/pools");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Every native AMM pool on QoreChain Diana/);
  assert.match(html, /Open pools/);
  assert.doesNotMatch(html, /Create a Native AMM pool|Prepare pool|MsgCreatePool|Most active|New pool|Create pool/);
});

test("server-renders the fees page with the interface fee cap", async () => {
  const response = await render("/fees");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Never more than (<!-- -->)?0\.30%/);
  assert.match(html, /Interface fee/);
  assert.match(html, /Pool fee/);
  assert.match(html, /Price protection is not a fee/);
  assert.doesNotMatch(html, /\u2014/);
});

test("server-renders the read-only Pond Vault page", async () => {
  const response = await render("/vault");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /The Pond Vault/);
  assert.match(html, /ML-DSA-87/);
  assert.match(html, /<title>Pond Vault \| /);
  // Read only: no wallet prompt, no signing or sending control.
  assert.doesNotMatch(html, /Connect wallet to continue|Confirm in QoreX|Sign approval|<button[^>]*>\s*(Withdraw|Execute|Approve)/i);
  assert.doesNotMatch(html, /\u2014/);
});

test("points share previews at the public site, not localhost", async () => {
  const html = await (await render()).text();
  assert.match(html, /property="og:image" content="https:\/\/qwakk\.fun\/og\.png"/);
  assert.doesNotMatch(html, /localhost:3000/);
});

for (const [path, heading] of [["/terms", "Terms of Use"], ["/privacy", "Privacy Policy"], ["/risk", "Risk Disclosure"]]) {
  test(`server-renders ${path}`, async () => {
    const response = await render(path);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`<h1>${heading}</h1>`));
    assert.match(html, /Last updated/);
    assert.doesNotMatch(html, /\u2014/);
  });
}

test("keeps the points pages and nav item hidden while points are off", async () => {
  const previous = process.env.QWAKK_POINTS_ENABLED;
  delete process.env.QWAKK_POINTS_ENABLED;
  try {
    assert.equal((await render("/points")).status, 404);
    assert.equal((await render(`/points/qor1${"a".repeat(38)}`)).status, 404);
    // The nav item waits for /api/features, so it is never in the server HTML.
    assert.doesNotMatch(await (await render()).text(), /href="\/points"/);
  } finally {
    if (previous === undefined) delete process.env.QWAKK_POINTS_ENABLED;
    else process.env.QWAKK_POINTS_ENABLED = previous;
  }
});

test("server-renders the points pages when points are on", async () => {
  const previous = process.env.QWAKK_POINTS_ENABLED;
  process.env.QWAKK_POINTS_ENABLED = "enabled";
  try {
    const board = await render("/points");
    assert.equal(board.status, 200);
    const html = await board.text();
    assert.match(html, /<title>Points \| [^<]+<\/title>/);
    assert.match(html, /Leaderboard/);
    assert.match(html, /Bragging rights only/);
    assert.match(html, /Points have no monetary value, are not a token/);
    assert.match(html, /How points work/);
    assert.match(html, /Are points worth anything\?/);
    assert.match(html, /Counting points/);
    assert.match(html, /Look up a wallet/);
    // No trade button before the features check confirms trading is on.
    assert.doesNotMatch(html, /Start trading/);
    assert.doesNotMatch(html, /—/);

    const address = `qor1${"a".repeat(38)}`;
    const wallet = await render(`/points/${address}`);
    assert.equal(wallet.status, 200);
    const walletHtml = await wallet.text();
    assert.match(walletHtml, /<title>Points for qor1aaaaa…aaaaaa \| [^<]+<\/title>/);
    assert.match(walletHtml, /Counting this wallet/);
    assert.match(walletHtml, /Back to leaderboard/);

    const invalid = await (await render("/points/not-an-address")).text();
    assert.match(invalid, /That is not a QoreChain address/);
    assert.doesNotMatch(invalid, /—/);
  } finally {
    if (previous === undefined) delete process.env.QWAKK_POINTS_ENABLED;
    else process.env.QWAKK_POINTS_ENABLED = previous;
  }
});

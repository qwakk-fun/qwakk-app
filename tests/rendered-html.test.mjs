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

test("server-renders the Qora Diana landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Qora \| Simple swaps on QoreChain<\/title>/i);
  assert.match(html, /QORECHAIN DIANA/);
  assert.match(html, /Simple swaps/);
  assert.match(html, /Non-custodial/);
  assert.match(html, /href="\/swap"/);
  assert.match(html, /href="\/pools"/);
  assert.doesNotMatch(html, /codex-preview|Building your site|Starter Project/i);
});

test("keeps the retired Sites preview out of the Qora application", async () => {
  const [page, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /QORECHAIN DIANA/);
  assert.match(page, /non-custodial/i);
  assert.match(layout, /Qora \| Simple swaps on QoreChain/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/i);
  assert.doesNotMatch(layout, /SkeletonPreview|codex-preview/i);

  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../public/_sites-preview", import.meta.url)));
});

test("server-renders the QoreChain Diana quote workspace", async () => {
  const response = await render("/swap");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Pick a pool on QoreChain Diana/);
  assert.match(html, /Checking QoreChain Diana/);
  assert.match(html, /Slippage/);
  assert.match(html, /Qora fee/);
  assert.match(html, /Quote engine is connected/);
  // No wallet action is rendered until native signing works end to end.
  assert.doesNotMatch(html, /Connect wallet to continue|Review live quote|Waiting for first pool/);
});

test("server-renders markets without unavailable pool actions", async () => {
  const response = await render("/pools");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Explore every pool/);
  assert.match(html, /On-chain data/);
  assert.doesNotMatch(html, /Create a Native AMM pool|Prepare pool|MsgCreatePool|Most active/);
});

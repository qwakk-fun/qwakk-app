import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { parseNativeActionSwitches } from "../lib/features";
import { ASSETS_BY_NETWORK, assetForDenom, createPoolTokenOptions, setAssetNetwork } from "../lib/qwakk-assets";
import { chainIdFromRestNodeInfo, chainIdFromRpcStatus, compareChainIds, heightFromRpcStatus } from "../lib/qwakk-chain-guard";
import { isQoreAccountAddress, resolveQwakkFeeConfig } from "../lib/qwakk-fee-config";
import { evaluateHealth, indexerHealthInput, indexerHeight } from "../lib/qwakk-health";
import { isBlocked, parseNativeBlocklist } from "../lib/qwakk-native-guards";
import { QWAKK_NETWORK_PRESETS, explorerTxUrl, publicNetwork, requiresChainQuote, resolveQwakkNetwork } from "../lib/qwakk-network";
import { QOREX_MAINNET_NETWORK_COPY, QOREX_NETWORK_COPY, SIMULATION_FAILURE_COPY, networkCopy, walletFailure } from "../lib/qwakk-tx-copy";
import { reconcileWalletAddress } from "../lib/qwakk-wallet-session";

/** Valid bech32 `qor1` addresses (20 bytes of 0x11 and 0x22). */
const TREASURY = "qor1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg34kqp8d";
const OTHER = "qor1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3z6t9806";

const FETH = "erc20:0x02292293c13880a26242690eb70a0e42B8E91c28";

// Network selection

test("defaults to QoreChain Diana with the documented public endpoints", () => {
  const { network, warnings } = resolveQwakkNetwork({});
  assert.deepEqual(warnings, []);
  assert.deepEqual(network, {
    id: "testnet",
    label: "QoreChain Diana",
    chainId: "qorechain-diana",
    restUrl: "https://api-testnet.qore.host",
    rpcUrl: "https://rpc-testnet.qore.host",
    evmRpcUrl: "https://evm-testnet.qore.host",
    evmChainId: 9800,
    explorerUrl: "https://explore.qore.network",
  });
});

test("QWAKK_NETWORK=mainnet points every value at qorechain-vladi", () => {
  const { network, warnings } = resolveQwakkNetwork({ QWAKK_NETWORK: "mainnet" });
  assert.deepEqual(warnings, []);
  assert.equal(network.chainId, "qorechain-vladi");
  assert.equal(network.restUrl, "https://api.qore.host");
  assert.equal(network.rpcUrl, "https://rpc.qore.host");
  assert.equal(network.evmRpcUrl, "https://evm.qore.host");
  assert.equal(network.evmChainId, 9801);
  assert.equal(network.label, "QoreChain");
  assert.deepEqual(publicNetwork(network), { id: "mainnet", label: "QoreChain", chainId: "qorechain-vladi" });
  assert.equal(resolveQwakkNetwork({ QWAKK_NETWORK: " MainNet " }).network.id, "mainnet");
});

test("an unknown QWAKK_NETWORK falls back to the testnet with a warning", () => {
  const { network, warnings } = resolveQwakkNetwork({ QWAKK_NETWORK: "mainet" });
  assert.equal(network.id, "testnet");
  assert.equal(warnings.length, 1);
});

test("endpoint overrides are honoured, but a leftover other-network endpoint is ignored", () => {
  const custom = resolveQwakkNetwork({ QWAKK_NETWORK: "mainnet", QORECHAIN_REST_URL: "https://my-node.example/rest/", QORECHAIN_RPC_URL: "not a url" });
  assert.equal(custom.network.restUrl, "https://my-node.example/rest");
  assert.equal(custom.network.rpcUrl, "https://rpc.qore.host");
  assert.equal(custom.warnings.length, 1);

  // docker-compose.yml and .env.example set the testnet URLs explicitly today.
  const leftover = resolveQwakkNetwork({
    QWAKK_NETWORK: "mainnet",
    QORECHAIN_REST_URL: "https://api-testnet.qore.host",
    QORECHAIN_RPC_URL: "https://rpc-testnet.qore.host/",
    QORECHAIN_EVM_RPC_URL: "https://evm-testnet.qore.host",
  });
  assert.equal(leftover.network.restUrl, "https://api.qore.host");
  assert.equal(leftover.network.rpcUrl, "https://rpc.qore.host");
  assert.equal(leftover.network.evmRpcUrl, "https://evm.qore.host");
  assert.equal(leftover.warnings.length, 3);

  // On the testnet the same explicit testnet URLs are simply the defaults.
  const testnet = resolveQwakkNetwork({ QORECHAIN_REST_URL: "https://api-testnet.qore.host" });
  assert.deepEqual(testnet.warnings, []);
  assert.equal(testnet.network.restUrl, "https://api-testnet.qore.host");
});

test("only mainnet requires QoreChain's own quote, and explorer links keep the fixed form", () => {
  assert.equal(requiresChainQuote(QWAKK_NETWORK_PRESETS.mainnet), true);
  assert.equal(requiresChainQuote(QWAKK_NETWORK_PRESETS.testnet), false);
  assert.equal(explorerTxUrl("AB12"), "https://explore.qore.network/tx/AB12");
});

test("the asset registry follows the network: mainnet lists only QOR", () => {
  assert.deepEqual(ASSETS_BY_NETWORK.mainnet.map((asset) => asset.denom), ["uqor"]);
  assert.equal(ASSETS_BY_NETWORK.testnet.length, 7);
  try {
    setAssetNetwork("mainnet");
    assert.equal(assetForDenom(FETH), undefined);
    assert.equal(assetForDenom("uqor")?.symbol, "QOR");
    assert.deepEqual(createPoolTokenOptions(null), ["uqor"]);
  } finally {
    setAssetNetwork("testnet");
  }
  assert.equal(assetForDenom(FETH)?.symbol, "fETH");
  assert.equal(createPoolTokenOptions(null).length, 7);
});

// Chain id guard

test("reads the chain id from RPC /status and REST node_info", () => {
  const status = { result: { node_info: { network: "qorechain-vladi" }, sync_info: { latest_block_height: "3951954" } } };
  assert.equal(chainIdFromRpcStatus(status), "qorechain-vladi");
  assert.equal(heightFromRpcStatus(status), "3951954");
  assert.equal(chainIdFromRestNodeInfo({ default_node_info: { network: "qorechain-diana" } }), "qorechain-diana");
  assert.equal(chainIdFromRpcStatus(null), null);
  assert.equal(chainIdFromRestNodeInfo({}), null);
});

test("matches only when both endpoints serve the configured chain", () => {
  assert.deepEqual(compareChainIds("qorechain-vladi", "qorechain-vladi", "qorechain-vladi", "5"), { state: "match", chainId: "qorechain-vladi", height: "5" });
  assert.equal(compareChainIds("qorechain-vladi", "qorechain-diana", "qorechain-vladi").state, "mismatch");
  assert.equal(compareChainIds("qorechain-vladi", "qorechain-vladi", "qorechain-diana").state, "mismatch");
  assert.equal(compareChainIds("qorechain-vladi", null, "qorechain-diana").state, "mismatch");
  assert.equal(compareChainIds("qorechain-vladi", "qorechain-vladi", null).state, "unreachable");
  assert.equal(compareChainIds("qorechain-vladi", null, null).state, "unreachable");
});

// Interface fee

test("the interface fee fails closed on a bad setting instead of falling back to 10 bps", () => {
  assert.deepEqual(resolveQwakkFeeConfig({ QWAKK_TREASURY_ADDRESS: TREASURY }).config, { enabled: true, recipient: TREASURY, feeBps: 10 });
  assert.deepEqual(resolveQwakkFeeConfig({ QWAKK_TREASURY_ADDRESS: TREASURY, QWAKK_SWAP_FEE_BPS: "30" }).config, { enabled: true, recipient: TREASURY, feeBps: 30 });

  for (const bad of ["31", "50", "abc", "-5", "1.5", "10bps"]) {
    const { config, warnings } = resolveQwakkFeeConfig({ QWAKK_TREASURY_ADDRESS: TREASURY, QWAKK_SWAP_FEE_BPS: bad });
    assert.equal(config.enabled, false, bad);
    assert.equal(warnings.length, 1, bad);
  }
  assert.equal(resolveQwakkFeeConfig({ QWAKK_TREASURY_ADDRESS: TREASURY, QWAKK_SWAP_FEE_BPS: "0" }).config.enabled, false);
});

test("an invalid treasury disables the fee, a missing one disables it quietly", () => {
  const missing = resolveQwakkFeeConfig({ QWAKK_SWAP_FEE_BPS: "10" });
  assert.equal(missing.config.enabled, false);
  assert.deepEqual(missing.warnings, []);
  // Right shape, wrong checksum: the last character changed.
  const badChecksum = `${TREASURY.slice(0, -1)}e`;
  for (const recipient of ["0xnotaqoraddress", "qor1treasuryaddress0000000000000", badChecksum, TREASURY.toUpperCase()]) {
    const { config, warnings } = resolveQwakkFeeConfig({ QWAKK_TREASURY_ADDRESS: recipient });
    assert.equal(config.enabled, false, recipient);
    assert.equal(warnings.length, 1, recipient);
  }
  assert.equal(isQoreAccountAddress(OTHER), true);
});

// Action switches

test("QWAKK_NATIVE_ACTIONS is off by default and enabled means every action", () => {
  for (const off of [undefined, "", "off", "false", "disabled"]) {
    assert.deepEqual(parseNativeActionSwitches(off).actions, { swap: false, add_liquidity: false, remove_liquidity: false, create_pool: false, rewards_claim: false });
  }
  for (const on of ["enabled", "true", "all", " Enabled "]) {
    // rewards_claim must be named; "enabled" (live on app.qwakk.fun) never opens it.
    assert.deepEqual(parseNativeActionSwitches(on).actions, { swap: true, add_liquidity: true, remove_liquidity: true, create_pool: true, rewards_claim: false });
  }
});

test("a comma list turns on only the named actions and ignores unknown ones", () => {
  assert.deepEqual(parseNativeActionSwitches("swap").actions, { swap: true, add_liquidity: false, remove_liquidity: false, create_pool: false, rewards_claim: false });
  assert.deepEqual(parseNativeActionSwitches("swap, liquidity").actions, { swap: true, add_liquidity: true, remove_liquidity: true, create_pool: false, rewards_claim: false });
  assert.deepEqual(parseNativeActionSwitches("remove_liquidity").actions, { swap: false, add_liquidity: false, remove_liquidity: true, create_pool: false, rewards_claim: false });
  const typo = parseNativeActionSwitches("swpa,create_pool");
  assert.deepEqual(typo.actions, { swap: false, add_liquidity: false, remove_liquidity: false, create_pool: true, rewards_claim: false });
  assert.equal(typo.warnings.length, 1);
  // "enabled" inside a list is not a wildcard.
  assert.equal(parseNativeActionSwitches("enabled,swap").actions.create_pool, false);
});

// Blocklist

test("the blocklist matches pool ids exactly and denoms without case", () => {
  const { blocklist, warnings } = parseNativeBlocklist({ QWAKK_BLOCKED_POOL_IDS: "3, 007,x", QWAKK_BLOCKED_DENOMS: `${FETH.toLowerCase()},ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2, ` });
  assert.equal(warnings.length, 1);
  assert.equal(isBlocked(blocklist, { poolId: "3", denoms: [] }), true);
  assert.equal(isBlocked(blocklist, { poolId: "7", denoms: [] }), true);
  assert.equal(isBlocked(blocklist, { poolId: "1", denoms: ["uqor"] }), false);
  assert.equal(isBlocked(blocklist, { poolId: "1", denoms: ["uqor", FETH] }), true);
  assert.equal(isBlocked(blocklist, { denoms: ["ibc/27394fb092d2eccd56123c74f36e4c1f926001ceada9ca97ea622b25f41e5eb2"] }), true);
  assert.equal(isBlocked(parseNativeBlocklist({}).blocklist, { poolId: "1", denoms: [FETH] }), false);
});

// Health

test("health is 503-worthy when the chain or indexer fails or the indexer lags", () => {
  const match = { state: "match" as const, chainId: "qorechain-diana", height: "1000" };
  assert.equal(evaluateHealth({ chain: match, indexer: { height: null } }).ok, true);
  assert.equal(evaluateHealth({ chain: match, indexer: { height: "900" } }).checks.indexer.lag, 100);
  assert.equal(evaluateHealth({ chain: match, indexer: { height: "300" } }).ok, false);
  assert.equal(evaluateHealth({ chain: match, indexer: { height: "300" }, maxIndexerLag: "1000" }).ok, true);
  assert.equal(evaluateHealth({ chain: match, indexer: null }).ok, false);
  assert.equal(evaluateHealth({ chain: { state: "mismatch", expected: "qorechain-vladi", rpc: "qorechain-diana", rest: null }, indexer: { height: null } }).ok, false);
  assert.equal(evaluateHealth({ chain: { state: "unreachable", expected: "qorechain-diana" }, indexer: { height: null } }).ok, false);
  assert.equal(indexerHeight({ ok: true }), null);
  assert.equal(indexerHeight({ ok: true, height: 42 }), "42");
  assert.equal(indexerHeight({ ok: true, lastHeight: "43" }), "43");
});

test("a starting or lagging indexer (503) is reachable, with its own status, height and lag", () => {
  const match = { state: "match" as const, chainId: "qorechain-diana", height: "1000" };
  const lagging = indexerHealthInput({ status: 503, data: { ok: false, status: "lagging", height: "200", chainHeight: "990", lag: 790, maxLag: 600 } });
  const report = evaluateHealth({ chain: match, indexer: lagging });
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.indexer, { ok: false, reachable: true, httpStatus: 503, status: "lagging", height: "200", lag: 800, reportedLag: 790, maxLag: 600 });

  const starting = evaluateHealth({ chain: match, indexer: indexerHealthInput({ status: 503, data: { ok: false, status: "starting", height: null, lag: null } }) });
  assert.equal(starting.checks.indexer.reachable, true);
  assert.equal(starting.checks.indexer.status, "starting");
  assert.equal(starting.checks.indexer.ok, false);

  // Chain height unknown: the indexer's own lag is used.
  const chainDown = evaluateHealth({ chain: { state: "unreachable", expected: "qorechain-diana" }, indexer: lagging });
  assert.equal(chainDown.checks.indexer.lag, 790);

  const healthy = evaluateHealth({ chain: match, indexer: indexerHealthInput({ status: 200, data: { ok: true, status: "ok", height: "998", lag: 2 } }) });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.checks.indexer.httpStatus, 200);
  assert.equal(healthy.checks.indexer.lag, 2);

  // No answer, or an error page that is not the indexer's own body, is unreachable.
  assert.equal(indexerHealthInput(null), null);
  assert.equal(indexerHealthInput({ status: 502, data: null }), null);
  assert.equal(indexerHealthInput({ status: 503, data: { status: "made-up" } }), null);
  const down = evaluateHealth({ chain: match, indexer: indexerHealthInput({ status: 502, data: null }) });
  assert.equal(down.checks.indexer.reachable, false);
  assert.equal(down.checks.indexer.httpStatus, null);
});

test("indexerRequest keeps an error body only when asked", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ ok: false, status: "lagging", height: "5" }, { status: 503 })) as typeof fetch;
  try {
    const { indexerRequest, indexerRead } = await import("../lib/qwakk-market");
    assert.deepEqual(await indexerRequest("/health"), { status: 503, data: null });
    assert.deepEqual(await indexerRequest("/health", { errorBody: true }), { status: 503, data: { ok: false, status: "lagging", height: "5" } });
    assert.equal(await indexerRead("/health"), null);
    globalThis.fetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch;
    assert.equal(await indexerRequest("/health", { errorBody: true }), null);
    globalThis.fetch = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch;
    assert.deepEqual(await indexerRequest("/health", { errorBody: true }), { status: 502, data: null });
  } finally {
    globalThis.fetch = original;
  }
});

test("the probe and prepare routes put every guard line through the network copy", () => {
  for (const route of ["app/api/native-tx/probe/route.ts", "app/api/native-tx/prepare/route.ts"]) {
    const source = readFileSync(join(import.meta.dirname, "..", route), "utf8");
    const uses = source.match(/[\w(]*PREPARE_GUARD_COPY[.[]/g) ?? [];
    for (const use of uses) assert.match(use, /^(networkCopy\(|copy\()/, `${route}: ${use}`);
  }
});

// Wallet sync and copy

test("a QoreX account switch is detected before signing", () => {
  assert.equal(reconcileWalletAddress("", TREASURY), "connected");
  assert.equal(reconcileWalletAddress(null, TREASURY), "connected");
  assert.equal(reconcileWalletAddress(TREASURY, TREASURY), "same");
  assert.equal(reconcileWalletAddress(` ${TREASURY.toUpperCase()} `, TREASURY), "same");
  assert.equal(reconcileWalletAddress(TREASURY, OTHER), "switched");
});

test("copy names the configured network and the right QoreX setting", () => {
  const mainnet = { id: "mainnet" as const, label: "QoreChain" };
  const testnet = { id: "testnet" as const, label: "QoreChain Diana" };
  assert.equal(networkCopy(SIMULATION_FAILURE_COPY.pool_not_found, mainnet), "This pool is not available on QoreChain.");
  assert.equal(networkCopy(SIMULATION_FAILURE_COPY.pool_not_found, testnet), SIMULATION_FAILURE_COPY.pool_not_found);
  assert.equal(networkCopy(SIMULATION_FAILURE_COPY.pool_not_found), SIMULATION_FAILURE_COPY.pool_not_found);
  const wrongNetwork = new Error("QoreX: chain qorechain-vladi does not match the active network qorechain-diana");
  assert.equal(walletFailure(wrongNetwork, mainnet).copy, QOREX_MAINNET_NETWORK_COPY);
  assert.equal(walletFailure(wrongNetwork, testnet).copy, QOREX_NETWORK_COPY);
  assert.equal(walletFailure(wrongNetwork).copy, QOREX_NETWORK_COPY);
  assert.doesNotMatch(walletFailure(new Error("Transaction failed on-chain (code 5)."), mainnet).copy, /Diana/);
  for (const text of [QOREX_MAINNET_NETWORK_COPY, networkCopy(SIMULATION_FAILURE_COPY.impact_too_high, mainnet)]) assert.doesNotMatch(text, /—/);
});

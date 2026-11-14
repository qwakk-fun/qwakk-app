import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { encodeAbiParameters, encodeFunctionData, formatUnits, toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction } from "viem";
import { POND_VAULT_ABI } from "../src/abi.ts";
import { POND_VAULT_SELECTORS, POND_VAULT_TOPICS, decodeAction, encodeCall, formatBaseUnits, displayAmount } from "../../../lib/qwakk-vault-abi.ts";

const artifactUrl = new URL("../../out/PondVault.sol/PondVault.json", import.meta.url);

test("CLI ABI matches the Foundry artifact (run forge build first)", { skip: !existsSync(artifactUrl) && "no forge build output" }, () => {
  const artifact = JSON.parse(readFileSync(artifactUrl, "utf8")) as { methodIdentifiers: Record<string, string>; abi: (AbiFunction | AbiEvent)[] };
  const onChain = new Set(Object.values(artifact.methodIdentifiers).map((s) => `0x${s}`));
  for (const item of POND_VAULT_ABI) {
    if (item.type !== "function") continue;
    assert.ok(onChain.has(toFunctionSelector(item)), `${item.name} is not in the compiled contract`);
  }
  const events = new Set(artifact.abi.filter((x): x is AbiEvent => x.type === "event").map((e) => toEventSelector(e)));
  for (const item of POND_VAULT_ABI) {
    if (item.type !== "event") continue;
    assert.ok(events.has(toEventSelector(item)), `event ${item.name} differs from the compiled contract`);
  }
});

test("the app's hand-written selectors match the ABI", () => {
  for (const [signature, selector] of Object.entries(POND_VAULT_SELECTORS)) {
    assert.equal(selector, toFunctionSelector(signature), signature);
  }
});

test("the app's hand-written event topics match", () => {
  for (const [signature, topic] of Object.entries(POND_VAULT_TOPICS)) {
    assert.equal(topic, toEventSelector(signature), signature);
  }
});

test("the app's decoder reads getAction exactly as viem does", () => {
  const id = encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "uint8" }, { type: "uint8" }, { type: "uint64" }, { type: "uint64" }, { type: "address" }, { type: "address" }, { type: "uint256" }] }],
    [[1, 1, 3n, 1_900_000_000n, "0x97143B771D34ddb9130b807b135Ae675A5a963CA", "0x2222222222222222222222222222222222222222", 250_000_000n]],
  );
  assert.deepEqual(decodeAction(id), {
    action: "Withdraw",
    status: "queued",
    nonce: 3n,
    eta: 1_900_000_000n,
    token: "0x97143b771d34ddb9130b807b135ae675a5a963ca",
    to: "0x2222222222222222222222222222222222222222",
    amount: 250_000_000n,
  });
  assert.equal(encodeCall("getAction(uint256)", 5n), encodeFunctionData({ abi: POND_VAULT_ABI, functionName: "getAction", args: [5n] }));
  assert.equal(
    encodeCall("dailyCap(address)", "0x97143B771D34ddb9130b807b135Ae675A5a963CA"),
    encodeFunctionData({ abi: POND_VAULT_ABI, functionName: "dailyCap", args: ["0x97143B771D34ddb9130b807b135Ae675A5a963CA"] }),
  );
});

test("the app formats base units like viem, with integer math", () => {
  for (const [value, decimals] of [[0n, 18], [1n, 18], [10n ** 18n, 18], [1_234_567_890n, 6], [123n, 0], [10n ** 30n + 5n, 18]] as const) {
    const ours = formatBaseUnits(value, decimals, decimals);
    assert.equal(ours.replace(/,/g, ""), formatUnits(value, decimals), `${value}/${decimals}`);
  }
  assert.equal(formatBaseUnits(1_234_567_890_123n, 6), "1,234,567.890123");
  assert.equal(displayAmount(1n, 18), "<0.000001");
  assert.equal(displayAmount(0n, 18), "0");
});

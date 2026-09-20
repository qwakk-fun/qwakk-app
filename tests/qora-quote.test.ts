import assert from "node:assert/strict";
import test from "node:test";

import { buildExactInQuoteRequest, calculateMinimumOut } from "../lib/qora-quote";

test("subtracts the configured interface fee before requesting an AMM quote", () => {
  const quote = buildExactInQuoteRequest({
    poolId: "7",
    denomIn: "uqor",
    amountIn: "1000000",
    slippageBps: 50,
    fee: { enabled: true, recipient: "qor1exampleaddress000000000000", feeBps: 5 },
  });

  assert.equal(quote.interfaceFee, "500");
  assert.equal(quote.swapAmountIn, "999500");
  assert.equal(quote.totalAmountIn, "1000000");
});

test("uses the full input when the interface fee is not configured", () => {
  const quote = buildExactInQuoteRequest({
    poolId: "1",
    denomIn: "ibc/ABC123",
    amountIn: "2500000",
    fee: { enabled: false, feeBps: 5 },
  });

  assert.equal(quote.interfaceFee, "0");
  assert.equal(quote.swapAmountIn, "2500000");
  assert.equal(quote.interfaceFeeEnabled, false);
});

test("calculates minimum output entirely with integer arithmetic", () => {
  assert.equal(calculateMinimumOut("1234567", 50), "1228394");
});

test("rejects invalid quote inputs", () => {
  assert.throws(
    () => buildExactInQuoteRequest({
      poolId: "0",
      denomIn: "uqor",
      amountIn: "100",
      fee: { enabled: false, feeBps: 5 },
    }),
    /valid pool ID/,
  );
  assert.throws(() => calculateMinimumOut("100", 501), /Slippage/);
});

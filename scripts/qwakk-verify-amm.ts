/**
 * Qwakk launch-day AMM verifier. Keyless and read-only: it never signs and
 * never broadcasts. It needs no mnemonic, no private key and no wallet.
 *
 * It checks Qwakk's swap quote, add-liquidity and remove-liquidity math, and
 * the exact messages Qwakk builds, against QoreChain Diana's own keeper:
 *
 *   1. QoreChain's `QuoteExactIn` against Qwakk's local x*y=k math.
 *   2. Keyless `/cosmos/tx/v1beta1/simulate` runs (a 64 zero-byte stand-in
 *      signature; simulation skips signature checks and commits nothing), read
 *      back through the keeper's `amm_swap`, `amm_liquidity_added` and
 *      `amm_liquidity_removed` events.
 *   3. The interface fee MsgSend and MsgSwapExactIn together in one
 *      transaction, as Qwakk sends them. The same for exact-out swaps:
 *      QoreChain's `QuoteExactOut` against local math, then the fee MsgSend
 *      and MsgSwapExactOut in one transaction, and that `maxIn` is enforced.
 *   4. That minOut, minLpOut and the withdrawal minimums are enforced, the
 *      5% impact cap, and duplicate pool detection.
 *
 * How to run (from qwakk-app/):
 *
 *   npm run verify:amm -- --pool 1 --address qor1yourwallet...
 *
 * Options:
 *   --pool <id>            Pool to check (required).
 *   --address <qor1...>    Any Diana address with an account (required). It only
 *                          sets the simulated sender: use a wallet that holds
 *                          both pool tokens and some QOR so the simulations get
 *                          past the bank step. Checks it cannot fund are SKIP.
 *   --amount-in <base>     Swap input per direction, in base units (default:
 *                          0.5% of the input reserve, capped at half the balance).
 *   --amount-out <base>    Exact-out output per direction, in base units
 *                          (default: 0.25% of the output reserve).
 *   --fee-bps <n>          Interface fee to model, 0 to 30 (default: 10).
 *   --treasury <qor1...>   Fee recipient (default: QWAKK_TREASURY_ADDRESS, else
 *                          the address itself, which simulates the same shape).
 *
 * Endpoints follow QORECHAIN_REST_URL (default https://api-testnet.qore.host).
 * The exit code is 1 when any check FAILs. Paste the table into the launch
 * notes: it is the evidence for turning QWAKK_NATIVE_ACTIONS on.
 */

import { amm, qorechainRegistry, type EncodeObject } from "@qorechain/sdk";

import { QORECHAIN_REST_URL } from "../lib/qorechain-endpoints";
import { readAmmParams, readAmmPool, readAmmPoolByDenoms, readBalances, readLpBalance, readQuoteExactIn, readQuoteExactOut, type AmmPool } from "../lib/qwakk-amm-chain";
import { ceilDiv, constantProductIn, constantProductOut, maxSwapInForImpact, priceImpactBps } from "../lib/qwakk-amm-math";
import { applySlippage, expectedLpForDeposit, expectedWithdrawal, matchingDeposit } from "../lib/qwakk-liquidity-math";
import { encodedMessagesForAction } from "../lib/qwakk-native-actions";
import {
  buildSimulationTx,
  bytesToBase64,
  classifySimulationError,
  encodeAsAny,
  eventAttributes,
  gasLimitForSimulatedGas,
  parseSimulationEvents,
  readAccountSequence,
  simulatedOutcome,
  type ChainEvent,
} from "../lib/qwakk-native-tx";
import { buildExactInQuoteRequest, buildExactOutQuoteRequest, buildExactOutSwapQuote, buildSwapQuote } from "../lib/qwakk-quote";
import { MAX_QWAKK_INTERFACE_FEE_BPS } from "../lib/qwakk-swap-route";

type Status = "PASS" | "WARN" | "FAIL" | "SKIP" | "INFO";
const rows: Array<{ check: string; status: Status; detail: string }> = [];
const record = (check: string, status: Status, detail: string) => rows.push({ check, status, detail });

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

type Simulation = { ok: true; gasUsed: bigint; events: ChainEvent[] } | { ok: false; message: string };

let sequence = BigInt(0);

/** Keyless simulation. Raw chain text is fine here: this is an owner-run terminal tool. */
async function simulate(messages: EncodeObject[]): Promise<Simulation> {
  const tx = buildSimulationTx(encodeAsAny(messages), sequence);
  const response = await fetch(`${QORECHAIN_REST_URL}/cosmos/tx/v1beta1/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ tx_bytes: bytesToBase64(tx) }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null) as { gas_info?: { gas_used?: string }; message?: string } | null;
  if (response.ok && /^\d+$/.test(body?.gas_info?.gas_used ?? "")) return { ok: true, gasUsed: BigInt(body?.gas_info?.gas_used as string), events: parseSimulationEvents(body) };
  return { ok: false, message: String(body?.message ?? `HTTP ${response.status}`).replace(/\s*\[[^\]]*\]/g, "").replace(/ with gas used: '\d+'/, "") };
}

function short(text: string, length = 110) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function lacksFunds(simulation: Simulation) {
  return !simulation.ok && classifySimulationError(simulation.message) === "insufficient_funds";
}

function diffStatus(actual: bigint, expected: bigint): Status {
  const diff = actual > expected ? actual - expected : expected - actual;
  return diff === BigInt(0) ? "PASS" : diff <= BigInt(1) ? "WARN" : "FAIL";
}

function gasNote(label: string, simulation: Simulation) {
  if (simulation.ok) record(`gas: ${label}`, "INFO", `simulated ${simulation.gasUsed}, Qwakk would ask QoreX for ${gasLimitForSimulatedGas(simulation.gasUsed)}`);
}

async function checkSwapDirection(pool: AmmPool, address: string, balances: Map<string, bigint>, forward: boolean, fee: { enabled: true; recipient: string; feeBps: number }, amountArg: string | undefined) {
  const params = await readAmmParams();
  const denomIn = forward ? pool.tokenA : pool.tokenB;
  const denomOut = forward ? pool.tokenB : pool.tokenA;
  const reserveIn = BigInt(forward ? pool.reserveA : pool.reserveB);
  const reserveOut = BigInt(forward ? pool.reserveB : pool.reserveA);
  const label = `${denomIn}->${denomOut}`;
  const held = balances.get(denomIn) ?? BigInt(0);
  let total = amountArg ? BigInt(amountArg) : reserveIn / BigInt(200);
  if (!amountArg && held > BigInt(0) && held / BigInt(2) < total) total = held / BigInt(2);
  if (total <= BigInt(0)) total = BigInt(1_000);

  const request = buildExactInQuoteRequest({ poolId: pool.id, denomIn, amountIn: total.toString(), slippageBps: 50, fee });
  const swapIn = BigInt(request.swapAmountIn);
  record(`swap ${label}: input split`, "INFO", `total ${total}, interface fee ${request.interfaceFee} (${fee.feeBps} bps, rounded down), to AMM ${swapIn}`);

  const chain = await readQuoteExactIn(pool.id, denomIn, request.swapAmountIn);
  const local = constantProductOut(swapIn, reserveIn, reserveOut, params.swapFeeBps);
  if (!chain.ok) {
    record(`swap ${label}: QuoteExactIn`, "FAIL", `quote refused (${chain.failure})`);
    return;
  }
  record(`swap ${label}: QuoteExactIn vs local x*y=k`, diffStatus(BigInt(chain.amountOut), BigInt(local.amountOut)), `chain ${chain.amountOut}, local ${local.amountOut}`);
  const feeCeil = ceilDiv(swapIn * BigInt(params.swapFeeBps), BigInt(10_000));
  const feeFloor = (swapIn * BigInt(params.swapFeeBps)) / BigInt(10_000);
  const feeValue = BigInt(chain.fee);
  record(`swap ${label}: quote fee`, feeValue === feeCeil || feeValue === feeFloor ? "PASS" : "FAIL", `chain ${chain.fee} ${denomIn}; ${params.swapFeeBps} bps of input is ${feeFloor} (floor) / ${feeCeil} (ceil)${feeValue === feeCeil && feeCeil !== feeFloor ? ", chain rounds up" : feeValue === feeFloor && feeCeil !== feeFloor ? ", chain rounds down" : ""}`);

  const quote = buildSwapQuote({ request, pool, params, chain });
  record(`swap ${label}: Qwakk quote`, quote.blocked ? "WARN" : "PASS", `minOut ${quote.minOut} at 0.50%, impact ${quote.priceImpactBps ?? "n/a"} bps${quote.blocked ? `, blocked: ${quote.blocked}` : ""}`);
  if (quote.blocked) return;

  const swapAlone = amm.swapExactIn({ sender: address, poolId: pool.id, tokenIn: { denom: denomIn, amount: request.swapAmountIn }, denomOut, minOut: quote.minOut });
  const alone = await simulate([swapAlone]);
  if (lacksFunds(alone)) {
    record(`swap ${label}: simulate`, "SKIP", `the address does not hold ${swapIn} ${denomIn}`);
    return;
  }
  if (!alone.ok) {
    record(`swap ${label}: simulate`, "FAIL", short(alone.message));
    return;
  }
  gasNote(`swap ${label}`, alone);
  const outcome = simulatedOutcome(alone.events);
  const event = eventAttributes(alone.events, "amm_swap");
  if (!outcome.swap || !event) {
    record(`swap ${label}: amm_swap event`, "FAIL", "simulation succeeded without a readable amm_swap event");
    return;
  }
  record(`swap ${label}: simulated amount_out vs QuoteExactIn`, outcome.swap.amountOut === chain.amountOut ? "PASS" : "FAIL", `event ${outcome.swap.amountOut}, quote ${chain.amountOut}`);
  record(`swap ${label}: simulated amount_out vs local`, diffStatus(BigInt(outcome.swap.amountOut), BigInt(local.amountOut)), `event ${outcome.swap.amountOut}, local ${local.amountOut}`);
  record(`swap ${label}: event amount_in`, outcome.swap.amountIn === request.swapAmountIn ? "PASS" : "FAIL", `event ${outcome.swap.amountIn}, sent ${request.swapAmountIn}`);
  record(`swap ${label}: event fee_bps`, event.get("fee_bps") === String(params.swapFeeBps) ? "PASS" : "WARN", `event ${event.get("fee_bps") ?? "missing"}, params ${params.swapFeeBps}`);
  record(`swap ${label}: event protocol_fee and reserves`, "INFO", `protocol_fee ${event.get("protocol_fee") ?? "missing"} (${params.protocolFeeBps} bps of input is ${(swapIn * BigInt(params.protocolFeeBps)) / BigInt(10_000)}), reserve_a ${event.get("reserve_a") ?? "?"}, reserve_b ${event.get("reserve_b") ?? "?"}; before ${pool.reserveA}/${pool.reserveB}`);
  const executedImpact = priceImpactBps(swapIn, BigInt(outcome.swap.amountOut), reserveIn, reserveOut);
  record(`swap ${label}: impact`, executedImpact === quote.priceImpactBps ? "PASS" : "WARN", `from event ${executedImpact} bps, quoted ${quote.priceImpactBps} bps`);

  const tooHigh = await simulate([amm.swapExactIn({ sender: address, poolId: pool.id, tokenIn: { denom: denomIn, amount: request.swapAmountIn }, denomOut, minOut: (BigInt(outcome.swap.amountOut) + BigInt(1)).toString() })]);
  const tooHighReason = tooHigh.ok ? "accepted" : classifySimulationError(tooHigh.message);
  record(`swap ${label}: minOut enforced`, tooHighReason === "price_moved" ? "PASS" : "FAIL", tooHigh.ok ? "a minOut 1 above the output was accepted" : `minOut + 1 refused as ${tooHighReason}: ${short(tooHigh.message, 70)}`);

  const combined = await simulate(encodedMessagesForActionAsEncodeObjects(address, { kind: "swap", poolId: pool.id, denomIn, amountIn: total.toString(), denomOut, minOut: quote.minOut }, fee));
  if (lacksFunds(combined)) {
    record(`swap ${label}: fee MsgSend + swap in one tx`, "SKIP", `the address does not hold ${total} ${denomIn}`);
    return;
  }
  if (!combined.ok) {
    record(`swap ${label}: fee MsgSend + swap in one tx`, "FAIL", short(combined.message));
    return;
  }
  gasNote(`fee + swap ${label}`, combined);
  const transfer = combined.events.find((candidate) => candidate.type === "transfer" && candidate.attributes.some((attribute) => attribute.key === "msg_index" && attribute.value === "0"));
  const sent = transfer ? new Map(transfer.attributes.map((attribute) => [attribute.key, attribute.value])) : null;
  const feeOk = sent?.get("recipient") === fee.recipient && sent?.get("amount") === `${request.interfaceFee}${denomIn}`;
  const combinedOut = simulatedOutcome(combined.events).swap?.amountOut;
  record(`swap ${label}: fee MsgSend + swap in one tx`, feeOk && combinedOut === outcome.swap.amountOut ? "PASS" : "FAIL", `fee transfer ${sent?.get("amount") ?? "missing"} to ${sent?.get("recipient") ?? "?"}, swap out ${combinedOut ?? "missing"}`);
}

/**
 * Exact out: QoreChain's QuoteExactOut against local x*y=k math, then keyless
 * simulations of MsgSwapExactOut alone, with `maxIn` one unit short, and with
 * the interface fee MsgSend in one transaction exactly as the prepare route
 * builds it.
 */
async function checkExactOutDirection(pool: AmmPool, address: string, forward: boolean, fee: { enabled: true; recipient: string; feeBps: number }, amountArg: string | undefined) {
  const params = await readAmmParams();
  if (pool.poolType !== "constant_product") {
    record("exact out", "SKIP", `${pool.poolType} pools have no exact-out quote`);
    return;
  }
  const denomIn = forward ? pool.tokenA : pool.tokenB;
  const denomOut = forward ? pool.tokenB : pool.tokenA;
  const reserveIn = BigInt(forward ? pool.reserveA : pool.reserveB);
  const reserveOut = BigInt(forward ? pool.reserveB : pool.reserveA);
  const label = `exact out ${denomIn}->${denomOut}`;
  let amountOut = amountArg ? BigInt(amountArg) : reserveOut / BigInt(400);
  if (amountOut <= BigInt(0)) amountOut = BigInt(1);

  const request = buildExactOutQuoteRequest({ poolId: pool.id, denomIn, amountOut: amountOut.toString(), slippageBps: 50, fee });
  const chain = await readQuoteExactOut(pool.id, denomOut, request.amountOut);
  if (!chain.ok) {
    record(`${label}: QuoteExactOut`, "FAIL", `quote refused (${chain.failure})`);
    return;
  }
  const local = constantProductIn(amountOut, reserveIn, reserveOut, params.swapFeeBps);
  record(`${label}: QuoteExactOut vs local x*y=k`, local ? diffStatus(BigInt(chain.amountIn), BigInt(local.amountIn)) : "FAIL", `out ${amountOut}: chain in ${chain.amountIn} fee ${chain.fee}, local in ${local?.amountIn ?? "none"} fee ${local?.fee ?? "none"}`);
  const quote = buildExactOutSwapQuote({ request, pool, params, chain });
  record(`${label}: Qwakk quote`, quote.blocked ? "WARN" : "PASS", `total ${quote.totalAmountIn} (interface fee ${quote.interfaceFee.amount}, AMM ${quote.swapAmountIn}), maxIn ${quote.maxIn}, most paid ${quote.maxTotalIn} at 0.50%${quote.blocked ? `, blocked: ${quote.blocked}` : ""}`);
  if (quote.blocked) return;
  const backIn = await readQuoteExactIn(pool.id, denomIn, quote.swapAmountIn);
  record(`${label}: QuoteExactIn of the quoted input`, backIn.ok && BigInt(backIn.amountOut) >= amountOut ? "PASS" : "FAIL", backIn.ok ? `exact in ${quote.swapAmountIn} gives ${backIn.amountOut}, wanted ${amountOut}` : `refused (${backIn.failure})`);

  const swapOut = (maxIn: string) => amm.swapExactOut({ sender: address, poolId: pool.id, denomIn, tokenOut: { denom: denomOut, amount: amountOut.toString() }, maxIn });
  const alone = await simulate([swapOut(quote.maxIn)]);
  if (lacksFunds(alone)) {
    record(`${label}: simulate`, "SKIP", `the address does not hold ${quote.maxIn} ${denomIn}`);
    return;
  }
  if (!alone.ok) {
    record(`${label}: simulate`, "FAIL", short(alone.message));
    return;
  }
  gasNote(label, alone);
  const outcome = simulatedOutcome(alone.events).swap;
  record(`${label}: amm_swap event`, outcome && outcome.amountOut === amountOut.toString() && outcome.amountIn === chain.amountIn && outcome.denomIn === denomIn && outcome.denomOut === denomOut ? "PASS" : "FAIL", outcome ? `event in ${outcome.amountIn} ${outcome.denomIn}, out ${outcome.amountOut} ${outcome.denomOut}; quote in ${chain.amountIn}` : "no readable amm_swap event");

  const short1 = await simulate([swapOut((BigInt(chain.amountIn) - BigInt(1)).toString())]);
  const shortReason = short1.ok ? "accepted" : classifySimulationError(short1.message);
  record(`${label}: maxIn enforced`, shortReason === "price_moved" ? "PASS" : short1.ok ? "FAIL" : "WARN", short1.ok ? "a maxIn 1 below the input was accepted" : `maxIn - 1 refused as ${shortReason}: ${short(short1.message, 70)}`);

  const combined = await simulate(encodedMessagesForActionAsEncodeObjects(address, { kind: "swap", mode: "exact_out", poolId: pool.id, denomIn, amountIn: quote.totalAmountIn, denomOut, amountOut: amountOut.toString(), maxIn: quote.maxIn }, fee));
  if (lacksFunds(combined)) {
    record(`${label}: fee MsgSend + MsgSwapExactOut in one tx`, "SKIP", `the address does not hold ${quote.maxTotalIn} ${denomIn}`);
    return;
  }
  if (!combined.ok) {
    record(`${label}: fee MsgSend + MsgSwapExactOut in one tx`, "FAIL", short(combined.message));
    return;
  }
  gasNote(`fee + ${label}`, combined);
  const transfer = combined.events.find((candidate) => candidate.type === "transfer" && candidate.attributes.some((attribute) => attribute.key === "msg_index" && attribute.value === "0"));
  const sent = transfer ? new Map(transfer.attributes.map((attribute) => [attribute.key, attribute.value])) : null;
  const feeOk = quote.interfaceFee.amount === "0" ? !transfer : sent?.get("recipient") === fee.recipient && sent?.get("amount") === `${quote.interfaceFee.amount}${denomIn}`;
  const combinedSwap = simulatedOutcome(combined.events).swap;
  record(`${label}: fee MsgSend + MsgSwapExactOut in one tx`, feeOk && combinedSwap?.amountOut === amountOut.toString() ? "PASS" : "FAIL", `fee transfer ${sent?.get("amount") ?? "none"} to ${sent?.get("recipient") ?? "?"}, swap in ${combinedSwap?.amountIn ?? "missing"} out ${combinedSwap?.amountOut ?? "missing"}`);
}

const registry = qorechainRegistry();

/** The app's own guarded builder (the one the prepare route uses), decoded back to EncodeObjects for simulation. */
function encodedMessagesForActionAsEncodeObjects(address: string, action: Parameters<typeof encodedMessagesForAction>[1], fee: Parameters<typeof encodedMessagesForAction>[2]): EncodeObject[] {
  return encodedMessagesForAction(address, action, fee).map((message) => ({ typeUrl: message.typeUrl, value: registry.decode(message) }));
}

async function checkImpactCap(pool: AmmPool, address: string) {
  const params = await readAmmParams();
  if (params.maxSwapImpactBps === 0) {
    record("impact cap", "INFO", "max_swap_impact_bps is 0 (no cap)");
    return;
  }
  const max = maxSwapInForImpact(pool.reserveA, pool.reserveB, params.maxSwapImpactBps, params.swapFeeBps);
  if (max === null || max <= BigInt(0)) {
    record("impact cap", "SKIP", "not a constant-product pool or no room under the cap");
    return;
  }
  const atMax = await readQuoteExactIn(pool.id, pool.tokenA, max.toString());
  record("impact cap: QuoteExactIn at Qwakk's maximum", atMax.ok ? "PASS" : "FAIL", `${max} ${pool.tokenA} (fee-inclusive impact <= ${params.maxSwapImpactBps} bps): ${atMax.ok ? `out ${atMax.amountOut}` : atMax.failure}`);
  const over = BigInt(pool.reserveA) / BigInt(5);
  const overQuote = await readQuoteExactIn(pool.id, pool.tokenA, over.toString());
  record("impact cap: does QuoteExactIn enforce it", "INFO", `20% of reserve in: ${overQuote.ok ? `quote answers (out ${overQuote.amountOut}), so the quote does not enforce the cap` : `quote refuses (${overQuote.failure})`}`);

  // Find where the chain's own quote starts refusing, if it enforces the cap.
  if (!overQuote.ok) {
    let low = max;
    let high = over;
    for (let step = 0; step < 40 && high - low > BigInt(1); step += 1) {
      const middle = (low + high) / BigInt(2);
      if ((await readQuoteExactIn(pool.id, pool.tokenA, middle.toString())).ok) low = middle; else high = middle;
    }
    const slack = ((low - max) * BigInt(10_000)) / low;
    record("impact cap: chain boundary", slack <= BigInt(200) ? "PASS" : "WARN", `chain quotes up to ${low}, Qwakk allows up to ${max} (Qwakk is stricter by ${slack} bps of size)`);
  }

  const simulated = await simulate([amm.swapExactIn({ sender: address, poolId: pool.id, tokenIn: { denom: pool.tokenA, amount: over.toString() }, denomOut: pool.tokenB, minOut: "1" })]);
  const reason = simulated.ok ? "accepted" : classifySimulationError(simulated.message);
  record("impact cap: simulated over-cap swap", reason === "impact_too_high" ? "PASS" : reason === "insufficient_funds" ? "SKIP" : "WARN", simulated.ok ? "an over-cap swap was ACCEPTED by the keeper" : `refused as ${reason}: ${short(simulated.message, 80)}`);
}

async function checkLiquidity(pool: AmmPool, address: string, balances: Map<string, bigint>, lpBalance: bigint) {
  const reserveA = BigInt(pool.reserveA);
  const reserveB = BigInt(pool.reserveB);
  const supply = BigInt(pool.lpSupply);
  const heldA = balances.get(pool.tokenA) ?? BigInt(0);
  let amountA = reserveA / BigInt(1_000);
  if (heldA / BigInt(4) < amountA) amountA = heldA / BigInt(4);
  const matched = amountA > BigInt(0) ? matchingDeposit(amountA.toString(), pool.reserveA, pool.reserveB) : null;
  if (!matched || BigInt(matched) === BigInt(0) || (balances.get(pool.tokenB) ?? BigInt(0)) < BigInt(matched)) {
    record("add liquidity", "SKIP", `the address needs ${pool.tokenA} and ${pool.tokenB} at the pool ratio`);
  } else {
    const amountB = matched;
    const expected = expectedLpForDeposit(amountA.toString(), amountB, pool.reserveA, pool.reserveB, pool.lpSupply) ?? "0";
    const add = (minLpOut: string, b = amountB) => amm.addLiquidity({ sender: address, poolId: pool.id, amountA: { denom: pool.tokenA, amount: amountA.toString() }, amountB: { denom: pool.tokenB, amount: b }, minLpOut });
    const result = await simulate([add(applySlippage(expected, 50))]);
    if (!result.ok) {
      record("add liquidity: simulate", lacksFunds(result) ? "SKIP" : "FAIL", short(result.message));
    } else {
      gasNote("add liquidity", result);
      const outcome = simulatedOutcome(result.events);
      record("add liquidity: lp_minted vs Qwakk", outcome.lpMinted ? diffStatus(BigInt(outcome.lpMinted), BigInt(expected)) : "FAIL", `event ${outcome.lpMinted ?? "missing"}, expected ${expected}`);
      record("add liquidity: tokens_in", "INFO", `${outcome.tokensIn?.map((coin) => `${coin.amount}${coin.denom}`).join(", ") ?? "missing"}; sent ${amountA}${pool.tokenA}, ${amountB}${pool.tokenB}`);

      const strict = await simulate([add((BigInt(outcome.lpMinted ?? expected) + BigInt(1)).toString())]);
      const strictReason = strict.ok ? "accepted" : classifySimulationError(strict.message);
      record("add liquidity: minLpOut enforced", strictReason === "price_moved" ? "PASS" : strict.ok ? "FAIL" : "WARN", strict.ok ? "a minLpOut above the minted amount was accepted" : `refused as ${strictReason}: ${short(strict.message, 70)}`);

      // Off-ratio deposit: does the keeper refund the excess or keep it?
      const excessB = (BigInt(amountB) * BigInt(11)) / BigInt(10);
      if ((balances.get(pool.tokenB) ?? BigInt(0)) >= excessB) {
        const offRatio = await simulate([add("1", excessB.toString())]);
        const tokensIn = offRatio.ok ? simulatedOutcome(offRatio.events).tokensIn : undefined;
        const takenB = tokensIn?.find((coin) => coin.denom === pool.tokenB)?.amount;
        record("add liquidity: off-ratio deposit (10% extra B)", "INFO", !offRatio.ok ? `refused: ${short(offRatio.message, 80)}` : takenB === undefined ? "tokens_in missing" : BigInt(takenB) < excessB ? `excess refunded: pool took ${takenB} of ${excessB} ${pool.tokenB}` : `excess KEPT by the pool: took all ${excessB} ${pool.tokenB}. Qwakk never sends off-ratio deposits.`);
      }

      // Remove the LP this deposit mints, in the same simulated tx, so no existing LP is needed.
      if (lpBalance === BigInt(0) && outcome.lpMinted) {
        const lp = BigInt(outcome.lpMinted);
        const after = expectedWithdrawal(lp.toString(), (reserveA + amountA).toString(), (reserveB + BigInt(amountB)).toString(), (supply + lp).toString());
        if (after) {
          const both = await simulate([add("1"), amm.removeLiquidity({ sender: address, poolId: pool.id, lpAmount: lp.toString(), minAmountA: applySlippage(after.amountA, 50), minAmountB: applySlippage(after.amountB, 50) })]);
          reportRemoval("remove liquidity (add then remove in one tx)", both, after);
        }
      }
    }
  }

  if (lpBalance > BigInt(0)) {
    const lp = lpBalance / BigInt(10) > BigInt(0) ? lpBalance / BigInt(10) : lpBalance;
    const expected = expectedWithdrawal(lp.toString(), pool.reserveA, pool.reserveB, pool.lpSupply);
    if (!expected) {
      record("remove liquidity", "FAIL", "LP balance exceeds supply");
      return;
    }
    const remove = (minA: string, minB: string) => amm.removeLiquidity({ sender: address, poolId: pool.id, lpAmount: lp.toString(), minAmountA: minA, minAmountB: minB });
    reportRemoval("remove liquidity (10% of the address's LP)", await simulate([remove(applySlippage(expected.amountA, 50), applySlippage(expected.amountB, 50))]), expected);
    const strict = await simulate([remove((BigInt(expected.amountA) + BigInt(2)).toString(), (BigInt(expected.amountB) + BigInt(2)).toString())]);
    const reason = strict.ok ? "accepted" : classifySimulationError(strict.message);
    record("remove liquidity: minimums enforced", reason === "price_moved" ? "PASS" : strict.ok ? "FAIL" : "WARN", strict.ok ? "minimums above the payout were accepted" : `refused as ${reason}: ${short(strict.message, 70)}`);
  } else {
    record("remove liquidity from existing LP", "SKIP", "the address holds no LP shares in this pool");
  }
}

function reportRemoval(label: string, simulation: Simulation, expected: { amountA: string; amountB: string }) {
  if (!simulation.ok) {
    record(`${label}: simulate`, lacksFunds(simulation) ? "SKIP" : "FAIL", short(simulation.message));
    return;
  }
  gasNote(label, simulation);
  const tokensOut = simulatedOutcome(simulation.events).tokensOut;
  if (!tokensOut) {
    record(`${label}: tokens_out`, "FAIL", "no readable tokens_out on amm_liquidity_removed");
    return;
  }
  const amounts = tokensOut.map((coin) => BigInt(coin.amount));
  const wanted = [BigInt(expected.amountA), BigInt(expected.amountB)];
  // Each expected side must match one paid-out coin; take the best match per side.
  const rank: Record<Status, number> = { PASS: 0, WARN: 1, INFO: 2, SKIP: 3, FAIL: 4 };
  const statuses = wanted.map((want) => amounts.map((got) => diffStatus(got, want)).sort((x, y) => rank[x] - rank[y])[0] ?? "FAIL");
  const status: Status = statuses.includes("FAIL") ? "FAIL" : statuses.includes("WARN") ? "WARN" : "PASS";
  record(`${label}: tokens_out vs Qwakk`, status, `event ${tokensOut.map((coin) => `${coin.amount}${coin.denom}`).join(", ")}, expected ${expected.amountA} + ${expected.amountB}`);
}

async function checkDuplicatePool(pool: AmmPool, address: string) {
  const params = await readAmmParams();
  const found = await readAmmPoolByDenoms(pool.tokenB, pool.tokenA);
  record("duplicate pool: PoolByDenoms (reversed order)", found?.id === pool.id ? "PASS" : "FAIL", found ? `pool #${found.id}` : "not found");
  const amount = params.minLiquidity;
  const duplicate = await simulate([amm.createPool({ creator: address, poolType: pool.poolType || "constant_product", initialDepositA: { denom: pool.tokenB, amount }, initialDepositB: { denom: pool.tokenA, amount }, amplificationCoefficient: pool.amplificationCoefficient })]);
  const reason = duplicate.ok ? "accepted" : classifySimulationError(duplicate.message);
  record("duplicate pool: simulated MsgCreatePool", reason === "pool_exists" ? "PASS" : reason === "insufficient_funds" ? "INFO" : "FAIL", duplicate.ok ? "a second pool for the same pair was ACCEPTED" : `refused as ${reason}${reason === "insufficient_funds" ? " (funds are checked before the duplicate, so the order is unknown)" : ""}`);
}

function printTable() {
  const width = (key: "check" | "status") => Math.max(key.length, ...rows.map((row) => row[key].length));
  const checkWidth = width("check");
  const statusWidth = width("status");
  const line = `${"-".repeat(checkWidth)}  ${"-".repeat(statusWidth)}  ${"-".repeat(60)}`;
  console.log(`\n${"Check".padEnd(checkWidth)}  ${"Result".padEnd(statusWidth)}  Detail`);
  console.log(line);
  for (const row of rows) console.log(`${row.check.padEnd(checkWidth)}  ${row.status.padEnd(statusWidth)}  ${row.detail}`);
  console.log(line);
  const count = (status: Status) => rows.filter((row) => row.status === status).length;
  console.log(`PASS ${count("PASS")}  WARN ${count("WARN")}  FAIL ${count("FAIL")}  SKIP ${count("SKIP")}  INFO ${count("INFO")}`);
  console.log("Nothing was signed or broadcast.");
}

async function main() {
  const poolId = argument("--pool");
  const address = argument("--address");
  if (!poolId || !/^\d+$/.test(poolId)) throw new Error("--pool <id> is required");
  if (!address || !/^qor1[0-9a-z]{20,}$/i.test(address)) throw new Error("--address <qor1...> is required");
  const amountArg = argument("--amount-in");
  if (amountArg && !/^\d+$/.test(amountArg)) throw new Error("--amount-in must be base units");
  const amountOutArg = argument("--amount-out");
  if (amountOutArg && !/^\d+$/.test(amountOutArg)) throw new Error("--amount-out must be base units");
  const feeBps = Number(argument("--fee-bps") ?? "10");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_QWAKK_INTERFACE_FEE_BPS) throw new Error(`--fee-bps must be 0 to ${MAX_QWAKK_INTERFACE_FEE_BPS}`);
  const treasury = argument("--treasury") ?? process.env.QWAKK_TREASURY_ADDRESS?.trim() ?? address;

  // The shared chain readers log every refused quote; the boundary search below refuses on purpose.
  console.warn = () => {};
  console.log(`Qwakk AMM verifier on ${QORECHAIN_REST_URL}: pool #${poolId}, simulated sender ${address}`);
  const [params, pool, accountSequence, balances] = await Promise.all([readAmmParams(), readAmmPool(poolId), readAccountSequence(address), readBalances(address)]);
  record("AMM params", "INFO", `swap fee ${params.swapFeeBps} bps, impact cap ${params.maxSwapImpactBps} bps, min liquidity ${params.minLiquidity}, creation fee ${params.poolCreationFee} uqor, enabled ${params.enabled}`);
  if (!pool) throw new Error(`Pool ${poolId} does not exist on this network`);
  if (accountSequence === null) throw new Error("The address has no account on this network. Use a funded address.");
  sequence = accountSequence;
  const lpBalance = BigInt(await readLpBalance(pool.id, address));
  record("pool", pool.status === "active" ? "PASS" : "WARN", `${pool.poolType} ${pool.tokenA}/${pool.tokenB}, reserves ${pool.reserveA}/${pool.reserveB}, LP supply ${pool.lpSupply}, status ${pool.status}`);
  record("pool: sorted denoms", pool.tokenA < pool.tokenB ? "PASS" : "FAIL", `${pool.tokenA} < ${pool.tokenB}`);
  record("sender", "INFO", `balances ${[...balances].map(([denom, amount]) => `${amount}${denom}`).join(", ") || "none"}; LP ${lpBalance}`);
  if (pool.status !== "active") {
    printTable();
    return;
  }

  const fee = { enabled: true as const, recipient: treasury, feeBps };
  await checkSwapDirection(pool, address, balances, true, fee, amountArg);
  await checkSwapDirection(pool, address, balances, false, fee, amountArg);
  await checkExactOutDirection(pool, address, true, fee, amountOutArg);
  await checkExactOutDirection(pool, address, false, fee, amountOutArg);
  await checkImpactCap(pool, address);
  await checkLiquidity(pool, address, balances, lpBalance);
  await checkDuplicatePool(pool, address);

  // A reminder that the guarded message builder refuses anything but AMM plus the fee.
  try {
    encodedMessagesForAction(address, { kind: "swap", poolId: pool.id, denomIn: pool.tokenA, amountIn: "1000", denomOut: pool.tokenB, minOut: "0" }, fee);
    record("builder: refuses minOut 0", "FAIL", "a swap without price protection was built");
  } catch {
    record("builder: refuses minOut 0", "PASS", "a swap without price protection is never built");
  }
  printTable();
  if (rows.some((row) => row.status === "FAIL")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "The verifier stopped");
  if (rows.length) printTable();
  process.exitCode = 1;
});

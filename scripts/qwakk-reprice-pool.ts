/**
 * Qwakk pool repricer. Operator tooling, QoreChain Diana (testnet) only.
 *
 * Moves a constant-product pool's price to a target with a series of exact-in
 * swaps that each stay under the chain's `max_swap_impact_bps`, then
 * optionally adds liquidity at the corrected ratio and trims the last bit of
 * price with one or two small swaps against the deeper pool. The planner is
 * lib/qwakk-reprice.ts; every rule it models is cited there.
 *
 * Default mode is a dry run. It reads the live pool, plans every step, checks
 * the first step against QoreChain's own quote and a keyless simulation
 * (nothing is signed or broadcast), and prints the plan and the funds needed.
 * The dry run needs no mnemonic: pass `--address` (or let it use the pool
 * creator) as the simulated sender.
 *
 * `--apply` signs with QWAKK_TESTNET_MNEMONIC and broadcasts step by step.
 * Before every step it re-reads the pool, re-plans from the live reserves,
 * asks QoreChain for the quote and simulates; it stops on anything it did not
 * expect (another trade in between, a quote below plan, a failed simulation).
 * Every swap carries the quoted output as its minimum. `--max-steps` caps the
 * swaps per run; running again resumes from the live pool.
 *
 * The mnemonic is read only with `--apply`, never printed or logged, and
 * nothing derived from it is shown except the address.
 *
 * Command (from qwakk-app/, the mnemonic in .env.local as QWAKK_TESTNET_MNEMONIC):
 *
 *   # Dry run, no mnemonic needed:
 *   npx tsx scripts/qwakk-reprice-pool.ts --pool 1 \
 *     --base-denom erc20:0x02292293c13880a26242690eb70a0e42B8E91c28 --quote-denom uqor \
 *     --target-price 3000 --add-quote 3000 --address qor1yourwallet...
 *
 *   # Apply (signs and broadcasts):
 *   npx tsx --env-file=.env.local scripts/qwakk-reprice-pool.ts --pool 1 \
 *     --base-denom erc20:0x02292293c13880a26242690eb70a0e42B8E91c28 --quote-denom uqor \
 *     --target-price 3000 --add-quote 3000 --apply
 *
 * Options:
 *   --pool <id>                 Pool to reprice (required).
 *   --target-price <decimal>    Quote per base in display units, e.g. 3000 (QOR per fETH).
 *   --base-denom / --quote-denom  Exact pool denoms. Default quote: uqor when the pool holds it.
 *   --base-decimals / --quote-decimals  Override the registry decimals.
 *   --add-quote <decimal>       After repricing, deposit this much quote (display units) plus
 *                               the matching base, then trim the price with small swaps.
 *   --strategy swaps|reset      swaps (default): the stepwise swaps above. reset: only when the
 *                               signer holds every LP share, withdraw all and deposit again at
 *                               the target ratio in one transaction (needs --add-quote).
 *   --step-impact-bps <n>       Planned impact per swap (default 450, chain cap 500).
 *   --tolerance-bps <n>         Close enough for the swap phase (default 50).
 *   --trim-tolerance-bps <n>    Close enough after the deposit (default 10).
 *   --max-steps <n>             Swaps per run (default 300).
 *   --address <qor1...>         Dry run sender; with --apply it must match the mnemonic.
 *   --show-steps                Print every planned step.
 *   --apply                     Sign and broadcast. Without it nothing is sent.
 */

import {
  EthNativeSigner,
  amm,
  buildRegisterPqcKeyMsg,
  createClient,
  deriveUnifiedAccount,
  getPqcStatus,
  waitForTx,
  type EncodeObject,
  type EthBroadcaster,
  type UnifiedAccount,
} from "@qorechain/sdk";

import { readAmmParams, readAmmPool, readBalances, readLpBalance, type AmmParams, type AmmPool } from "../lib/qwakk-amm-chain";
import { formatRatio } from "../lib/qwakk-amm-math";
import { assetForDenom, formatBaseAmount } from "../lib/qwakk-assets";
import { buildLiquidityRoute } from "../lib/qwakk-liquidity-route";
import {
  encodeAsAny,
  eventAttributes,
  gasLimitForSimulatedGas,
  networkFeeForGas,
  readAccountSequence,
  simulateMessages,
  simulatedOutcome,
  type SimulationResult,
} from "../lib/qwakk-native-tx";
import { getQwakkNetwork } from "../lib/qwakk-network";
import {
  deviationBps,
  nextRepriceStep,
  parseTargetRatio,
  planDeposit,
  planReprice,
  planResetDeposit,
  type DepositPlan,
  type Ratio,
  type RepriceParams,
  type RepricePlan,
  type RepriceStep,
} from "../lib/qwakk-reprice";

const NETWORK = getQwakkNetwork();
const PLAN_LIMIT = 5_000;
const ZERO = BigInt(0);

// ---------------------------------------------------------------- arguments

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function flag(name: string) {
  return process.argv.includes(name);
}

function wholeNumber(name: string, fallback: number, min: number, max: number) {
  const value = argument(name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return Number(value);
}

/** A display amount to base units, integer math only. */
function toBase(value: string, decimals: number, name: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`${name} must be a positive decimal number`);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`${name} has more than ${decimals} decimals`);
  const amount = BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (amount <= ZERO) throw new Error(`${name} must be above zero`);
  return amount;
}

// ---------------------------------------------------------------- chain reads

type Quote = { ok: true; amountOut: bigint; impactBps: number } | { ok: false; message: string };

/** QoreChain's own exact-in quote, with the keeper's `impact_bps`. */
async function chainQuote(poolId: string, denomIn: string, amountIn: bigint): Promise<Quote> {
  const query = new URLSearchParams({ pool_id: poolId, denom_in: denomIn, amount_in: amountIn.toString() });
  const response = await fetch(`${NETWORK.restUrl}/qorechain/amm/v1/quote/exact_in?${query}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => null) as { amount_out?: unknown; impact_bps?: unknown; message?: unknown } | null;
  if (response.ok && typeof body?.amount_out === "string" && /^\d+$/.test(body.amount_out)) {
    return { ok: true, amountOut: BigInt(body.amount_out), impactBps: Number(body.impact_bps ?? 0) };
  }
  return { ok: false, message: typeof body?.message === "string" ? body.message : `HTTP ${response.status}` };
}

type AccountInfo = { accountNumber: bigint; sequence: bigint };

function findAccountInfo(value: unknown): AccountInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const accountNumber = record.account_number ?? record.accountNumber;
  const sequence = record.sequence;
  if ((typeof accountNumber === "string" || typeof accountNumber === "number") && (typeof sequence === "string" || typeof sequence === "number")) {
    return { accountNumber: BigInt(accountNumber), sequence: BigInt(sequence) };
  }
  for (const nested of Object.values(record)) {
    const found = findAccountInfo(nested);
    if (found) return found;
  }
  return null;
}

async function readAccount(address: string) {
  const response = await fetch(`${NETWORK.restUrl}/cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("This wallet has no account on the testnet yet. Fund it first.");
  const info = findAccountInfo(await response.json());
  if (!info) throw new Error("Unsupported account response");
  return info;
}

type BroadcastEnvelope = { tx_response?: { code?: number | string; txhash?: string; height?: number | string; raw_log?: string; gas_used?: string; gas_wanted?: string } };

const broadcaster: EthBroadcaster = {
  async broadcastTx(rawTx) {
    const response = await fetch(`${NETWORK.restUrl}/cosmos/tx/v1beta1/txs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ tx_bytes: Buffer.from(rawTx).toString("base64"), mode: "BROADCAST_MODE_SYNC" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("The node rejected the transaction submission");
    const result = (await response.json()) as BroadcastEnvelope;
    const tx = result.tx_response;
    if (!tx?.txhash) throw new Error("The node did not return a transaction hash");
    return {
      code: Number(tx.code ?? 0),
      transactionHash: tx.txhash,
      height: tx.height ? Number(tx.height) : undefined,
      gasUsed: tx.gas_used ? BigInt(tx.gas_used) : undefined,
      gasWanted: tx.gas_wanted ? BigInt(tx.gas_wanted) : undefined,
      rawLog: tx.raw_log,
    };
  },
};

// ---------------------------------------------------------------- setup

type Context = {
  pool: AmmPool;
  params: AmmParams;
  repriceParams: RepriceParams;
  base: { denom: string; decimals: number; symbol: string };
  quote: { denom: string; decimals: number; symbol: string };
  target: Ratio;
  targetText: string;
  stepImpactBps: number;
  toleranceBps: number;
  trimToleranceBps: number;
  maxSteps: number;
  addQuote: bigint | null;
};

function reservesOf(pool: AmmPool, baseDenom: string) {
  const baseIsA = pool.tokenA === baseDenom;
  return {
    reserveBase: BigInt(baseIsA ? pool.reserveA : pool.reserveB),
    reserveQuote: BigInt(baseIsA ? pool.reserveB : pool.reserveA),
  };
}

function amount(value: bigint, side: Context["base"]) {
  return `${formatBaseAmount(value.toString(), side.decimals, side.decimals)} ${side.symbol} (${value} base units)`;
}

function price(context: Context, reserveBase: bigint, reserveQuote: bigint) {
  return `${formatRatio(reserveQuote, context.quote.decimals, reserveBase, context.base.decimals, 6) ?? "n/a"} ${context.quote.symbol} per ${context.base.symbol}`;
}

async function loadContext(): Promise<Context> {
  if (NETWORK.id !== "testnet") throw new Error("qwakk-reprice-pool only runs on the testnet. Unset QWAKK_NETWORK or set it to testnet.");
  const poolId = argument("--pool");
  if (!poolId || !/^\d+$/.test(poolId)) throw new Error("--pool <id> is required");
  const targetText = argument("--target-price");
  if (!targetText) throw new Error("--target-price <quote per base> is required");

  const [pool, params] = await Promise.all([readAmmPool(poolId), readAmmParams()]);
  if (!pool) throw new Error(`Pool ${poolId} does not exist`);
  if (pool.poolType !== "constant_product") throw new Error("Only constant-product pools can be repriced with this planner");
  if (pool.status !== "active") throw new Error("The pool is not active");
  if (!params.enabled) throw new Error("The AMM module is switched off");

  const quoteDenom = argument("--quote-denom") ?? (pool.tokenA === "uqor" || pool.tokenB === "uqor" ? "uqor" : undefined);
  if (!quoteDenom) throw new Error("--quote-denom is required for a pool without uqor");
  const baseDenom = argument("--base-denom") ?? (pool.tokenA === quoteDenom ? pool.tokenB : pool.tokenA);
  const pair = new Set([pool.tokenA, pool.tokenB]);
  if (!pair.has(baseDenom) || !pair.has(quoteDenom) || baseDenom === quoteDenom) throw new Error("--base-denom and --quote-denom must be the pool's two exact denoms");

  const side = (denom: string, flagName: string) => {
    const curated = assetForDenom(denom);
    const override = argument(flagName);
    const decimals = override !== undefined ? Number(override) : curated?.decimals;
    if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`Decimals for ${denom} are unknown. Pass ${flagName}.`);
    return { denom, decimals, symbol: curated?.symbol ?? denom };
  };
  const base = side(baseDenom, "--base-decimals");
  const quote = side(quoteDenom, "--quote-decimals");

  const stepImpactBps = wholeNumber("--step-impact-bps", Math.min(450, params.maxSwapImpactBps - 10), 1, Math.max(1, params.maxSwapImpactBps - 1));
  const addQuoteText = argument("--add-quote");
  return {
    pool,
    params,
    repriceParams: { swapFeeBps: params.swapFeeBps, protocolFeeBps: params.protocolFeeBps, maxSwapImpactBps: params.maxSwapImpactBps },
    base,
    quote,
    target: parseTargetRatio(targetText, base.decimals, quote.decimals),
    targetText,
    stepImpactBps,
    toleranceBps: wholeNumber("--tolerance-bps", 50, 0, 5_000),
    trimToleranceBps: wholeNumber("--trim-tolerance-bps", 10, 0, 5_000),
    maxSteps: wholeNumber("--max-steps", 300, 1, PLAN_LIMIT),
    addQuote: addQuoteText ? toBase(addQuoteText, quote.decimals, "--add-quote") : null,
  };
}

// ---------------------------------------------------------------- messages

function swapMessage(context: Context, sender: string, step: Pick<RepriceStep, "direction" | "amountIn" | "minOut">): EncodeObject {
  const denomIn = step.direction === "sell_base" ? context.base.denom : context.quote.denom;
  const denomOut = step.direction === "sell_base" ? context.quote.denom : context.base.denom;
  return amm.swapExactIn({ sender, poolId: context.pool.id, tokenIn: { denom: denomIn, amount: step.amountIn.toString() }, denomOut, minOut: step.minOut.toString() });
}

function depositMessage(context: Context, sender: string, deposit: DepositPlan): EncodeObject {
  const baseIsA = context.pool.tokenA === context.base.denom;
  return buildLiquidityRoute({
    action: "add",
    sender,
    poolId: context.pool.id,
    denomA: context.pool.tokenA,
    amountA: (baseIsA ? deposit.baseAmount : deposit.quoteAmount).toString(),
    denomB: context.pool.tokenB,
    amountB: (baseIsA ? deposit.quoteAmount : deposit.baseAmount).toString(),
    minLpOut: deposit.minLp.toString(),
  }).message;
}

/** Withdraw every LP share; the minimums are the full reserves, so any trade in between fails the transaction. */
function withdrawAllMessage(pool: AmmPool, sender: string): EncodeObject {
  return buildLiquidityRoute({ action: "remove", sender, poolId: pool.id, lpAmount: pool.lpSupply, minAmountA: pool.reserveA, minAmountB: pool.reserveB }).message;
}

async function simulate(sender: string, messages: EncodeObject[]): Promise<SimulationResult> {
  const sequence = (await readAccountSequence(sender)) ?? ZERO;
  return simulateMessages(encodeAsAny(messages), sequence);
}

// ---------------------------------------------------------------- dry run

function printSteps(context: Context, label: string, plan: RepricePlan, all: boolean) {
  const rows = all || plan.steps.length <= 10 ? plan.steps : [...plan.steps.slice(0, 5), null, ...plan.steps.slice(-5)];
  console.log(`  ${label}: ${plan.steps.length} swap(s), stop: ${plan.stop}`);
  for (const step of rows) {
    if (step === null) {
      console.log(`    ... ${plan.steps.length - 10} more ...`);
      continue;
    }
    const sideIn = step.direction === "sell_base" ? context.base : context.quote;
    const sideOut = step.direction === "sell_base" ? context.quote : context.base;
    console.log(`    #${step.index} sell ${step.amountIn} ${sideIn.symbol} units for >= ${step.minOut} ${sideOut.symbol} units, impact ${step.impactBps} bps, reserves after ${step.reserveBaseAfter} / ${step.reserveQuoteAfter}, ${step.deviationBpsAfter} bps from target`);
  }
}

async function dryRun(context: Context, sender: string, senderLabel: string) {
  const { pool } = context;
  const { reserveBase, reserveQuote } = reservesOf(pool, context.base.denom);
  const lpSupply = BigInt(pool.lpSupply);

  console.log(`Network: ${NETWORK.label} (${NETWORK.chainId})`);
  console.log(`Pool ${pool.id}: ${amount(reserveBase, context.base)} / ${amount(reserveQuote, context.quote)}, LP supply ${lpSupply}`);
  console.log(`Price now: ${price(context, reserveBase, reserveQuote)}`);
  console.log(`Target:    ${context.targetText} ${context.quote.symbol} per ${context.base.symbol} (${deviationBps(reserveBase, reserveQuote, context.target)} bps from it)`);
  console.log(`Chain: swap fee ${context.params.swapFeeBps} bps, protocol share ${context.params.protocolFeeBps} bps, impact cap ${context.params.maxSwapImpactBps} bps, min_liquidity ${context.params.minLiquidity}. Planned impact per swap: ${context.stepImpactBps} bps.`);
  console.log(`Simulated sender: ${sender} (${senderLabel})`);
  console.log("");

  // 1. Swap phase.
  const swaps = planReprice({ reserveBase, reserveQuote, target: context.target, params: context.repriceParams, stepImpactBps: context.stepImpactBps, toleranceBps: context.toleranceBps, maxSteps: PLAN_LIMIT });
  console.log("Plan (strategy swaps):");
  printSteps(context, "1. Reprice swaps", swaps, flag("--show-steps"));
  console.log(`     After the swaps: ${amount(swaps.reserveBase, context.base)} / ${amount(swaps.reserveQuote, context.quote)}, price ${price(context, swaps.reserveBase, swaps.reserveQuote)} (${swaps.deviationBps} bps from target)`);
  console.log(`     Smallest reserves along the way: ${swaps.minReserveBase} ${context.base.symbol} units, ${swaps.minReserveQuote} ${context.quote.symbol} units`);

  // 2. Deposit and 3. trim.
  let deposit: DepositPlan | null = null;
  let trim: RepricePlan | null = null;
  if (context.addQuote !== null) {
    deposit = planDeposit(context.addQuote, swaps.reserveBase, swaps.reserveQuote, lpSupply);
    console.log(`  2. Add liquidity: ${amount(deposit.quoteAmount, context.quote)} + up to ${amount(deposit.baseAmount, context.base)}, at least ${deposit.minLp} LP (expected ${deposit.expectedLp})`);
    trim = planReprice({
      reserveBase: swaps.reserveBase + deposit.baseAmount,
      reserveQuote: swaps.reserveQuote + deposit.quoteAmount,
      target: context.target,
      params: context.repriceParams,
      stepImpactBps: context.stepImpactBps,
      toleranceBps: context.trimToleranceBps,
      maxSteps: PLAN_LIMIT,
    });
    printSteps(context, "3. Trim swaps on the deeper pool", trim, true);
    console.log(`     Final: price ${price(context, trim.reserveBase, trim.reserveQuote)} (${trim.deviationBps} bps from target)`);
  } else {
    console.log("  2. No --add-quote: the pool keeps its tiny reserves and the price stays where the swaps end.");
  }
  const totalSwaps = swaps.steps.length + (trim?.steps.length ?? 0);

  // Verdict.
  console.log("");
  if (swaps.stop === "impact_floor") {
    console.log(`Verdict: swaps cannot reach the target safely. The ${swaps.direction === "sell_base" ? context.quote.symbol : context.base.symbol} reserve gets so small that even a one-unit swap breaks the ${context.stepImpactBps} bps step limit.`);
  } else if (swaps.stop === "granularity" && !deposit) {
    console.log(`Verdict: swaps alone end ${swaps.deviationBps} bps from the target (one more unit of output would overshoot). Add --add-quote to deposit and trim the rest.`);
  } else {
    const final = trim ?? swaps;
    console.log(`Verdict: reachable in ${totalSwaps} swap(s)${deposit ? " and one deposit" : ""}, ending ${final.deviationBps} bps from the target.`);
  }
  if (totalSwaps > context.maxSteps) console.log(`Note: --max-steps is ${context.maxSteps}, so --apply stops after ${context.maxSteps} swaps. Run it again to continue from the live pool.`);

  // First step: the chain's own quote and a keyless simulation.
  const first = swaps.steps[0];
  let gasPerSwap = BigInt(200_000);
  if (first) {
    const denomIn = first.direction === "sell_base" ? context.base.denom : context.quote.denom;
    const quote = await chainQuote(pool.id, denomIn, first.amountIn);
    console.log("");
    console.log(quote.ok
      ? `Step 1 chain quote: out ${quote.amountOut} (plan ${first.amountOut}), impact ${quote.impactBps} bps (plan ${first.impactBps}). ${quote.amountOut >= first.minOut && quote.impactBps <= context.stepImpactBps ? "Matches." : "DOES NOT MATCH THE PLAN."}`
      : `Step 1 chain quote refused: ${quote.message}`);
    const simulation = await simulate(sender, [swapMessage(context, sender, first)]);
    if (simulation.ok) {
      gasPerSwap = simulation.gasUsed;
      const swap = simulatedOutcome(simulation.events).swap;
      console.log(`Step 1 keyless simulation: OK, gas ${simulation.gasUsed}, out ${swap?.amountOut ?? "?"}.`);
    } else {
      console.log(`Step 1 keyless simulation refused: ${simulation.failure}${simulation.failure === "insufficient_funds" ? " (the simulated sender lacks the input token or the fee)" : ""}.`);
    }
  }

  // Funds.
  const swapFee = networkFeeForGas(gasLimitForSimulatedGas(gasPerSwap));
  const depositFee = networkFeeForGas(gasLimitForSimulatedGas(BigInt(170_000)));
  const gasTotal = swapFee * BigInt(totalSwaps) + (deposit ? depositFee : ZERO);
  const baseIn = swaps.totalBaseIn + (trim?.totalBaseIn ?? ZERO) + (deposit?.baseAmount ?? ZERO);
  const quoteIn = swaps.totalQuoteIn + (trim?.totalQuoteIn ?? ZERO) + (deposit?.quoteAmount ?? ZERO);
  const baseBack = swaps.totalBaseOut + (trim?.totalBaseOut ?? ZERO);
  const quoteBack = swaps.totalQuoteOut + (trim?.totalQuoteOut ?? ZERO);
  console.log("");
  console.log("Funds the signing wallet needs (strategy swaps):");
  console.log(`  ${context.base.symbol} in: ${amount(baseIn, context.base)}${baseBack > ZERO ? `, ${amount(baseBack, context.base)} comes back from swaps` : ""}`);
  console.log(`  ${context.quote.symbol} in: ${amount(quoteIn, context.quote)}${quoteBack > ZERO ? `, ${amount(quoteBack, context.quote)} comes back from swaps` : ""}`);
  console.log(`  Network fees: about ${formatBaseAmount(gasTotal.toString(), 6, 6)} QOR (${totalSwaps} swaps at about ${formatBaseAmount(swapFee.toString(), 6, 6)} QOR${deposit ? ", plus the deposit" : ""}; simulated gas x1.3 + 100000 for the post-quantum layer, at 0.15 uqor per gas)`);
  console.log("  If the wallet has no post-quantum key yet, the first run registers it in a separate transaction with its own fee.");

  const balances = await readBalances(sender).catch(() => null);
  if (balances) {
    const needQor = (context.quote.denom === "uqor" ? quoteIn : ZERO) + (context.base.denom === "uqor" ? baseIn : ZERO) + gasTotal;
    const lines = [
      [context.base.denom, context.base.denom === "uqor" ? needQor : baseIn],
      [context.quote.denom, context.quote.denom === "uqor" ? needQor : quoteIn],
    ] as const;
    for (const [denom, need] of lines) {
      const have = balances.get(denom) ?? ZERO;
      const side = denom === context.base.denom ? context.base : context.quote;
      console.log(`  ${side.symbol}: simulated sender holds ${amount(have, side)}, needs ${amount(need, side)}${have >= need ? "" : ". SHORT."}`);
    }
  }

  // Reset alternative.
  console.log("");
  const lpHeld = await readLpBalance(pool.id, sender).catch(() => null);
  if (lpHeld !== null && lpHeld === pool.lpSupply && lpSupply > ZERO) {
    console.log(`Alternative (strategy reset): ${sender} holds every LP share (${lpHeld}), so it can withdraw everything and deposit again at the target ratio in one transaction.`);
    if (context.addQuote === null) {
      console.log("  Pass --add-quote to size the new deposit.");
    } else {
      const reset = planResetDeposit(context.addQuote, context.target);
      console.log(`  Withdraw ${pool.lpSupply} LP (gets back ${amount(reserveBase, context.base)} and ${amount(reserveQuote, context.quote)}), then deposit ${amount(reset.quoteAmount, context.quote)} + ${amount(reset.baseAmount, context.base)}, at least ${reset.minLp} LP.`);
      console.log(`  Price after: ${price(context, reset.baseAmount, reset.quoteAmount)}.`);
      const min = BigInt(context.params.minLiquidity);
      if (reset.baseAmount < min || reset.quoteAmount < min) console.log(`  Warning: one side is below min_liquidity (${min}); the chain may refuse it.`);
      const simulation = await simulate(sender, [withdrawAllMessage(pool, sender), depositMessage(context, sender, reset)]);
      console.log(simulation.ok
        ? `  Keyless simulation: OK, gas ${simulation.gasUsed}, LP minted ${simulatedOutcome(simulation.events).lpMinted ?? "?"}. Network fee about ${formatBaseAmount(networkFeeForGas(gasLimitForSimulatedGas(simulation.gasUsed)).toString(), 6, 6)} QOR.`
        : `  Keyless simulation refused: ${simulation.failure}.`);
    }
  } else {
    console.log(`Strategy reset is not available: ${sender} does not hold every LP share${lpHeld === null ? " (LP balance unreadable)" : ` (${lpHeld} of ${pool.lpSupply})`}.`);
  }
  console.log("");
  console.log("Dry run only. Nothing was signed or broadcast.");
}

// ---------------------------------------------------------------- apply

class Stop extends Error {}

type Signer = { account: UnifiedAccount; address: string; hybrid: EthNativeSigner; client: ReturnType<typeof createClient> };

async function loadSigner(): Promise<Signer> {
  const mnemonic = process.env.QWAKK_TESTNET_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("QWAKK_TESTNET_MNEMONIC is required for --apply (load it with npx tsx --env-file=.env.local ...)");
  let account: UnifiedAccount;
  try {
    account = await deriveUnifiedAccount(mnemonic);
  } catch {
    // Never echo the SDK's error: it is about the mnemonic.
    throw new Error("QWAKK_TESTNET_MNEMONIC is not a valid mnemonic");
  }
  const address = account.cosmos;
  const expected = argument("--address");
  if (expected && expected !== address) throw new Error(`--address does not match the mnemonic's address ${address}`);
  const client = createClient({ network: "testnet", endpoints: { rest: NETWORK.restUrl, rpc: NETWORK.rpcUrl, evmRpc: NETWORK.evmRpcUrl } });
  return { account, address, hybrid: new EthNativeSigner(account, { rest: NETWORK.restUrl }), client };
}

async function ensurePqcKey(signer: Signer) {
  const status = await getPqcStatus(signer.client, signer.address);
  if (status.registered) return;
  const auth = await readAccount(signer.address);
  const registration = buildRegisterPqcKeyMsg(signer.address, {
    pqcKeypair: signer.account.pqc,
    ecdsaPubkey: Uint8Array.from(Buffer.from(signer.account.publicKey.replace(/^0x/, ""), "hex")),
    keyType: "hybrid",
  });
  const classical = new EthNativeSigner(signer.account, { signMode: "classical", rest: NETWORK.restUrl });
  const result = await classical.signAndBroadcast(broadcaster, {
    chainId: NETWORK.chainId,
    accountNumber: auth.accountNumber,
    sequence: auth.sequence,
    messages: [registration],
    fee: { amount: [{ denom: "uqor", amount: "100000" }], gas: "1000000" },
    memo: "Qwakk testnet PQC registration",
  });
  await waitForTx(signer.client.rest, result.transactionHash);
  console.log(`Post-quantum key registered: ${result.transactionHash}`);
}

async function send(signer: Signer, messages: EncodeObject[], gasUsed: bigint, memo: string) {
  const gasLimit = gasLimitForSimulatedGas(gasUsed);
  const fee = networkFeeForGas(gasLimit);
  const balances = await readBalances(signer.address);
  if ((balances.get("uqor") ?? ZERO) < fee) throw new Stop("Not enough QOR for the network fee");
  const auth = await readAccount(signer.address);
  const result = await signer.hybrid.signAndBroadcast(broadcaster, {
    chainId: NETWORK.chainId,
    accountNumber: auth.accountNumber,
    sequence: auth.sequence,
    messages,
    fee: { amount: [{ denom: "uqor", amount: fee.toString() }], gas: gasLimit.toString() },
    memo,
  });
  // Throws when the transaction lands with a non-zero code.
  const included = await waitForTx(signer.client.rest, result.transactionHash);
  console.log(`    included at height ${included.height}: ${NETWORK.explorerUrl}/tx/${included.txHash}`);
}

async function livePool(context: Context, expected: { reserveBase: bigint; reserveQuote: bigint } | null) {
  const pool = await readAmmPool(context.pool.id);
  if (!pool || pool.status !== "active" || pool.tokenA !== context.pool.tokenA || pool.tokenB !== context.pool.tokenB) throw new Stop("The pool changed state (missing, paused or different tokens)");
  const reserves = reservesOf(pool, context.base.denom);
  if (expected && (reserves.reserveBase !== expected.reserveBase || reserves.reserveQuote !== expected.reserveQuote)) {
    throw new Stop(`The pool moved outside this script: expected ${expected.reserveBase} / ${expected.reserveQuote}, found ${reserves.reserveBase} / ${reserves.reserveQuote}`);
  }
  return { pool, ...reserves };
}

/** Swaps toward the target until the planner stops or the step budget runs out. Returns swaps sent. */
async function applySwaps(context: Context, signer: Signer, phase: string, toleranceBps: number, budget: number, expected: { reserveBase: bigint; reserveQuote: bigint } | null) {
  let sent = 0;
  let next = expected;
  while (sent < budget) {
    const { reserveBase, reserveQuote } = await livePool(context, next);
    const planned = nextRepriceStep(reserveBase, reserveQuote, context.target, context.repriceParams, context.stepImpactBps, toleranceBps);
    if ("stop" in planned) {
      if (planned.stop === "impact_floor") throw new Stop("The output reserve is too small to move the price further within the impact limit");
      console.log(`  ${phase}: done (${planned.stop}), ${deviationBps(reserveBase, reserveQuote, context.target)} bps from target.`);
      return { sent, expected: { reserveBase, reserveQuote }, finished: true };
    }
    const step = planned.step;
    const denomIn = step.direction === "sell_base" ? context.base.denom : context.quote.denom;
    const quote = await chainQuote(context.pool.id, denomIn, step.amountIn);
    if (!quote.ok) throw new Stop(`QoreChain refused the quote: ${quote.message}`);
    if (quote.amountOut < step.minOut) throw new Stop(`The chain quotes ${quote.amountOut}, below the planned ${step.minOut}`);
    if (quote.impactBps > context.stepImpactBps) throw new Stop(`The chain reports ${quote.impactBps} bps impact, above the ${context.stepImpactBps} bps step limit`);
    const message = swapMessage(context, signer.address, { ...step, minOut: quote.amountOut });
    const simulation = await simulate(signer.address, [message]);
    if (!simulation.ok) throw new Stop(`Simulation refused the swap: ${simulation.failure}`);
    const event = eventAttributes(simulation.events, "amm_swap");
    const simulatedOut = event?.get("amount_out");
    const protocolFee = event?.get("protocol_fee");
    if (simulatedOut !== quote.amountOut.toString() || !protocolFee || !/^\d+$/.test(protocolFee)) throw new Stop("The simulation does not match the chain quote");

    console.log(`  ${phase} #${sent + 1}: sell ${step.amountIn} for ${quote.amountOut} (impact ${quote.impactBps} bps)`);
    await send(signer, [message], simulation.gasUsed, `Qwakk reprice pool ${context.pool.id}`);
    sent += 1;
    const inAfter = step.amountIn - BigInt(protocolFee);
    next = step.direction === "sell_base"
      ? { reserveBase: reserveBase + inAfter, reserveQuote: reserveQuote - quote.amountOut }
      : { reserveBase: reserveBase - quote.amountOut, reserveQuote: reserveQuote + inAfter };
  }
  return { sent, expected: next, finished: false };
}

async function apply(context: Context) {
  const signer = await loadSigner();
  console.log(`Signing wallet: ${signer.address} on ${NETWORK.label} (${NETWORK.chainId})`);
  await ensurePqcKey(signer);
  const strategy = argument("--strategy") ?? "swaps";

  if (strategy === "reset") {
    if (context.addQuote === null) throw new Error("--strategy reset needs --add-quote");
    const { pool } = await livePool(context, null);
    const held = await readLpBalance(pool.id, signer.address);
    if (held !== pool.lpSupply) throw new Stop(`The wallet holds ${held} of ${pool.lpSupply} LP shares; reset needs all of them`);
    const reset = planResetDeposit(context.addQuote, context.target);
    const messages = [withdrawAllMessage(pool, signer.address), depositMessage(context, signer.address, reset)];
    const simulation = await simulate(signer.address, messages);
    if (!simulation.ok) throw new Stop(`Simulation refused the reset: ${simulation.failure}`);
    const minted = simulatedOutcome(simulation.events).lpMinted;
    if (!minted || BigInt(minted) < reset.minLp) throw new Stop("The simulation mints fewer LP shares than planned");
    console.log(`  Reset: withdraw ${pool.lpSupply} LP, deposit ${reset.quoteAmount} + ${reset.baseAmount} base units`);
    await send(signer, messages, simulation.gasUsed, `Qwakk reset pool ${pool.id}`);
  } else if (strategy === "swaps") {
    const swaps = await applySwaps(context, signer, "Reprice", context.toleranceBps, context.maxSteps, null);
    if (!swaps.finished) {
      console.log(`Stopped after --max-steps ${context.maxSteps}. Run again to continue.`);
      return;
    }
    if (context.addQuote !== null) {
      const { pool, reserveBase, reserveQuote } = await livePool(context, swaps.expected);
      const deposit = planDeposit(context.addQuote, reserveBase, reserveQuote, BigInt(pool.lpSupply));
      const message = depositMessage(context, signer.address, deposit);
      const simulation = await simulate(signer.address, [message]);
      if (!simulation.ok) throw new Stop(`Simulation refused the deposit: ${simulation.failure}`);
      const outcome = simulatedOutcome(simulation.events);
      if (!outcome.lpMinted || BigInt(outcome.lpMinted) < deposit.minLp) throw new Stop("The simulation mints fewer LP shares than planned");
      console.log(`  Deposit: ${deposit.quoteAmount} ${context.quote.symbol} units + up to ${deposit.baseAmount} ${context.base.symbol} units`);
      await send(signer, [message], simulation.gasUsed, `Qwakk reprice pool ${pool.id} deposit`);
      const taken = new Map((outcome.tokensIn ?? []).map((coin) => [coin.denom, BigInt(coin.amount)]));
      const expected = { reserveBase: reserveBase + (taken.get(context.base.denom) ?? ZERO), reserveQuote: reserveQuote + (taken.get(context.quote.denom) ?? ZERO) };
      const trim = await applySwaps(context, signer, "Trim", context.trimToleranceBps, context.maxSteps - swaps.sent, expected);
      if (!trim.finished) console.log(`Stopped after --max-steps ${context.maxSteps}. Run again with the same arguments to finish the trim.`);
    }
  } else {
    throw new Error("--strategy must be swaps or reset");
  }

  const final = await readAmmPool(context.pool.id);
  if (final) {
    const { reserveBase, reserveQuote } = reservesOf(final, context.base.denom);
    console.log(`Pool ${final.id} now: ${amount(reserveBase, context.base)} / ${amount(reserveQuote, context.quote)}, price ${price(context, reserveBase, reserveQuote)}`);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const context = await loadContext();
  if (flag("--apply")) return apply(context);
  // The dry run never reads the mnemonic: it simulates as --address, or as the pool creator.
  const address = argument("--address");
  if (address && !/^qor1[0-9a-z]{20,}$/.test(address)) throw new Error("--address must be a qor1 address");
  await dryRun(context, address ?? context.pool.creator, address ? "--address" : "the pool creator, as a stand-in; pass --address for your wallet");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "The repricer stopped";
  console.error(error instanceof Stop ? `Stopped: ${message}` : message);
  process.exitCode = 1;
});

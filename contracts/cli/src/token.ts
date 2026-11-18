/**
 * token: deploy and move QWAKK, Qwakk's meme token, on QoreChain Diana.
 *
 *   npm run token -- <command> [options]      (run from contracts/cli)
 *
 * The same testnet-only account as the Pond Vault CLI (QORE_MNEMONIC in
 * contracts/.env) deploys the token and moves it. Every command that sends
 * anything first checks the chain is Diana, dry-runs the transaction
 * (eth_estimateGas, or a node simulation of the signed native transaction),
 * prints what it will send and the fee, and waits for "yes" (or --yes).
 * Nothing here submits a governance proposal: QoreChain registers the token.
 * Run `npm run token -- help` for the list.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { qorechainRegistry, type UnifiedAccount } from "@qorechain/sdk";
import { evmWindowCost, toQorAddress } from "@qorechain/evm";
import { formatUnits, getAddress, parseAbi, type Address, type Hex } from "viem";
import {
  broadcastNative,
  devnetRpc,
  explainEvmError,
  keyStatus,
  network,
  ownerAccount,
  publicClient,
  requireWindowFor,
  simulateNative,
  txLink,
  walletClient,
  windowStatus,
} from "./chain.js";
import { checkRegisteredKey } from "./keycheck.js";
import {
  DIANA,
  ERC20_MODULE_ADDRESS,
  QWAKK,
  TOKEN_REGISTRY_TYPES,
  assertDiana,
  bankDenomFor,
  bankSendMsg,
  convertErc20Msg,
  expectedBankMetadata,
  formatQwakk,
  metadataDifferences,
  nativeFeeFor,
  nativeGasFor,
  parseQorAddress,
  parseQwakkAmount,
  parseTokenAddress,
  type DenomMetadata,
} from "./qwakk-token.js";

const TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

// ---------------------------------------------------------------------------
// Arguments and prompts
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const BOOL_FLAGS = new Set(["--yes", "--dry-run"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !BOOL_FLAGS.has(argv[i - 1])));
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const flag = (name: string) => argv.includes(`--${name}`);

async function confirm(lines: string[]): Promise<void> {
  console.log(lines.join("\n"));
  if (flag("yes")) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type "yes" to continue: ')).trim().toLowerCase();
  rl.close();
  if (answer !== "yes") throw new Error("Stopped. Nothing was sent.");
}

const qor = (uqor: bigint) => `${formatUnits(uqor, 6)} QOR`;

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

/** Testnet only: refuse unless the endpoints themselves say QoreChain Diana (or an explicit local rehearsal node). */
async function requireDiana(): Promise<void> {
  if (devnetRpc()) return;
  if ((process.env.QORE_NETWORK?.trim() || "testnet") !== "testnet") {
    throw new Error("The QWAKK token tooling runs on QoreChain Diana only (QORE_NETWORK=testnet). Nothing was sent.");
  }
  const net = network();
  const [evmChainId, node] = await Promise.all([
    publicClient().getChainId(),
    fetch(`${net.rest}/cosmos/base/tendermint/v1beta1/node_info`).then((r) => r.json() as Promise<{ default_node_info?: { network?: string } }>),
  ]);
  assertDiana({ chainId: node.default_node_info?.network ?? "", evmChainId });
}

async function rest<T>(path: string): Promise<{ status: number; body: T | undefined }> {
  const res = await fetch(`${network().rest}${path}`);
  const body = (await res.json().catch(() => undefined)) as T | undefined;
  return { status: res.status, body };
}

type TokenPair = { erc20_address: string; denom: string; enabled: boolean; contract_owner: string };

/** The x/erc20 token pair for the contract, or null while it is not registered. */
async function tokenPair(token: string): Promise<TokenPair | null> {
  const { status, body } = await rest<{ token_pair?: TokenPair }>(`/cosmos/evm/erc20/v1/token_pairs/${token}`);
  if (status === 404) return null;
  if (status !== 200 || !body?.token_pair) throw new Error(`token pair query failed: HTTP ${status}`);
  return body.token_pair;
}

async function bankBalance(address: string, denom: string): Promise<bigint> {
  const { status, body } = await rest<{ balance?: { amount?: string } }>(`/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`);
  if (status !== 200) throw new Error(`balance query failed: HTTP ${status}`);
  return BigInt(body?.balance?.amount ?? "0");
}

async function evmBalance(token: Address, holder: Address): Promise<bigint> {
  return publicClient().readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [holder] });
}

/** Refuse unless the contract at the address is this token: name, symbol, decimals and supply. */
async function requireQwakkContract(token: Address) {
  const client = publicClient();
  const read = <T>(functionName: "name" | "symbol" | "decimals" | "totalSupply") =>
    client.readContract({ address: token, abi: TOKEN_ABI, functionName }) as Promise<T>;
  const [name, symbol, decimals, supply] = await Promise.all([read<string>("name"), read<string>("symbol"), read<number>("decimals"), read<bigint>("totalSupply")]);
  if (name !== QWAKK.name || symbol !== QWAKK.symbol || Number(decimals) !== QWAKK.decimals || supply !== QWAKK.totalSupply) {
    throw new Error(`${token} is not the QWAKK token (it reports ${name} / ${symbol} / ${decimals} decimals / supply ${supply}). Nothing was sent.`);
  }
}

function tokenAddress(): Address {
  return getAddress(parseTokenAddress(process.env.QWAKK_TOKEN_ADDRESS));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function status() {
  const acc = await ownerAccount();
  const net = network();
  const client = publicClient();
  console.log(`network   ${devnetRpc() ? `local rehearsal node ${net.evmRpc}` : `QoreChain Diana (${net.chainId}, EVM ${net.evmChainId})`}`);
  console.log(`deployer  ${acc.evm}  (${acc.cosmos})`);
  if (!devnetRpc()) {
    console.log(`  QOR     ${qor(await bankBalance(acc.cosmos, "uqor"))} (native lane)`);
    const check = checkRegisteredKey(await keyStatus(client, getAddress(acc.evm)), acc.pqc.publicKey, acc.evm);
    console.log(`  PQC key ${check.ok ? "ML-DSA-87, registered with this mnemonic's key" : check.message}`);
    const w = await windowStatus(acc);
    const scope = w.allowedTargets.length ? `scoped to ${w.allowedTargets.join(", ")}` : w.nativeOnly ? "native QOR only" : "unscoped";
    console.log(`  window  ${w.found ? `${w.live ? "live" : "not usable"}, ${scope}, ${w.remainingTxs} txs left` : "none"}`);
  }

  const raw = process.env.QWAKK_TOKEN_ADDRESS?.trim();
  if (!raw) {
    console.log("token     not deployed yet (QWAKK_TOKEN_ADDRESS is empty). Next: npm run pond -- window deploy, then npm run token -- deploy");
    return;
  }
  const token = tokenAddress();
  const read = <T>(functionName: "name" | "symbol" | "decimals" | "totalSupply") =>
    client.readContract({ address: token, abi: TOKEN_ABI, functionName }) as Promise<T>;
  const [name, symbol, decimals, supply, held, escrow] = await Promise.all([
    read<string>("name"),
    read<string>("symbol"),
    read<number>("decimals"),
    read<bigint>("totalSupply"),
    evmBalance(token, getAddress(acc.evm)),
    evmBalance(token, ERC20_MODULE_ADDRESS as Address),
  ]);
  console.log(`token     ${token}  (${toQorAddress(token)})`);
  console.log(`  ${name} / ${symbol} / ${decimals} decimals / supply ${formatQwakk(supply)}`);
  console.log(`  EVM side: deployer holds ${formatQwakk(held)} QWAKK; ${formatQwakk(escrow)} QWAKK sits in x/erc20 escrow (converted to bank coins)`);
  if (devnetRpc()) return;

  const pair = await tokenPair(token);
  const denom = bankDenomFor(token);
  if (!pair) {
    console.log(`registration  NOT registered yet. QoreChain registers it by governance (MsgRegisterERC20). Bank denom will be ${denom}`);
    return;
  }
  console.log(`registration  token pair ${pair.denom}, ${pair.enabled ? "enabled" : "DISABLED"}, ${pair.contract_owner}`);
  const meta = await rest<{ metadata?: DenomMetadata }>(`/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`);
  const diff = metadataDifferences(meta.body?.metadata, expectedBankMetadata(token, QWAKK));
  console.log(`  bank metadata ${diff.length ? `differs from the expected record: ${diff.join("; ")}` : `as expected (symbol ${QWAKK.symbol}, display ${meta.body?.metadata?.display}, ${QWAKK.decimals} decimals)`}`);
  console.log(`  bank side: deployer holds ${formatQwakk(await bankBalance(acc.cosmos, denom))} QWAKK`);
  const holder = opt("holder") ?? process.env.QWAKK_HOLDER?.trim();
  if (holder) console.log(`  bank side: ${parseQorAddress(holder, "--holder")} holds ${formatQwakk(await bankBalance(holder, denom))} QWAKK`);

  const pools = await rest<{ pools?: { id: string; token_a: string; token_b: string; reserve_a: string; reserve_b: string; creator: string }[] }>("/qorechain/amm/v1/pools?pagination.limit=200");
  const mine = (pools.body?.pools ?? []).filter((p) => p.token_a === denom || p.token_b === denom);
  if (!mine.length) console.log("pools     none yet. Create QWAKK/QOR in the Qwakk app with QoreX (see contracts/README.md)");
  for (const p of mine) console.log(`pool #${p.id}  ${p.token_a} ${p.reserve_a} / ${p.token_b} ${p.reserve_b}, creator ${p.creator}`);
}

async function deploy() {
  await requireDiana();
  if (process.env.QWAKK_TOKEN_ADDRESS?.trim()) {
    throw new Error("QWAKK_TOKEN_ADDRESS is already set: a second deploy would create a second, different token. Nothing was sent.");
  }
  const acc = await ownerAccount();
  const client = publicClient();
  if (!devnetRpc()) {
    const check = checkRegisteredKey(await keyStatus(client, getAddress(acc.evm)), acc.pqc.publicKey, acc.evm);
    if (!check.ok) throw new Error(`${check.message} Run: npm run pond -- register. Nothing was sent.`);
  }
  const artifactPath = fileURLToPath(new URL("../../out/QwakkToken.sol/QwakkToken.json", import.meta.url));
  let bytecode: Hex;
  try {
    bytecode = (JSON.parse(readFileSync(artifactPath, "utf8")) as { bytecode: { object: Hex } }).bytecode.object;
  } catch {
    throw new Error("Build the contract first: cd contracts && forge build");
  }
  const wallet = walletClient(acc);
  // Dry run: eth_estimateGas executes the constructor on the node without sending anything.
  const estimate = await client.estimateGas({ account: wallet.account, data: bytecode });
  const gas = (estimate * 13n) / 10n;
  const fees = await client.estimateFeesPerGas();
  const cap = BigInt(process.env.POND_MAX_FEE_GWEI?.trim() || "250") * 1_000_000_000n;
  const feeCap = fees.maxFeePerGas > cap ? cap : fees.maxFeePerGas;
  const priority = fees.maxPriorityFeePerGas > feeCap ? feeCap : fees.maxPriorityFeePerGas;
  const maxCost = evmWindowCost({ gas, maxFeePerGas: feeCap });
  const plan = [
    `Deploy QwakkToken to QoreChain Diana (EVM ${DIANA.evmChainId}) from ${acc.evm} (${acc.cosmos}):`,
    `  ${QWAKK.name} (${QWAKK.symbol}), ${QWAKK.decimals} decimals, ${formatQwakk(QWAKK.totalSupply)} QWAKK minted once to ${acc.evm}`,
    "  no owner, no mint, no fee, no pause, no blocklist",
    `  one EVM transaction inside the open unscoped window; dry run: ${estimate} gas, limit ${gas}, fee at most ${qor(maxCost)}`,
  ];
  if (flag("dry-run")) {
    console.log([...plan, "Dry run only: nothing was sent."].join("\n"));
    return;
  }
  await requireWindowFor(acc, "create", maxCost);
  await confirm(plan);
  let hash: Hex;
  try {
    hash = await wallet.sendTransaction({ account: wallet.account, chain: wallet.chain, data: bytecode, gas, maxFeePerGas: feeCap, maxPriorityFeePerGas: priority });
  } catch (error) {
    throw new Error(`deploy: ${explainEvmError(error)}`);
  }
  console.log(`deploy: sent ${txLink(hash)}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy reverted: ${txLink(hash)}`);
  const token = getAddress(receipt.contractAddress);
  // Print the address before any further read, so a flaky read can never hide it (and invite a second deploy).
  console.log(`Put it in contracts/.env now:   QWAKK_TOKEN_ADDRESS=${token}`);
  await requireQwakkContract(token);
  const held = await evmBalance(token, getAddress(acc.evm));
  console.log(`QwakkToken deployed at ${token} (${toQorAddress(token)}), block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
  console.log(`checked on chain: Qwakk / QWAKK / 6 decimals; ${acc.evm} holds ${formatQwakk(held)} QWAKK`);
  console.log(`Bank denom after registration: ${bankDenomFor(token)}`);
  console.log("Next: send QoreChain the registration request (contracts/README.md, QWAKK runbook).");
}

/** Dry-run a native transaction, then print the plan and wait for "yes", then send it. */
async function sendNative(acc: UnifiedAccount, messages: Parameters<typeof broadcastNative>[2], plan: string[], label: string) {
  const registry = qorechainRegistry(TOKEN_REGISTRY_TYPES);
  const simulated = await simulateNative(acc, "hybrid", messages, { registry });
  const gas = nativeGasFor(simulated);
  const fee = nativeFeeFor(gas);
  const lines = [...plan, `  Native-lane transaction signed hybrid (secp256k1 + ML-DSA-87). Dry run used ${simulated} gas; limit ${gas}, fee ${qor(fee)}.`];
  if (flag("dry-run")) {
    console.log([...lines, "Dry run only: nothing was sent."].join("\n"));
    return undefined;
  }
  await confirm(lines);
  const hash = await broadcastNative(acc, "hybrid", messages, { registry, gas, feeUqor: fee });
  console.log(`${label}: ${txLink(hash)}`);
  return hash;
}

async function convert() {
  await requireDiana();
  if (devnetRpc()) throw new Error("Conversion is a QoreChain native-lane transaction; it does not exist on a local rehearsal node.");
  const acc = await ownerAccount();
  const token = tokenAddress();
  await requireQwakkContract(token);
  const pair = await tokenPair(token);
  if (!pair) throw new Error(`${token} is not registered yet: QoreChain registers it by governance first. Nothing was sent.`);
  if (!pair.enabled) throw new Error("The QWAKK token pair is disabled on chain. Nothing was sent.");
  const denom = pair.denom;
  if (denom !== bankDenomFor(token)) throw new Error(`Unexpected bank denom ${denom}. Nothing was sent.`);
  const held = await evmBalance(token, getAddress(acc.evm));
  const amount = parseQwakkAmount(positional[1], held);
  const receiver = opt("to") ? parseQorAddress(opt("to"), "--to") : acc.cosmos;
  const before = await bankBalance(receiver, denom);
  const msg = convertErc20Msg({ token, amount, sender: acc.cosmos, receiver });
  const hash = await sendNative(
    acc,
    [msg],
    [
      `Convert ${formatQwakk(amount)} QWAKK from the EVM side of ${acc.evm} into the bank coin ${denom}`,
      `  MsgConvertERC20: sender ${acc.cosmos}, receiver ${receiver}${receiver === acc.cosmos ? " (this account)" : ""}, amount ${amount} base units`,
      `  The ERC-20 moves to x/erc20 escrow ${ERC20_MODULE_ADDRESS}; the chain mints the same amount as bank coins. No EVM window needed.`,
    ],
    "converted",
  );
  if (!hash) return;
  await new Promise((r) => setTimeout(r, 6000));
  console.log(`bank balance of ${receiver}: ${formatQwakk(before)} -> ${formatQwakk(await bankBalance(receiver, denom))} QWAKK`);
}

async function send() {
  await requireDiana();
  if (devnetRpc()) throw new Error("Bank sends are QoreChain native-lane transactions; they do not exist on a local rehearsal node.");
  const acc = await ownerAccount();
  const token = tokenAddress();
  const pair = await tokenPair(token);
  if (!pair) throw new Error(`${token} is not registered yet, so there is no bank QWAKK to send. Nothing was sent.`);
  const denom = pair.denom;
  const to = parseQorAddress(opt("to"), "--to");
  if (to === acc.cosmos) throw new Error("--to is this account itself. Nothing was sent.");
  const held = await bankBalance(acc.cosmos, denom);
  const amount = parseQwakkAmount(positional[1], held);
  const before = await bankBalance(to, denom);
  const hash = await sendNative(
    acc,
    [bankSendMsg({ denom, amount, from: acc.cosmos, to })],
    [
      `Send ${formatQwakk(amount)} QWAKK (bank coin ${denom}) from ${acc.cosmos} to ${to}`,
      `  MsgSend of ${amount} base units. The deployer keeps ${formatQwakk(held - amount)} QWAKK.`,
    ],
    "sent",
  );
  if (!hash) return;
  await new Promise((r) => setTimeout(r, 6000));
  console.log(`bank balance of ${to}: ${formatQwakk(before)} -> ${formatQwakk(await bankBalance(to, denom))} QWAKK`);
}

function help() {
  console.log(`QWAKK token CLI (QoreChain Diana, testnet only)

  status [--holder qor1..]                 deployer, window, token, registration, bank balances, pools
  deploy                                   deploy QwakkToken (needs: npm run pond -- window deploy)
  convert <QWAKK|all> [--to qor1..]        EVM QWAKK to bank QWAKK (after QoreChain registers the token)
  send <QWAKK|all> --to qor1..             send bank QWAKK to a qor1 address (for example your QoreX wallet)

  --dry-run   deploy, convert and send: estimate or simulate on the node and print the plan, send nothing
  --yes       skip the confirmation prompt
  env: QORE_MNEMONIC (testnet-only deployer), QWAKK_TOKEN_ADDRESS (after deploy), optional QWAKK_HOLDER`);
}

const commands: Record<string, () => Promise<unknown>> = {
  status,
  deploy,
  convert,
  send,
  help: async () => help(),
};

const run = commands[positional[0] ?? "help"];
if (!run) {
  help();
  process.exitCode = 1;
} else {
  run().catch((error: unknown) => {
    // viem errors carry a one-line shortMessage; never dump a multi-line node answer.
    const e = error as { shortMessage?: string; message?: string };
    console.error((e?.shortMessage ?? e?.message ?? String(error)).split("\n")[0]);
    process.exitCode = 1;
  });
}


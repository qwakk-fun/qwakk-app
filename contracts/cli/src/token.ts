/**
 * token: deploy, register and move QWAKK (Qwakk's meme token) or QCAT (the
 * QCAT community meme token) on QoreChain Diana.
 *
 *   npm run token -- <command> [--token qwakk|qcat] [options]      (run from contracts/cli)
 *
 * The same testnet-only account as the Pond Vault CLI (QORE_MNEMONIC in
 * contracts/.env) deploys the token and moves it. Every command that sends
 * anything first checks the chain is Diana, dry-runs the transaction
 * (eth_estimateGas, or a node simulation of the signed native transaction),
 * prints what it will send and the fee, and waits for "yes" (or --yes).
 * `propose` submits the MsgRegisterERC20 governance proposal from the
 * deployer; validators still have to vote it through.
 * Without --token the CLI works on QWAKK, exactly as before.
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
  GOV_MODULE_ADDRESS,
  MSG_REGISTER_ERC20_TYPE_URL,
  TOKEN_REGISTRY_TYPES,
  assertDiana,
  bankDenomFor,
  bankSendMsg,
  convertErc20Msg,
  expectedBankMetadata,
  formatTokenAmount,
  metadataDifferences,
  nativeFeeFor,
  nativeGasFor,
  parseQorAddress,
  parseTokenAddress,
  parseTokenAmount,
  registrationProposalMsg,
  tokenSpec,
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
const BOOL_FLAGS = new Set(["--yes", "--dry-run", "--expedited"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !BOOL_FLAGS.has(argv[i - 1])));
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const flag = (name: string) => argv.includes(`--${name}`);

/** The token this run works on: --token qwakk (default) or --token qcat. */
const TOKEN = tokenSpec(opt("token"));
const SYM = TOKEN.symbol;
const fmt = (base: bigint) => formatTokenAmount(base, TOKEN.decimals);
const parseAmount = (raw: string | undefined, available: bigint) => parseTokenAmount(raw, available, TOKEN);
/** `--token qcat` for QCAT commands, nothing for QWAKK, so printed next steps can be pasted as they are. */
const TOKEN_ARG = TOKEN.key === "qwakk" ? "" : ` --token ${TOKEN.key}`;

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
    throw new Error("The token tooling runs on QoreChain Diana only (QORE_NETWORK=testnet). Nothing was sent.");
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
async function requireTokenContract(token: Address) {
  const client = publicClient();
  const read = <T>(functionName: "name" | "symbol" | "decimals" | "totalSupply") =>
    client.readContract({ address: token, abi: TOKEN_ABI, functionName }) as Promise<T>;
  const [name, symbol, decimals, supply] = await Promise.all([read<string>("name"), read<string>("symbol"), read<number>("decimals"), read<bigint>("totalSupply")]);
  if (name !== TOKEN.name || symbol !== TOKEN.symbol || Number(decimals) !== TOKEN.decimals || supply !== TOKEN.totalSupply) {
    throw new Error(`${token} is not the ${SYM} token (it reports ${name} / ${symbol} / ${decimals} decimals / supply ${supply}). Nothing was sent.`);
  }
}

function tokenAddress(): Address {
  return getAddress(parseTokenAddress(process.env[TOKEN.addressEnv], TOKEN.addressEnv));
}

type TxResult = { height: string; code: number; gasUsed: string; events: { type: string; attributes: { key: string; value: string }[] }[] };

/** The committed result of a transaction, read back from the node (polls for up to about a minute). */
async function txResult(hash: string): Promise<TxResult | undefined> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const { status, body } = await rest<{ tx_response?: { height: string; code: number; gas_used: string; events?: TxResult["events"] } }>(`/cosmos/tx/v1beta1/txs/${hash}`);
    const t = body?.tx_response;
    if (status === 200 && t) return { height: t.height, code: t.code, gasUsed: t.gas_used, events: t.events ?? [] };
  }
  return undefined;
}

async function printTxResult(label: string, hash: string): Promise<TxResult | undefined> {
  const result = await txResult(hash);
  console.log(result ? `${label}: height ${result.height}, code ${result.code}, gas used ${result.gasUsed}` : `${label}: not found on the node yet, check ${txLink(hash)}`);
  return result;
}

type Proposal = { id: string; status: string; messages?: { "@type"?: string; erc20addresses?: string[] }[]; voting_end_time?: string; expedited?: boolean };

/** Registration proposals on chain that list this contract (any status), newest first. */
async function registrationProposalsFor(token: string): Promise<Proposal[]> {
  const { status, body } = await rest<{ proposals?: Proposal[] }>("/cosmos/gov/v1/proposals?pagination.limit=500&pagination.reverse=true");
  if (status !== 200) throw new Error(`proposal query failed: HTTP ${status}`);
  return (body?.proposals ?? []).filter((p) =>
    (p.messages ?? []).some((m) => m["@type"] === MSG_REGISTER_ERC20_TYPE_URL && (m.erc20addresses ?? []).some((a) => a.toLowerCase() === token.toLowerCase())),
  );
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

  const raw = process.env[TOKEN.addressEnv]?.trim();
  if (!raw) {
    console.log(`token     ${SYM} not deployed yet (${TOKEN.addressEnv} is empty). Next: npm run pond -- window deploy, then npm run token -- deploy${TOKEN_ARG}`);
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
  console.log(`  ${name} / ${symbol} / ${decimals} decimals / supply ${fmt(supply)}`);
  console.log(`  EVM side: deployer holds ${fmt(held)} ${SYM}; ${fmt(escrow)} ${SYM} sits in x/erc20 escrow (converted to bank coins)`);
  if (devnetRpc()) return;

  const pair = await tokenPair(token);
  const denom = bankDenomFor(token);
  if (!pair) {
    const proposals = await registrationProposalsFor(token);
    const list = proposals.map((p) => `#${p.id} ${p.status.replace("PROPOSAL_STATUS_", "").toLowerCase()}${p.status === "PROPOSAL_STATUS_VOTING_PERIOD" ? ` (voting ends ${p.voting_end_time})` : ""}`).join(", ");
    console.log(`registration  NOT registered yet (governance: MsgRegisterERC20). Proposals: ${list || `none. Next: npm run token -- propose${TOKEN_ARG}`}. Bank denom will be ${denom}`);
    return;
  }
  console.log(`registration  token pair ${pair.denom}, ${pair.enabled ? "enabled" : "DISABLED"}, ${pair.contract_owner}`);
  const meta = await rest<{ metadata?: DenomMetadata }>(`/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`);
  const diff = metadataDifferences(meta.body?.metadata, expectedBankMetadata(token, TOKEN));
  console.log(`  bank metadata ${diff.length ? `differs from the expected record: ${diff.join("; ")}` : `as expected (symbol ${TOKEN.symbol}, display ${meta.body?.metadata?.display}, ${TOKEN.decimals} decimals)`}`);
  console.log(`  bank side: deployer holds ${fmt(await bankBalance(acc.cosmos, denom))} ${SYM}`);
  const holder = opt("holder") ?? process.env.QWAKK_HOLDER?.trim();
  if (holder) console.log(`  bank side: ${parseQorAddress(holder, "--holder")} holds ${fmt(await bankBalance(holder, denom))} ${SYM}`);

  const pools = await rest<{ pools?: { id: string; token_a: string; token_b: string; reserve_a: string; reserve_b: string; creator: string }[] }>("/qorechain/amm/v1/pools?pagination.limit=200");
  const mine = (pools.body?.pools ?? []).filter((p) => p.token_a === denom || p.token_b === denom);
  if (!mine.length) console.log(`pools     none yet. Create ${SYM}/QOR in the Qwakk app with QoreX (see contracts/README.md)`);
  for (const p of mine) console.log(`pool #${p.id}  ${p.token_a} ${p.reserve_a} / ${p.token_b} ${p.reserve_b}, creator ${p.creator}`);
}

async function deploy() {
  await requireDiana();
  if (process.env[TOKEN.addressEnv]?.trim()) {
    throw new Error(`${TOKEN.addressEnv} is already set: a second deploy would create a second, different token. Nothing was sent.`);
  }
  const acc = await ownerAccount();
  const client = publicClient();
  if (!devnetRpc()) {
    const check = checkRegisteredKey(await keyStatus(client, getAddress(acc.evm)), acc.pqc.publicKey, acc.evm);
    if (!check.ok) throw new Error(`${check.message} Run: npm run pond -- register. Nothing was sent.`);
  }
  const artifactPath = fileURLToPath(new URL(`../../out/${TOKEN.contract}.sol/${TOKEN.contract}.json`, import.meta.url));
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
    `Deploy ${TOKEN.contract} to QoreChain Diana (EVM ${DIANA.evmChainId}) from ${acc.evm} (${acc.cosmos}):`,
    `  ${TOKEN.name} (${TOKEN.symbol}), ${TOKEN.decimals} decimals, ${fmt(TOKEN.totalSupply)} ${SYM} minted once to ${acc.evm}`,
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
  console.log(`Put it in contracts/.env now:   ${TOKEN.addressEnv}=${token}`);
  await requireTokenContract(token);
  const held = await evmBalance(token, getAddress(acc.evm));
  console.log(`${TOKEN.contract} deployed at ${token} (${toQorAddress(token)}), block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
  console.log(`checked on chain: ${TOKEN.name} / ${SYM} / ${TOKEN.decimals} decimals; ${acc.evm} holds ${fmt(held)} ${SYM}`);
  console.log(`Bank denom after registration: ${bankDenomFor(token)}`);
  console.log(`Next: npm run token -- propose${TOKEN_ARG} (contracts/README.md, runbook).`);
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
  const result = await printTxResult(label, hash);
  return { hash, result };
}

async function convert() {
  await requireDiana();
  if (devnetRpc()) throw new Error("Conversion is a QoreChain native-lane transaction; it does not exist on a local rehearsal node.");
  const acc = await ownerAccount();
  const token = tokenAddress();
  await requireTokenContract(token);
  const pair = await tokenPair(token);
  if (!pair) throw new Error(`${token} is not registered yet: its governance proposal has to pass first. Nothing was sent.`);
  if (!pair.enabled) throw new Error(`The ${SYM} token pair is disabled on chain. Nothing was sent.`);
  const denom = pair.denom;
  if (denom !== bankDenomFor(token)) throw new Error(`Unexpected bank denom ${denom}. Nothing was sent.`);
  const held = await evmBalance(token, getAddress(acc.evm));
  const amount = parseAmount(positional[1], held);
  const receiver = opt("to") ? parseQorAddress(opt("to"), "--to") : acc.cosmos;
  const before = await bankBalance(receiver, denom);
  const msg = convertErc20Msg({ token, amount, sender: acc.cosmos, receiver });
  const sent = await sendNative(
    acc,
    [msg],
    [
      `Convert ${fmt(amount)} ${SYM} from the EVM side of ${acc.evm} into the bank coin ${denom}`,
      `  MsgConvertERC20: sender ${acc.cosmos}, receiver ${receiver}${receiver === acc.cosmos ? " (this account)" : ""}, amount ${amount} base units`,
      `  The ERC-20 moves to x/erc20 escrow ${ERC20_MODULE_ADDRESS}; the chain mints the same amount as bank coins. No EVM window needed.`,
    ],
    "converted",
  );
  if (!sent) return;
  console.log(`bank balance of ${receiver}: ${fmt(before)} -> ${fmt(await bankBalance(receiver, denom))} ${SYM}`);
}

async function send() {
  await requireDiana();
  if (devnetRpc()) throw new Error("Bank sends are QoreChain native-lane transactions; they do not exist on a local rehearsal node.");
  const acc = await ownerAccount();
  const token = tokenAddress();
  const pair = await tokenPair(token);
  if (!pair) throw new Error(`${token} is not registered yet, so there is no bank ${SYM} to send. Nothing was sent.`);
  const denom = pair.denom;
  const to = parseQorAddress(opt("to"), "--to");
  if (to === acc.cosmos) throw new Error("--to is this account itself. Nothing was sent.");
  const held = await bankBalance(acc.cosmos, denom);
  const amount = parseAmount(positional[1], held);
  const before = await bankBalance(to, denom);
  const sent = await sendNative(
    acc,
    [bankSendMsg({ denom, amount, from: acc.cosmos, to })],
    [
      `Send ${fmt(amount)} ${SYM} (bank coin ${denom}) from ${acc.cosmos} to ${to}`,
      `  MsgSend of ${amount} base units. The deployer keeps ${fmt(held - amount)} ${SYM}.`,
    ],
    "sent",
  );
  if (!sent) return;
  console.log(`bank balance of ${to}: ${fmt(before)} -> ${fmt(await bankBalance(to, denom))} ${SYM}`);
}

type GovParams = { min_deposit: { denom: string; amount: string }[]; expedited_min_deposit: { denom: string; amount: string }[]; voting_period: string; expedited_voting_period: string };

/**
 * Submit the registration proposal (cosmos.gov.v1.MsgSubmitProposal with one
 * MsgRegisterERC20 for this contract) from the deployer, as a hybrid-signed
 * Native-lane transaction, like Diana proposal 38. Uses the live minimum
 * deposit: the normal one by default, the expedited one with --expedited.
 * Validators still have to vote it through; nothing here votes.
 */
async function propose() {
  await requireDiana();
  if (devnetRpc()) throw new Error("Governance proposals only exist on QoreChain.");
  const acc = await ownerAccount();
  const token = tokenAddress();
  await requireTokenContract(token);
  if (await tokenPair(token)) throw new Error(`${token} is already registered. Nothing was sent.`);
  // One proposal per address: a second one fails on execution (Diana proposal 24, a duplicate of 26).
  const existing = (await registrationProposalsFor(token)).filter((p) => p.status !== "PROPOSAL_STATUS_REJECTED" && p.status !== "PROPOSAL_STATUS_FAILED");
  if (existing.length) throw new Error(`Proposal #${existing[0].id} (${existing[0].status}) already registers ${token}. Nothing was sent.`);

  const gov = await rest<{ account?: { base_account?: { address?: string }; address?: string } }>("/cosmos/auth/v1beta1/module_accounts/gov");
  const govAddress = gov.body?.account?.base_account?.address ?? gov.body?.account?.address;
  if (govAddress !== GOV_MODULE_ADDRESS) throw new Error(`The node reports gov module ${govAddress ?? "unknown"}, not ${GOV_MODULE_ADDRESS}. Nothing was sent.`);
  const { status, body } = await rest<{ params?: GovParams }>("/cosmos/gov/v1/params/deposit");
  if (status !== 200 || !body?.params) throw new Error(`gov params query failed: HTTP ${status}`);
  const expedited = flag("expedited");
  const minimum = (expedited ? body.params.expedited_min_deposit : body.params.min_deposit).find((c) => c.denom === "uqor");
  if (!minimum) throw new Error("The chain lists no uqor minimum deposit. Nothing was sent.");
  const deposit = BigInt(minimum.amount);
  const balance = await bankBalance(acc.cosmos, "uqor");
  if (balance < deposit + 200_000n) throw new Error(`The deployer has ${qor(balance)}; the deposit is ${qor(deposit)} plus the fee. Nothing was sent.`);

  const msg = registrationProposalMsg({ token, spec: TOKEN, proposer: acc.cosmos, depositUqor: deposit, expedited });
  const sent = await sendNative(
    acc,
    [msg],
    [
      `Submit a governance proposal on QoreChain Diana from ${acc.cosmos}:`,
      `  "${msg.value.title}"`,
      `  MsgRegisterERC20 for ${token} only, signer ${GOV_MODULE_ADDRESS} (the gov module). Expected denom ${bankDenomFor(token)}.`,
      `  ${expedited ? "Expedited" : "Normal"} proposal, initial deposit ${qor(deposit)} (the live minimum), voting period ${expedited ? body.params.expedited_voting_period : body.params.voting_period}.`,
      "  The deposit comes back when the proposal passes or is rejected without a veto. Validators still have to vote.",
    ],
    "proposal submitted",
  );
  if (!sent) return;
  const id = sent.result?.events.find((e) => e.type === "submit_proposal")?.attributes.find((a) => a.key === "proposal_id")?.value;
  if (!id) {
    console.log(`Check the proposal id at ${txLink(sent.hash)}`);
    return;
  }
  const proposal = await rest<{ proposal?: Proposal }>(`/cosmos/gov/v1/proposals/${id}`);
  console.log(`proposal #${id}: ${proposal.body?.proposal?.status ?? "unknown"}, voting ends ${proposal.body?.proposal?.voting_end_time ?? "unknown"}`);
  console.log(`Next: once it passes, npm run token -- convert all${TOKEN_ARG}`);
}

function help() {
  console.log(`Token CLI for QWAKK and QCAT (QoreChain Diana, testnet only)

  status [--holder qor1..]                 deployer, window, token, registration, bank balances, pools
  deploy                                   deploy the token contract (needs: npm run pond -- window deploy)
  propose [--expedited]                    submit the MsgRegisterERC20 proposal (live minimum deposit)
  convert <amount|all> [--to qor1..]       EVM balance to bank coin (after the proposal passes)
  send <amount|all> --to qor1..            send the bank coin to a qor1 address (for example your QoreX wallet)

  --token     qwakk (default) or qcat
  --dry-run   deploy, propose, convert and send: estimate or simulate on the node and print the plan, send nothing
  --yes       skip the confirmation prompt
  env: QORE_MNEMONIC (testnet-only deployer), QWAKK_TOKEN_ADDRESS or QCAT_TOKEN_ADDRESS (after deploy), optional QWAKK_HOLDER`);
}

const commands: Record<string, () => Promise<unknown>> = {
  status,
  deploy,
  propose,
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


/**
 * rewards: store, instantiate and feed the qwakk-rewards CosmWasm contract
 * (contracts/rewards) on QoreChain Diana.
 *
 *   npm run rewards -- <command> [options]      (run from contracts/cli)
 *
 * The same testnet-only deployer as the other CLIs (QORE_MNEMONIC in
 * contracts/.env) signs hybrid (secp256k1 + ML-DSA-87) native transactions.
 * Every command that sends first checks the chain is Diana, simulates the
 * signed transaction on the node, prints the plan and fee, and waits for
 * "yes" (or --yes). --dry-run stops after the simulation.
 * Run `npm run rewards -- help` for the list.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { qorechainRegistry, type UnifiedAccount } from "@qorechain/sdk";
import { formatUnits } from "viem";
import { broadcastNative, network, ownerAccount, simulateNative, txLink } from "./chain.js";
import { DIANA, GOV_MODULE_ADDRESS, TOKEN_REGISTRY_TYPES, nativeFeeFor, nativeGasFor } from "./qwakk-token.js";
import {
  MSG_STORE_CODE,
  OPTIMIZER_IMAGE,
  REWARDS_REGISTRY_TYPES,
  assertGzipRoundTrip,
  checkStageAgainstContract,
  claimMsg,
  compareWithReference,
  executeMsg,
  gzipWasm,
  instantiateMsg,
  parseStageFile,
  registerStageBody,
  registerStageMsg,
  sha256Hex,
  storeCodeProposalMsg,
  storeCodeProposalShape,
} from "./rewards-lib.js";

const argv = process.argv.slice(2);
const BOOL_FLAGS = new Set(["--yes", "--dry-run", "--normal"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !BOOL_FLAGS.has(argv[i - 1])));
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);
const qor = (uqor: bigint) => `${formatUnits(uqor, 6)} QOR`;

const REWARDS_DIR = new URL("../../rewards/", import.meta.url);
/** Diana's own store-and-instantiate proposal, the shape this one follows (docs: governance-proposals-contracts). */
const REFERENCE_PROPOSAL = 40;
/** "A Cosmos transaction may not set a gas limit above 50,000,000" (docs: cosmwasm-gas-and-limits). */
const MAX_TX_GAS = 50_000_000n;

const registry = () => qorechainRegistry([...TOKEN_REGISTRY_TYPES, ...REWARDS_REGISTRY_TYPES]);

async function confirm(lines: string[]): Promise<void> {
  console.log(lines.join("\n"));
  if (flag("yes")) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type "yes" to continue: ')).trim().toLowerCase();
  rl.close();
  if (answer !== "yes") throw new Error("Stopped. Nothing was sent.");
}

async function rest<T>(path: string): Promise<{ status: number; body: T | undefined }> {
  const res = await fetch(`${network().rest}${path}`);
  return { status: res.status, body: (await res.json().catch(() => undefined)) as T | undefined };
}

async function requireDiana() {
  const { body } = await rest<{ default_node_info?: { network?: string } }>("/cosmos/base/tendermint/v1beta1/node_info");
  const chainId = body?.default_node_info?.network ?? "";
  if (chainId !== DIANA.chainId) throw new Error(`The rewards contract runs on QoreChain Diana only; this endpoint reports ${chainId || "an unknown chain"}. Nothing was sent.`);
}

async function uqorBalance(address: string) {
  const { body } = await rest<{ balance?: { amount?: string } }>(`/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uqor`);
  return BigInt(body?.balance?.amount ?? "0");
}

async function bankBalance(address: string, denom: string) {
  const { body } = await rest<{ balance?: { amount?: string } }>(`/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`);
  return BigInt(body?.balance?.amount ?? "0");
}

async function smart<T>(contract: string, query: unknown): Promise<T> {
  const encoded = Buffer.from(JSON.stringify(query)).toString("base64");
  const { status, body } = await rest<{ data?: T; message?: string }>(`/cosmwasm/wasm/v1/contract/${contract}/smart/${encoded}`);
  if (status !== 200 || body?.data === undefined) throw new Error(`contract query failed: ${(body?.message ?? `HTTP ${status}`).slice(0, 200)}`);
  return body.data;
}

async function blockSeconds(): Promise<bigint> {
  const { body } = await rest<{ block?: { header?: { time?: string } } }>("/cosmos/base/tendermint/v1beta1/blocks/latest");
  const ms = Date.parse(body?.block?.header?.time ?? "");
  if (!Number.isFinite(ms)) throw new Error("could not read the latest block time");
  return BigInt(Math.floor(ms / 1000));
}

function contractAddress(): string {
  const value = (opt("contract") ?? process.env.QWAKK_REWARDS_CONTRACT_ADDRESS)?.trim();
  if (!value) throw new Error("Set QWAKK_REWARDS_CONTRACT_ADDRESS in contracts/.env (printed by `npm run rewards -- instantiate`), or pass --contract.");
  return value;
}

type TxEvents = { tx_response?: { code?: number; events?: { type: string; attributes: { key: string; value: string }[] }[] } };

async function waitTx(hash: string): Promise<TxEvents["tx_response"] | undefined> {
  for (let i = 0; i < 30; i += 1) {
    const { status, body } = await rest<TxEvents>(`/cosmos/tx/v1beta1/txs/${hash}`);
    if (status === 200 && body?.tx_response) return body.tx_response;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return undefined;
}

/** Simulate, print the plan, confirm, send. Returns undefined on --dry-run. */
async function send(acc: UnifiedAccount, messages: Parameters<typeof broadcastNative>[2], plan: string[], label: string, extraUqor = 0n) {
  const simulated = await simulateNative(acc, "hybrid", messages, { registry: registry() });
  const gas = nativeGasFor(simulated);
  if (gas > MAX_TX_GAS) throw new Error(`The transaction needs ${gas} gas, above Diana's ${MAX_TX_GAS} per-transaction cap. Nothing was sent.`);
  const fee = nativeFeeFor(gas);
  const balance = await uqorBalance(acc.cosmos);
  const lines = [
    ...plan,
    `  Native-lane transaction from ${acc.cosmos}, signed hybrid (secp256k1 + ML-DSA-87).`,
    `  Simulated on the node: ${simulated} gas. Limit ${gas} (1.3x), fee ${qor(fee)} (0.125 uqor per gas).`,
    `  Balance ${qor(balance)}; this needs ${qor(fee + extraUqor)}${extraUqor ? ` (fee plus ${qor(extraUqor)})` : ""}, leaving ${qor(balance - fee - extraUqor)}.`,
  ];
  if (balance < fee + extraUqor) throw new Error([...lines, "Not enough QOR. Nothing was sent."].join("\n"));
  if (flag("dry-run")) {
    console.log([...lines, "Dry run only: nothing was sent."].join("\n"));
    return undefined;
  }
  await confirm(lines);
  const hash = await broadcastNative(acc, "hybrid", messages, { registry: registry(), gas, feeUqor: fee });
  console.log(`${label}: ${txLink(hash)}`);
  return { hash, result: await waitTx(hash) };
}

const eventValue = (result: TxEvents["tx_response"], type: string, key: string) =>
  result?.events?.find((e) => e.type === type && e.attributes.some((a) => a.key === key))?.attributes.find((a) => a.key === key)?.value;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

type GovParams = { min_deposit: { denom: string; amount: string }[]; expedited_min_deposit: { denom: string; amount: string }[]; voting_period: string; expedited_voting_period: string; threshold: string; expedited_threshold: string };

/** Submit (or with --dry-run, only simulate) the store-code proposal. Expedited unless --normal. */
async function propose() {
  await requireDiana();
  const acc = await ownerAccount();
  const wasmPath = opt("wasm") ? new URL(opt("wasm") as string, `file://${process.cwd()}/`) : new URL("artifacts/qwakk_rewards.wasm", REWARDS_DIR);
  const wasm = new Uint8Array(readFileSync(wasmPath));
  const checksum = sha256Hex(wasm);
  const listed = readFileSync(new URL("artifacts/checksums.txt", REWARDS_DIR), "utf8").split(/\s+/)[0];
  if (!opt("wasm") && listed !== checksum) throw new Error(`artifacts/qwakk_rewards.wasm (${checksum}) does not match artifacts/checksums.txt (${listed}). Rebuild with ${OPTIMIZER_IMAGE}. Nothing was sent.`);
  const version = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(new URL("Cargo.toml", REWARDS_DIR), "utf8"))?.[1] ?? "unknown";
  const gz = gzipWasm(wasm);
  assertGzipRoundTrip(gz, wasm);

  // Live chain state the proposal relies on.
  const gov = await rest<{ account?: { base_account?: { address?: string }; address?: string } }>("/cosmos/auth/v1beta1/module_accounts/gov");
  const govAddress = gov.body?.account?.base_account?.address ?? gov.body?.account?.address;
  if (govAddress !== GOV_MODULE_ADDRESS) throw new Error(`The node reports gov module ${govAddress ?? "unknown"}, not ${GOV_MODULE_ADDRESS}. Nothing was sent.`);
  const breaker = await rest<{ disabled_list?: string[] }>("/cosmos/circuit/v1/disable_list");
  const tripped = breaker.body?.disabled_list?.includes(MSG_STORE_CODE) ?? false;
  const wasmParams = await rest<{ params?: { code_upload_access?: { permission?: string }; instantiate_default_permission?: string } }>("/cosmwasm/wasm/v1/codes/params");
  const { status, body } = await rest<{ params?: GovParams }>("/cosmos/gov/v1/params/deposit");
  if (status !== 200 || !body?.params) throw new Error(`gov params query failed: HTTP ${status}`);
  const expedited = !flag("normal");
  const minimum = (expedited ? body.params.expedited_min_deposit : body.params.min_deposit).find((c) => c.denom === "uqor");
  if (!minimum) throw new Error("The chain lists no uqor minimum deposit. Nothing was sent.");
  const deposit = BigInt(minimum.amount);

  // Same structure as Diana proposal 40's store-code part.
  const reference = await rest<{ proposal?: { messages?: Record<string, unknown>[] } }>(`/cosmos/gov/v1/proposals/${REFERENCE_PROPOSAL}`);
  const diffs = compareWithReference(storeCodeProposalShape(gz), (reference.body?.proposal?.messages ?? []).slice(0, 3));
  if (diffs.length) throw new Error([`The proposal differs from Diana proposal ${REFERENCE_PROPOSAL}:`, ...diffs, "Nothing was sent."].join("\n"));

  const msg = storeCodeProposalMsg({ wasm, version, proposer: acc.cosmos, depositUqor: deposit, expedited });
  const sent = await send(
    acc,
    [msg],
    [
      `Submit a governance proposal on QoreChain Diana: "${msg.value.title}"`,
      `  Summary: ${msg.value.summary}`,
      `  Code: qwakk-rewards ${version}, sha256 ${checksum}, ${wasm.length} bytes (${gz.length} bytes gzip in the proposal, gzip sha256 ${sha256Hex(gz)}).`,
      `  Messages (signer ${GOV_MODULE_ADDRESS}, the gov module), matching Diana proposal ${REFERENCE_PROPOSAL} message by message:`,
      ...storeCodeProposalShape(gz).map((m, i) => `    ${i + 1}. ${JSON.stringify(m)}`),
      `  Live: MsgStoreCode breaker ${tripped ? "tripped (as expected)" : "NOT tripped (the reset is harmless, the trip closes it)"}; code_upload_access ${wasmParams.body?.params?.code_upload_access?.permission ?? "?"}; instantiate_default_permission ${wasmParams.body?.params?.instantiate_default_permission ?? "?"}.`,
      `  ${expedited ? "Expedited" : "Normal"} proposal: initial deposit ${qor(deposit)} (the live minimum), voting period ${expedited ? body.params.expedited_voting_period : body.params.voting_period}, yes threshold ${expedited ? body.params.expedited_threshold : body.params.threshold}${expedited ? " (a failed expedited tally continues as a normal proposal)" : ""}.`,
      "  The deposit comes back when the proposal passes or is rejected without a veto. Validators still have to vote.",
    ],
    "proposal submitted",
    deposit,
  );
  if (!sent) return;
  const id = eventValue(sent.result, "submit_proposal", "proposal_id");
  console.log(id ? `proposal #${id}. After it passes: npm run rewards -- code-id` : `Check the proposal id at ${txLink(sent.hash)}`);
}

/** Finds the code id stored for the artifact's checksum (newest codes first). */
async function codeId() {
  await requireDiana();
  const checksum = sha256Hex(new Uint8Array(readFileSync(new URL("artifacts/qwakk_rewards.wasm", REWARDS_DIR)))).toUpperCase();
  const { body } = await rest<{ code_infos?: { code_id: string; data_hash: string; instantiate_permission?: { permission?: string } }[] }>("/cosmwasm/wasm/v1/code?pagination.reverse=true&pagination.limit=50");
  const match = body?.code_infos?.find((c) => c.data_hash.toUpperCase() === checksum);
  console.log(match ? `code ${match.code_id} (checksum ${checksum}, instantiate ${match.instantiate_permission?.permission ?? "?"}). Next: npm run rewards -- instantiate --code-id ${match.code_id} --owner qor1...` : `No code with checksum ${checksum} among the newest 50. Has the proposal passed?`);
}

async function instantiate() {
  await requireDiana();
  const acc = await ownerAccount();
  const id = BigInt(opt("code-id") ?? "0");
  const owner = opt("owner") ?? acc.cosmos;
  const adminOpt = opt("admin");
  const admin = adminOpt === "none" ? "" : adminOpt ?? owner;
  const code = await rest<{ code_info?: { data_hash?: string } }>(`/cosmwasm/wasm/v1/code/${id}`);
  const expected = sha256Hex(new Uint8Array(readFileSync(new URL("artifacts/qwakk_rewards.wasm", REWARDS_DIR)))).toUpperCase();
  if (code.body?.code_info?.data_hash?.toUpperCase() !== expected) throw new Error(`Code ${id} is not this artifact (checksum ${expected}). Nothing was sent.`);
  const msg = instantiateMsg({ sender: acc.cosmos, codeId: id, owner, admin, label: opt("label") });
  const sent = await send(
    acc,
    [msg],
    [
      `Instantiate qwakk-rewards code ${id}: owner ${owner}, wasm admin ${admin || "none (not migratable)"}, label "${msg.value.label}".`,
      "  The owner registers, pauses and reclaims stages; the admin can migrate the contract to a newer stored code.",
    ],
    "instantiated",
  );
  if (!sent) return;
  const address = eventValue(sent.result, "instantiate", "_contract_address");
  console.log(address ? `Put it in contracts/.env and in the app and indexer env: QWAKK_REWARDS_CONTRACT_ADDRESS=${address}` : `Find the contract address at ${txLink(sent.hash)}`);
}

type Config = { owner: string; pending_owner: string | null; stage_count: number };

async function register() {
  await requireDiana();
  const acc = await ownerAccount();
  const file = positional[1];
  if (!file) throw new Error("Usage: npm run rewards -- register <stage.json> (from npm run rewards -- finalize ... --out stage.json in the indexer)");
  const stage = parseStageFile(readFileSync(file, "utf8"));
  const contract = contractAddress();
  const config = await smart<Config>(contract, { config: {} });
  if (config.owner !== acc.cosmos) throw new Error(`The contract owner is ${config.owner}, not this deployer ${acc.cosmos}. Register from the owner's wallet. Nothing was sent.`);
  checkStageAgainstContract(stage, { stageCount: BigInt(config.stage_count), nowSeconds: await blockSeconds() });
  const held = await bankBalance(acc.cosmos, stage.denom);
  if (held < stage.total) throw new Error(`The deployer holds ${held} ${stage.denom}; the stage needs ${stage.total}. Nothing was sent.`);
  const extra = stage.denom === "uqor" ? stage.total : 0n;
  await send(
    acc,
    [registerStageMsg({ sender: acc.cosmos, contract, stage })],
    [
      `Register stage ${stage.stageId} on ${contract}, funded with exactly ${stage.total} ${stage.denom}:`,
      `  ${registerStageBody(stage)}`,
      `  Claims open ${new Date(Number(stage.start) * 1000).toISOString()} and close ${new Date(Number(stage.end) * 1000).toISOString()}.`,
    ],
    "stage registered",
    extra,
  );
}

async function claim() {
  await requireDiana();
  const acc = await ownerAccount();
  const contract = contractAddress();
  const proof = (opt("proof") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const msg = claimMsg({ sender: acc.cosmos, contract, stageId: BigInt(opt("stage") ?? "0"), amount: BigInt(opt("amount") ?? "0"), proof });
  await send(acc, [msg], [`Claim from ${contract}: ${new TextDecoder().decode(msg.value.msg)}`], "claimed");
}

async function simple(action: "reclaim" | "pause_stage" | "resume_stage") {
  await requireDiana();
  const acc = await ownerAccount();
  const contract = contractAddress();
  const stageId = Number(positional[1]);
  if (!Number.isSafeInteger(stageId) || stageId < 1) throw new Error(`Usage: npm run rewards -- ${action.replace("_stage", "")} <stage id>`);
  await send(acc, [executeMsg({ sender: acc.cosmos, contract, body: { [action]: { stage_id: stageId } } })], [`${action} stage ${stageId} on ${contract}`], action);
}

async function status() {
  await requireDiana();
  const acc = await ownerAccount();
  console.log(`deployer ${acc.cosmos}: ${qor(await uqorBalance(acc.cosmos))}`);
  const contract = (opt("contract") ?? process.env.QWAKK_REWARDS_CONTRACT_ADDRESS)?.trim();
  if (!contract) {
    console.log("No QWAKK_REWARDS_CONTRACT_ADDRESS yet.");
    return;
  }
  const info = await rest<{ contract_info?: { code_id?: string; admin?: string; label?: string } }>(`/cosmwasm/wasm/v1/contract/${contract}`);
  console.log(`contract ${contract}: code ${info.body?.contract_info?.code_id}, admin ${info.body?.contract_info?.admin || "none"}, label ${info.body?.contract_info?.label}`);
  console.log(`config ${JSON.stringify(await smart(contract, { config: {} }))}`);
  const stages = await smart<{ stages: unknown[] }>(contract, { stages: { limit: 30 } });
  for (const s of stages.stages) console.log(`stage ${JSON.stringify(s)}`);
}

function help() {
  console.log(`Rewards CLI for the qwakk-rewards contract (QoreChain Diana, testnet only)

  status                                   deployer balance, contract, config and stages
  propose [--normal] [--wasm file]         store-code governance proposal (expedited by default, live minimum deposit)
  code-id                                  find the stored code id of the artifact after the proposal passes
  instantiate --code-id N [--owner qor1..] [--admin qor1..|none] [--label ..]
                                           owner and admin default to the deployer
  register <stage.json>                    register_stage from the indexer's stage file, funded with exactly its total
  claim --stage N --amount A --proof h1,h2 claim as the deployer (testing)
  reclaim <stage> | pause <stage> | resume <stage>

  --dry-run   simulate the signed transaction on the node and print the plan; send nothing
  --yes       skip the confirmation prompt
  --contract  instead of QWAKK_REWARDS_CONTRACT_ADDRESS
  env: QORE_MNEMONIC (testnet-only deployer), QWAKK_REWARDS_CONTRACT_ADDRESS (after instantiate)`);
}

const commands: Record<string, () => Promise<unknown>> = {
  status,
  propose,
  "code-id": codeId,
  instantiate,
  register,
  claim,
  reclaim: () => simple("reclaim"),
  pause: () => simple("pause_stage"),
  resume: () => simple("resume_stage"),
  help: async () => help(),
};

const run = commands[positional[0] ?? "help"];
if (!run) {
  help();
  process.exitCode = 1;
} else {
  run().catch((error: unknown) => {
    const e = error as { message?: string };
    console.error(e?.message ?? String(error));
    process.exitCode = 1;
  });
}

# AI usage

Qwakk is designed and run by one builder, who uses Claude Code as the coding tool. This file explains how: which tools, how the work is split, what the builder did, what Claude Code wrote, and how the output is checked. Facts here can be checked against the commit history.

Short version: the builder designed the product and its architecture and directs every task. Claude Code (Anthropic) writes most of the code, docs and operations work to that design. The builder reviews and tries every result and approves every commit, push and deploy.

## Tools

- **Claude Code** (Anthropic), running Claude Opus 5.5, in the terminal on the builder's machine. This is the main tool since 30 September 2026, the first commit with a Claude trailer (`7530114`).
- **Before that:** the repository started on 29 August 2026 from a generated starter project for OpenAI's Sites hosting. The first commit (`6462e25`) contains `.openai/hosting.json`, `@openai/sites-vite-plugin`, a Drizzle and D1 example and a ChatGPT auth helper, and `vite.config.ts` still has a setting for Codex previews. The repo also has an `AGENTS.md` that points other coding agents to `CLAUDE.md`. Only the hosting starter came from that generator. The builder wrote the first 7 commits with Claude as well, before the commit trailer was part of the workflow.

30 of the 37 commits in this repository (as of 15 November 2026) carry a `Co-Authored-By: Claude Opus 5.5` trailer. The other 7 are the earliest ones, from 29 August to 20 September 2026: also written with Claude, before the trailer and the setup below existed.

## Workflow

### One lead, seven specialists

The builder set up this workflow: the lead, the seven specialist roles and the rules each one must follow. They open Claude Code in a workspace folder that holds this repo next to the marketing site and the game and give short commands, usually one line and often in Turkish ("fix the swap screen", "why does the tx fail"). A lead agent turns each command into work:

1. It finds which repo and which area the request touches.
2. It checks the facts first (chain endpoints, wallet behaviour, package versions) instead of guessing.
3. It either does a small change itself or briefs a specialist agent.

The specialists are defined as files in the workspace (`.claude/agents/`), each with its own scope:

| Agent | Owns |
| --- | --- |
| `dex-frontend` | Pages, components, styling, charts, loading and error states |
| `qorechain-native` | QoreX signing, `@qorechain/sdk`, native transactions, x/amm messages |
| `indexer-data` | The indexer, PostgreSQL schema, candles, market math, data routes |
| `devops` | Docker, CapRover, environment variables, CI |
| `brand-copy` | UI text, docs wording, legal page wording, brand rules |
| `landing-builder` | The marketing site (separate repo) |
| `qa-reviewer` | Read-only review: build, lint, typecheck, tests, rule checks |

Independent tasks run in parallel. Dependent tasks run in order (for example, copy first, then the section that shows it). Every code change gets one review by `qa-reviewer`, and the lead fixes what that review confirms before reporting back.

### Rules the AI must follow

`CLAUDE.md` in this repo is binding for every agent. Among other things it says:

- Non-custodial is mandatory. No private keys, no wallet custody, no server-side signing.
- Trading uses the QoreChain native rail only. No EVM AMM as a workaround.
- Never claim signing, swaps, pool creation or fee collection is live unless it was verified with QoreX on QoreChain.
- Never show a button for an on-chain action that does not work end to end yet.
- Before calling something a blocker, read the QoreChain docs, the official packages and their source.
- Never render raw wallet or API error text. Commit or push only when the builder asks.

The workspace adds: ask the builder before anything destructive or outward-facing, such as deploying or broadcasting from a funded wallet.

### Reports

Each task ends with a short report: what changed, how it was verified, and what was not verified (for example anything that needs the builder's browser wallet). The builder reads it, tries the result, and decides what to commit.

## What the builder did

- **Architecture.** How the app is put together: QoreX signs every action in the user's own wallet, server routes only prepare and simulate native transactions, an indexer with PostgreSQL feeds the market data, and Pond Vault guards the fees on the EVM side. Agents work inside that structure and do not change it on their own.
- **Product decisions.** Non-custodial only, native rail only, the interface fee (0.10%, hard cap 0.30%, published on the fees page), points with no monetary value, the brand and the voice.
- **Wallet signing in the trading app.** Every Qwakk trade is signed in the QoreX browser wallet; the app and its server never see a key. The builder ran the signing probe in their own browser with QoreX. On 13 October 2026 it produced the first hybrid-signed Qwakk transaction on QoreChain Diana (height 7811325). On 15 November 2026 two swaps through the live app were signed in QoreX from the builder's treasury wallet ([pool 2](https://explore.qore.network/tx/5332E1D8F36DAA88EE5FEEF11E14F3B03FB74D61D48B22782C82F2D9B5DCE73E), [pool 3](https://explore.qore.network/tx/D71A0870BF0F0847D7CB819836F142E099A0EC8E64963D1A4346840F79BCB37A)).
- **Pond Vault keys.** The vault's owner and approver is a testnet-only account. Its mnemonic sits in a git-ignored `contracts/.env` on the builder's machine, where the local CLI reads it. The builder made that mnemonic and typed it into the file. On 15 November 2026 the agent (Claude Code) ran the Diana vault steps through this CLI on the builder's machine, one command at a time, each only after the builder said yes, and after reading the CLI's own preview of what it would send. The agent never printed or saw the mnemonic words.
- **Talking to QoreChain.** Reporting the QoreX signing problem and asking for the second test token, with the precise questions the research produced.
- **Approvals.** Commits, pushes, deploys, DNS and CapRover settings happen only after the builder says so.
- **Review by use.** The builder clicks through every change and sends back what feels wrong.

## What Claude Code wrote

- Most of the application code: the swap, pool and liquidity flows, the server route that builds and simulates native transactions for QoreX `signAndBroadcast`, quote handling and price impact guards, the asset registry, rate limiting and security headers.
- The indexer: block sync, AMM event parsing, candles, recovery from pruned blocks, the points system.
- Pond Vault: the Solidity contract, the Foundry unit, fuzz and invariant tests, the ML-DSA-87 test vectors, the owner and approver CLI, the read-only `/vault` dashboard and the threat model draft.
- Tests (19 test files in `tests/`, plus 2 Foundry and 3 CLI test files for Pond Vault), CI, Dockerfiles and the CapRover setup in the README.
- Research notes. One example: when QoreX started refusing the old signing call, the AI read the QoreX extension's shipped code, found the new `signAndBroadcast` method and its limits, and moved every action to it.
- UI copy, the docs and the legal page drafts (terms, privacy, risk, fees).

## How the output is checked

- `npm test`, `npm run lint`, `npm run typecheck` and `npm run build` before handing work over, and again in CI.
- For Pond Vault: `forge test` (63 passed on 2026-11-15) and the CLI's `npm test` (17 of 17), with ML-DSA-87 vectors that Diana's live `pqcVerify` precompile accepted.
- One `qa-reviewer` pass per change, against the code and the rules in `CLAUDE.md`.
- Keyless checks against the live chain: simulations through `/cosmos/tx/v1beta1/simulate` and `npm run verify:amm`, which compares Qwakk's math with the chain's quotes without signing anything.
- The builder's own hands-on test with QoreX for anything that signs.

## Where Claude Code was wrong, and how it was caught

- **A dead signing path.** The first integration used QoreX `signDirect`. A QoreX update made it refuse that call. The AI's research found the new path, and the builder's live probe confirmed it.
- **A broken production build.** The lockfile was missing entries that macOS npm had dropped, so the server's clean install failed. Fixed in `13fd5b4`, and the check is now part of the deploy notes.
- **Guessed decimals.** An early version would have treated unknown tokens as having 0 decimals. An audit caught it, and amount entry is now blocked when decimals cannot be confirmed.
- **A smoke script that stopped early.** On Diana the vault's smoke command stopped after the deposit. The queue and execute steps were then run by hand, and the live replay check was skipped, so replay rejection is proven only by the Foundry tests.

## Fest work: Pond Vault

Pond Vault was built the same way during Build Before Q-Day. The lead briefed a specialist with the vault design, the precompile facts it had checked (`pqcVerify`, `pqcKeyStatus`, the scoped EVM window) and the acceptance tests. The AI wrote the Solidity, the Foundry tests, the CLI, the dashboard and the threat model draft (`6f5a34b`, 14 November 2026), and the builder approved the commit. The testnet vault runs with the CLI's default limits: a 120 second timelock and a 10 QOR daily cap.

On 15 November 2026 the vault was deployed on QoreChain Diana at `0x6fEFdEA7209797c116747450b12695AccbE81133` and tested live: key registration, a deploy window, the deploy, a window scoped to the vault only, a 100 QOR deposit, a 0.005 QOR withdrawal queued with an ML-DSA-87 approval that `pqcVerify` checked on chain, and its execution after the timelock. The transactions are listed in [`contracts/README.md`](contracts/README.md#diana-deployment).

Still open: the two-stage QCAI audit and the route that sends interface fees into the vault.

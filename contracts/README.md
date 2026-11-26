# Qwakk Pond Vault

A post-quantum guarded vault for Qwakk's interface fees on the QoreChain EVM.
Qwakk's entry in Build Before Q-Day, **Post-Quantum dApp** category.

Anyone can pay QOR, fUSD, fETH or fBTC into the vault. Getting anything out,
or changing a rule, takes two signatures, one of them post-quantum, and then a
wait that anyone can watch. The two keys are independent only when the approver
is a separate account (see Roles):

1. **The owner's transaction.** On QoreChain an EVM transaction is admitted only
   inside an EVM authorisation window that the account opened with a hybrid
   (secp256k1 + ML-DSA-87) signed native message. The owner opens a window
   **scoped to the vault address only**.
2. **An ML-DSA-87 approval.** The approver's post-quantum key (the one its
   account registered on QoreChain, with a proof of possession) signs a
   domain-separated message. The contract reads that key live from the
   `pqcKeyStatus` precompile and checks the signature with the `pqcVerify`
   precompile, inside the transaction.
3. **A timelock and a daily cap.** Approved actions wait out a timelock before
   anyone can execute them, and withdrawals are limited per token per UTC day.
   The owner or a guardian can pause and cancel in the meantime.

A quantum attacker who forges secp256k1 signatures gets nothing: they cannot
open a window, and they cannot produce an ML-DSA-87 approval.

```mermaid
sequenceDiagram
    participant A as Approver (offline CLI)
    participant O as Owner (CLI)
    participant N as QoreChain native lane
    participant V as PondVault (EVM)
    participant P as pqcKeyStatus 0xA02 / pqcVerify 0xA01
    O->>N: MsgOpenEVMWindow (hybrid signed), allowedTargets = [vault]
    A->>A: sign "qwakk-vault-v1" | chainid | vault | action | ... | nonce | deadline (ML-DSA-87)
    A-->>O: approval file (useless without the owner's window)
    O->>V: queue(action, token, to, amount, deadline, signature)
    V->>P: pqcKeyStatus(approver) -> registered, ML-DSA-87, pubkey, possessionProven
    V->>P: pqcVerify(pubkey, signature, message)
    V-->>O: ActionQueued(id, eta)
    Note over V: timelock: owner or guardian may pause or cancel
    O->>V: execute(id) after eta, within the daily cap
```

## Status

| | |
| --- | --- |
| Contract, tests, CLI, dashboard | Built. `forge test`: 53 unit, 9 fuzz (1,024 runs each, 4,096 in CI), 3 invariants (128 runs x 64 calls); forge reports 63 passed. CLI `npm test`: 17 of 17 passed. Both run again on 2026-11-15. |
| ML-DSA-87 vectors | 12 real vectors, each verified by Diana's live `pqcVerify` precompile with an `eth_call` (true), and a tampered copy of each refused (false), on 2026-11-14. |
| Full CLI flow | Rehearsed end to end on a local anvil node with stand-in precompiles (deploy, deposit, queue, approval file, pause, approved unpause, cancel, execute, smoke). |
| On QoreChain Diana | **Deployed and tested on 2026-11-15.** Deposit, an ML-DSA-87 approved withdrawal checked on chain by `pqcVerify`, and its execution after the timelock all succeeded. See "Diana deployment" below. |
| Replay on Diana | Not run live: the smoke script stopped after the deposit, and the remaining steps were run by hand without the replay `eth_call`. The vault's nonce advanced to 1 after the queue. Replay rejection is proven by the Foundry tests. |
| Fee route into the vault | **Pending.** Interface fees go straight to the testnet treasury `qor1wl5jxt3n5fxez4csxe7t67xcfyvxr69y3mn4dq` today. |
| Q-Day Drill | **Done on 2026-11-18, proof accepted.** See "Diana deployment" below. |
| QCAI audit | **Stage 1 done** on 2026-11-15: 85/100, 5 findings answered. Stage 2 pending. See "QCAI audit (two stages)". |

### Diana deployment

QoreChain testnet `qorechain-diana`, EVM chain id 9800. Explorer links use
`https://explore.qore.network/tx/<hash>`.

| | |
| --- | --- |
| Vault | `0x6fEFdEA7209797c116747450b12695AccbE81133` (`qor1dlhaafeqj7tuz9n5w3gtzf544n97syfn0c2axu`) |
| Owner and approver (one testnet-only account, also the Q-Day Drill account) | `0x50879493D6cE5834113DDf2A042F643d1C07CCf8` (`qor12zrefy7keevrgyfamu4qgtmy85wq0n8cxrd3s3`) |
| Settings | Timelock 120 s, native daily cap 10 QOR, no guardian |
| Source | The deployed runtime bytecode equals `forge build` of `src/` at `6f5a34b` (compared on 2026-11-15) |
| Dashboard | <https://app.qwakk.fun/vault> |

| Step | Transaction |
| --- | --- |
| ML-DSA-87 key registration with proof of possession | [`CAF3DA17...D17E7`](https://explore.qore.network/tx/CAF3DA17E2742D9879E05F85FFB42B7105151022E443E794E3B9BC622E0D17E7) |
| Unscoped deploy window (1 transaction) | [`6EFDDB8B...43123`](https://explore.qore.network/tx/6EFDDB8B1679F56A0B63EAA9B3DD22FF5F03AB36584CBBAF7D55B233C7143123) |
| Deploy (2,131,623 gas) | [`A191042F...EDED0`](https://explore.qore.network/tx/A191042FD64D71371F10004A5A454BA3CFC22D213F482B1E3B06B9F241AEDED0) |
| Window scoped to the vault only (`allowedTargets=[vault]`, 4 transactions) | [`36162FA0...AD5AA`](https://explore.qore.network/tx/36162FA0EE1C0D4AB9A19A36CDE709DFA2981348CE0164C773F8CF0A9F2AD5AA) |
| Deposit 100 QOR | [`ECD75A0C...F4A9F`](https://explore.qore.network/tx/ECD75A0CF8501C2E0C9E12A2F6404D5F8349ED4590674CE11260D03550BF4A9F) |
| Queue a 0.005 QOR withdrawal with an ML-DSA-87 approval, verified on chain by `pqcVerify` (328,598 gas) | [`4D1B12F1...280AA`](https://explore.qore.network/tx/4D1B12F1BC2B85BAD90430420F2E2DA2C032F06F5F9BA6D520E362134E4280AA) |
| Execute after the timelock | [`1B6F479D...3C337`](https://explore.qore.network/tx/1B6F479DAA68842C79FFB12CEAD7402DA605BB70D7E862C1715885E36383C337) |

The Q-Day Drill ran on 2026-11-18 against the account and the vault above. By
design the drill bot held the account's classical ECDSA key. It swept the
0.745 QOR budget of an EVM window we had opened on the account that day. It
could not touch the account's native balance or the 99.995 QOR in the vault,
because both need the ML-DSA-87 key. The proof transaction
[`85A8C909...F4215`](https://explore.qore.network/tx/85A8C9091B9576D6E7841E2E77C209B8A6AF874C7089B5D48338AF0FEEEF4215)
(a hybrid-signed native send) was accepted on the project page.

## Layout

```
src/PondVault.sol                 the vault
src/interfaces/IQorePQC.sol       pqcVerify / pqcKeyStatus (four return values, as Diana answers)
test/PondVault.t.sol              unit and negative tests with real ML-DSA-87 vectors
test/PondVault.fuzz.t.sol         fuzz (timelock, cap, deadlines, roles, nonces) and invariants
test/fixtures/pq-vectors.json     the vectors (generated, reproducible byte for byte)
test/utils/                       shared setup, ERC-20 mocks, anvil stand-ins for the precompiles
src/QwakkToken.sol                QWAKK, Qwakk's fixed-supply meme token (see "QWAKK token" below)
test/QwakkToken.t.sol             its unit, x/erc20 conversion-shape, fuzz and invariant tests
src/QcatToken.sol                 QCAT (Quantum Cat), the same token shape for the QCAT community token (see "QCAT token" below)
test/QcatToken.t.sol              the same test suite for QCAT
script/DeployPondVault.s.sol      Foundry deploy script for the anvil rehearsal only (refuses other chains)
cli/                              owner and approver CLI (TypeScript, viem, QoreChain SDK), plus the token CLI for QWAKK and QCAT (src/token.ts) and the rewards CLI (src/rewards.ts)
rewards/                          qwakk-rewards, the CosmWasm Merkle claim contract for liquidity rewards (its own README)
```

The read-only dashboard lives in the app: `app/vault/page.tsx`,
`components/VaultView.tsx`, `app/api/vault/route.ts`, `lib/qwakk-vault.ts`.

## The contract

### Roles

| Role | Can | Cannot |
| --- | --- | --- |
| Owner | send `queue`, `unpause`, `pause`, `cancel`, `execute` | move funds or change rules without an ML-DSA-87 approval |
| Approver | sign approvals with its registered ML-DSA-87 key | send anything to the vault on its own behalf |
| Guardian (optional) | `pause`, `cancel` | queue, unpause, or cancel its own replacement |
| Anyone | deposit, `execute` a ready action | skip the timelock or the cap |

**Default setup: one account.** Unless `QORE_APPROVER_MNEMONIC` is set, the
approver is the owner's own account, so one mnemonic holds both the secp256k1
key and the ML-DSA-87 key. That still stops a quantum attacker and a thief who
has only the secp256k1 key, but not someone who has the mnemonic itself. The
`/vault` page says so when owner and approver are the same account.

For independent keys, give the approver its own mnemonic on another machine
(`QORE_APPROVER_MNEMONIC`), sign with `approve ... --out file` there, and queue
with `queue --approval file` on the owner's machine.

### Actions

Every sensitive action is queued and runs after the timelock.

| # | Action | Fields used | Notes |
| --- | --- | --- | --- |
| 1 | `Withdraw` | token, to, amount | token `0x0` = native QOR (18 decimals on the EVM lane). Checked against the daily cap at execution. Blocked while paused. |
| 2 | `SetDailyCap` | token, amount | 0 locks that token. ERC-20 caps start at 0. |
| 3 | `SetTimelock` | amount (seconds) | 60 s to 30 days. Never shortens actions already queued. |
| 4 | `SetOwner` | to | |
| 5 | `SetApprover` | to | `to` must hold a usable ML-DSA-87 key at queue and at execution. |
| 6 | `SetGuardian` | to (0 removes) | Runs even while paused, so a bad guardian can always be replaced. |
| 7 | `Unpause` | none | Not queued: takes effect at once. Queued actions keep their own eta. |

Fields an action does not use must be zero, so every action has exactly one
valid encoding.

### The approval message

203 bytes, every field fixed width, so packing is unambiguous:

```
"qwakk-vault-v1" (bytes14) | chainid (uint256) | vault (address) | action (uint8)
| token (address) | to (address) | amount (uint256) | nonce (uint256) | deadline (uint256)
```

- `nonce` is the vault's sequential approval counter: each approval works once, in order.
- `chainid` and `vault` bind it to one chain and one vault.
- `deadline` must be in the future and at most 1 day ahead (`MAX_APPROVAL_TTL`).
- The signed bytes are the message itself (not a hash). `pqcVerify` takes "the
  original message bytes" (docs: developer-guide/evm-precompiles), and Diana's
  precompile verified exactly these bytes for every vector.
- The vault exposes `approvalMessage(...)`. The CLI refuses to sign unless its own
  encoding equals the vault's.

### Checks, in order

`queue`: sender is owner; parameters canonical; not paused (for withdrawals);
deadline in range; signature is 4,627 bytes; `pqcKeyStatus(approver)` says
registered, algorithm 1 (ML-DSA-87), `possessionProven`, 2,592-byte key;
`pqcVerify(pubkey, signature, message)` returns exactly true; then the nonce is
used and `ApprovalVerified(nonce, approver, action, keccak256(message))` is logged.

Both precompile calls fail closed: an inactive precompile (which answers with
empty data on networks where it is off) or odd return data reads as "no key" or
"invalid".

`execute`: action is queued; `eta <= now <= eta + 7 days`; for withdrawals, not
paused and within today's cap. State changes before the transfer, and a
reentrancy guard covers `queue`, `unpause`, `execute` and `depositToken`.

### Events

`Deposited`, `ApprovalVerified`, `ActionQueued`, `ActionExecuted`,
`ActionCancelled`, `Withdrawn`, `DailyCapSet`, `TimelockSet`, `OwnerSet`,
`ApproverSet`, `GuardianSet`, `Paused`, `Unpaused`.

## Tests

```sh
cd contracts
forge install foundry-rs/forge-std@v1.17.0 --no-git   # once
forge build
forge test                                            # FOUNDRY_PROFILE=ci for 4,096 fuzz runs
cd cli && npm ci && npm test
```

Foundry's EVM has no QoreChain precompiles, so the tests mock them with
`vm.mockCall` to answer exactly what Diana answers:

- `pqcVerify` returns true **only** for the exact `(pubkey, signature, message)`
  triples in `test/fixtures/pq-vectors.json` and false for anything else. Those
  vectors are real ML-DSA-87 signatures that Diana's precompile verified.
- `pqcKeyStatus` returns Diana's four values, and `(false, 0, "", false)` for an
  account without a key.

So a test that tampers with one byte, replays an approval or moves it to another
chain or vault fails for the same reason it would fail on Diana: the bytes the
contract builds are no longer the bytes that were signed.

| Suite | What it proves |
| --- | --- |
| Encoding | All 12 vectors: the contract's `approvalMessage` equals the TypeScript encoder's bytes. |
| Negative | Replay, replay on another chain, signed for another chain, replay on another vault, signed for another vault, expired, too long lived, tampered signature, tampered amount, tampered recipient, wrong signature length, non-owner sender, guardian sender, approver key removed, approver key rotated on chain, key without proof of possession, wrong key length, precompiles inactive (fails closed), non-canonical parameters. |
| Flows | Withdraw QOR, set a token cap then withdraw the token, timelock, owner, guardian and approver rotation (old key refused afterwards), pause, approved unpause, cancel, guardian limits, reentrant recipient, false-returning token. |
| Fuzz | Timelock window (execution succeeds exactly between eta and eta + grace), a timelock change never shortens queued actions, daily cap within a day, cap reset exactly at the UTC boundary, zero cap locks a token, deadline window, only the owner queues, only owner or guardian pause and cancel, sequential nonces. |
| Invariants | No UTC day pays out more than the cap; balance is conserved (in minus out); nonce equals actions queued. |
| CLI (`npm test`) | Encoder against every vector, both official verifiers accept every vector, signatures do not carry over, decode round trip, field validation, ABI and app selectors match the compiled contract. |

Regenerate the vectors (deterministic, so the file does not change):

```sh
cd contracts/cli
npm run vectors -- --live   # --live: also checks each vector on Diana with eth_call
```

## Owner runbook (QoreChain Diana)

The vault in "Diana deployment" was deployed and tested with these steps on
2026-11-15. Step 9 stopped after the deposit, so the queue and the execute were
then run by hand. Every command that sends something prints what it will do and
waits for "yes".

**Prerequisites:** Foundry 1.9 (`brew install foundry`, or `foundryup`), Node.js
22.13 or later, test QOR from the faucet
([dashboard.qorechain.io/faucet](https://dashboard.qorechain.io/faucet), 100 QOR every 24 hours).

| Step | Command (from `qwakk-app/contracts`) | Env vars it needs | Sends |
| --- | --- | --- | --- |
| 1 | `forge install foundry-rs/forge-std@v1.17.0 --no-git && forge build && forge test` | none | nothing |
| 2 | `cd cli && npm ci && npm test` | none | nothing |
| 3 | `cp .env.example .env`, then set `QORE_MNEMONIC` to a **new, testnet-only** mnemonic (`cast wallet new-mnemonic`) | | nothing |
| 4 | `cd cli && npm run pond -- status` (prints the owner's `qor1` address; fund it from the faucet) | `QORE_MNEMONIC` | nothing |
| 5 | `npm run pond -- register` | `QORE_MNEMONIC` | native tx (classical, the one message the chain accepts that way), fee 0.1 QOR: registers the ML-DSA-87 key with a proof of possession. If the account already has a key, it sends nothing and exits with an error unless that key is this mnemonic's, with a proof of possession. |
| 6 | `npm run pond -- window deploy` | `QORE_MNEMONIC` | native tx (hybrid), fee 0.1 QOR: unscoped window, 1 transaction |
| 7 | `npm run pond -- deploy`, then put the printed `POND_VAULT_ADDRESS` in `.env` | `QORE_MNEMONIC`, optional `POND_TIMELOCK_SECONDS` (120), `POND_NATIVE_DAILY_CAP_QOR` (10), `POND_GUARDIAN` | EVM deploy inside the window. Refuses unless the approver's registered key (read through `pqcKeyStatus`) is the key its mnemonic derives. This is the supported deploy path. |
| 8 | `npm run pond -- window vault --txs 4 --deposit-qor 0.01` | `QORE_MNEMONIC`, `POND_VAULT_ADDRESS` | native tx (hybrid), fee 0.1 QOR: window scoped to the vault only |
| 9 | `npm run pond -- smoke` | `QORE_MNEMONIC`, `POND_VAULT_ADDRESS`, optional `POND_SMOKE_DEPOSIT_QOR`, `POND_SMOKE_WITHDRAW_QOR` | 3 EVM txs: deposit, queue (with ML-DSA-87 approval), execute. The replay check is an `eth_call`. |
| 10 | `npm run pond -- status` | same | nothing |
| 11 | In the app: set `QWAKK_VAULT_ADDRESS` (web, testnet) and open `/vault` | | nothing |

Optional:

- `npm run pond -- native-send-test` sends 1 uqor on the native lane to the
  vault's `qor1` address and checks that the vault's EVM balance rises by
  10^12 wei. Only if it does should `QWAKK_TREASURY_ADDRESS` ever point at the
  vault. Until then this tie-in is **unverified**.
- A second, offline approver: set `QORE_APPROVER_MNEMONIC` on the approver's
  machine, run `npm run pond -- register --approver` once, deploy with that
  approver (the CLI uses it automatically), then
  `npm run pond -- approve withdraw --token QOR --to 0x... --amount 1 --out a.json`
  there and `npm run pond -- queue --approval a.json` on the owner's machine.
- `script/DeployPondVault.s.sol` is for the anvil rehearsal only and refuses
  any other chain. Foundry runs a script on a local fork before broadcasting,
  and QoreChain's precompiles are native code that a fork does not have, so the
  constructor's key check would revert before anything is sent. It also cannot
  check that the registered key matches the mnemonic. Deploy on Diana with the
  CLI (step 7).

Other commands: `queue withdraw|cap|timelock|owner|approver|guardian|unpause`,
`execute <id>`, `cancel <id>`, `pause`, `window close`. Run
`npm run pond -- help`.

### Window sizing

- Diana makes about 0.7 blocks per second (10,000 blocks in 14,246 s on
  2026-11-14), so the default 1,800-block window lasts about 43 minutes.
- A window bounds value plus the maximum fee of each transaction
  (`evmWindowCost`). The CLI sizes `window vault` for 1,000,000 gas per
  transaction at a 250 gwei fee cap (`POND_MAX_FEE_GWEI`) plus the deposit, and
  caps each transaction's fee at the same number. A `queue` used about 0.38 to
  0.42 million gas in the anvil rehearsal with a stand-in verifier; the real
  `pqcVerify` costs 25,000 gas plus 8 per input byte (docs), about 85,000 here.
- A window with `allowedTargets` refuses contract creation, so deploying needs
  the unscoped `window deploy` first.
- Opening a window advances the account's nonce and replaces any open window.
- The docs say a scoped window must also list a standard precompile that a
  transaction is sent to. The vault calls `pqcVerify` and `pqcKeyStatus`
  internally, and on Diana that does **not** need them listed: on 2026-11-15
  `queue` succeeded inside a window with `allowedTargets=[vault]` only (see
  "Diana deployment"). `POND_WINDOW_EXTRA_TARGETS` stays available but is not
  needed for the vault.
- Deploying PondVault costs about 2.13 million gas (Foundry gas report), inside
  the 3,000,000 gas the deploy window is sized for.

## Local rehearsal (anvil)

Runs the real CLI against a local node, with stand-ins for the precompiles
(`test/utils/DevnetPrecompiles.sol`). The stand-in verifier accepts any
well-formed signature, so this proves the CLI and contract plumbing, not the
cryptography (the Foundry tests and Diana do that).

```sh
anvil --block-time 1 &
forge build
cast rpc anvil_setCode 0x0000000000000000000000000000000000000a01 $(forge inspect DevnetPqcVerify deployedBytecode)
cast rpc anvil_setCode 0x0000000000000000000000000000000000000a02 $(forge inspect DevnetPqcKeyStatus deployedBytecode)
# put the owner's real ML-DSA-87 public key (derived from QORE_MNEMONIC) in the
# stand-in with setKey(address,bytes), fund the owner, then:
POND_DEVNET_RPC=http://127.0.0.1:8545 npm --prefix cli run pond -- deploy
# or, with Foundry (anvil only):
forge script script/DeployPondVault.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

`POND_DEVNET_RPC` skips QoreChain's window checks (anvil has no native lane)
and refuses native-lane commands.

## Threat model

| Threat | What happens | Why |
| --- | --- | --- |
| Quantum attacker forges secp256k1 signatures (Q-Day) | Nothing moves. | Opening an EVM window needs a hybrid signature with ML-DSA-87, and every sensitive vault action needs an ML-DSA-87 approval checked on chain. |
| Owner's secp256k1 key stolen | Nothing moves. | The thief cannot open a window without the ML-DSA-87 key. Inside a window the owner already opened (scoped to the vault), they still cannot queue without an approval; at worst they pause or cancel. The owner closes the window (`window close`, hybrid signed) and moves the owner role to a fresh account (see "Recovering from a leaked key"). |
| Approver's ML-DSA-87 key stolen | Nothing moves while the owner's keys are safe. | An approval only works when the owner sends it. The owner moves the approver role to a fresh account with a queued `SetApprover` (see below). The contract also reads the approver's key live, so a key rotated on QoreChain's native lane would end old-key approvals at once (tested), but this CLI cannot rotate keys or sign with a rotated key, so that is not a supported recovery path here. |
| Owner and approver are one account and both its keys are stolen | Slowed, not stopped: every withdrawal and every cap or role change waits out the timelock, and withdrawals stay within the cap in force. | The guardian (another account) can pause and cancel during the timelock. If nobody reacts, the attacker can raise the cap after one timelock. Use a separate approver, a guardian and a long timelock for real funds. |
| Replay | Refused. | Nonce, chain id, vault address and deadline are all signed (tests: replay, other chain, other vault, expired). |
| Malicious or compromised front end | Cannot obtain an approval. | The dashboard is read only and never asks for a signature. Approvals are signed in the local CLI, which shows the decoded fields, cross-checks the bytes with the vault's `approvalMessage`, and checks the signature with `pqcVerify` before sending. QoreX refuses `signArbitrary`, so there is no browser signing surface to phish. |
| Lying RPC node | Can make the CLI refuse, not sign something else. | The CLI signs only what it encoded and displayed locally; the on-chain cross-check can fail but cannot change those bytes. |
| Rogue guardian | Delay only. | It can pause and cancel but not queue, unpause or cancel its own replacement; `SetGuardian` runs even while paused. |
| Precompile missing or broken | Fails closed. | Empty or odd answers read as "no key" or "invalid" (tested). |
| Odd tokens | Handled. | Tokens returning false or nothing are handled; deposits record the amount actually received; reentrancy guarded. |

### Recovering from a leaked key

The supported path is to move the role to a fresh account. Both moves are
queued, so they wait out the timelock; a guardian can pause meanwhile.

- **Approver key leaked.** Make a fresh testnet-only mnemonic and fund its
  account. Put it in `.env` as `QORE_APPROVER_MNEMONIC` and run
  `npm run pond -- register --approver`. Then switch `QORE_APPROVER_MNEMONIC`
  back to the current approver (remove it if the approver is the owner), run
  `npm run pond -- queue approver --to <new 0x address>`, wait for the timelock and
  run `npm run pond -- execute <id>`. From then on, set `QORE_APPROVER_MNEMONIC`
  to the new mnemonic.
- **Owner's secp256k1 key leaked.** While a window is open, the thief can send
  as the owner (pause, cancel), so keep the old owner's windows to one
  transaction:
  1. `npm run pond -- window close` (old owner).
  2. With a fresh, funded mnemonic as `QORE_MNEMONIC`: `npm run pond -- register`.
  3. Back on the old owner's mnemonic: `npm run pond -- window vault --txs 1`,
     then at once `npm run pond -- queue owner --to <new 0x address>`. The
     one-transaction window leaves the thief nothing to cancel with.
  4. On the new mnemonic: `npm run pond -- window vault --txs 2` and, after the
     timelock, `npm run pond -- execute <id>` (anyone may execute).
- **The single shared mnemonic leaked** (default setup). Both moves above are
  still possible, but so are the thief's: pause with the guardian if you have
  one, cancel the thief's queued actions, and move both roles.

Known limits: the daily cap uses fixed UTC days, so up to twice the cap can
leave around midnight UTC. Block timestamps can drift by seconds; keep timelocks
in minutes or more. The vault cannot see the owner's window; QoreChain enforces
it. On mainnet the PQC precompiles are not active today, so the vault is
testnet only and the CLI refuses `QORE_NETWORK=mainnet`.

## QCAI audit (two stages)

The tool is the QoreChain dashboard's AI Smart Contract Auditor
(https://dashboard.qorechain.io/audit, runs on QCAIA). It reviews pasted source
and returns a security score, a risk level, a post-quantum readiness score and
findings, exportable as PDF. The exact two-stage procedure for the fest has been
requested from QoreChain; until it is confirmed, stage 2 is a second run after
our responses below.

| Stage | When | Scope | Report | Result |
| --- | --- | --- | --- | --- |
| 1 | 2026-11-15, after deployment | `src/PondVault.sol` and `src/interfaces/IQorePQC.sol`, flattened, at `6f5a34b` (the deployed source; unchanged since) | [`audit/qcai-stage1-pondvault-2026-11-15.pdf`](audit/qcai-stage1-pondvault-2026-11-15.pdf) | Security score 85/100, risk level Medium, 5 findings. Quantum readiness "not scored for this setting" (the tool auto-detected the source as Ethereum). |
| 2 | _pending_ | same source | _pending_ | _pending_ |

The vault went on Diana on 2026-11-15 before stage 1 ran, so stage 1 reviewed the
source of the deployed vault. A code change from either stage needs a new
deployment.

### Stage 1 findings and our responses

The report's line numbers do not match the source file, so the table names the
functions instead.

| Finding (report severity) | Our assessment | Evidence |
| --- | --- | --- |
| Potential reentrancy via external calls (High) | Not exploitable. `execute` marks the action `Executed`, and `_spend` records the day's spend, before `_send` makes the external call; nothing changes state after it. `queue`, `unpause`, `execute` and `depositToken` share a reentrancy guard. `pause` and `cancel` are owner or guardian only. | `test_ReentrantRecipientCannotReenter` |
| Missing access control for key rotation (Medium) | By design, already guarded. `SetApprover` needs the owner's transaction, a fresh ML-DSA-87 approval from the current approver and the timelock. The new approver's key must be registered, ML-DSA-87, 2,592 bytes and possession proven, checked at queue and again at execute. | `test_RotateApproverToSecondKey`, `test_RevertWhen_NewApproverHasNoKeyAtQueue`, `test_RevertWhen_NewApproverLostKeyBeforeExecute` |
| Potential overflow in daily cap calculation (Medium) | Not possible as described. The contract compiles with Solidity 0.8.28, whose checked arithmetic reverts on overflow, so `spent + amount` can never wrap and pass the cap. A revert would also need amounts near 2^256. | `testFuzz_DailyCapWithinOneDay`, the "no UTC day pays out more than the cap" invariant |
| Unchecked return data from token transfers (Low) | Intended. `_callToken` accepts a token that returns `true` or nothing and refuses `false`, a revert, any other return data or a non-contract, so an unusual token fails closed. | `test_RevertWhen_TokenReturnsFalse`, `test_RevertWhen_DepositTokenIsNotAContract` |
| Timestamp dependency in the timelock (Info) | Accepted. Timelocks are 60 s to 30 days and approvals live at most 1 day, so a few seconds of block time drift cannot skip a timelock in a useful way. Listed under Known limits above. | `test_RevertWhen_TimelockOutOfBounds`, `test_RevertWhen_ExecutedBeforeTimelock` |

No code change was needed, so the deployed vault stands.

## Kits and network features used

| Kit | Version | Used for |
| --- | --- | --- |
| `create-qorechain-dapp` (Foundry template) | 0.14.0 | Project base: `foundry.toml`, named RPCs, the window helper the CLI grew from |
| `@qorechain/sdk` | 0.14.0 | `deriveUnifiedAccount`, `EthNativeSigner` (hybrid and classical native txs), `openEvmWindowMsg` with `allowedTargets`, `closeEvmWindowMsg`, `buildRegisterPqcKeyMsg`, `signProofOfPossession`, `fetchPqcStatus`, `isRegisteredPqcKey`, `pqcSign`, `pqcVerify`, `getNetwork` |
| `@qorechain/evm` | 0.14.0 | `evmWindowStatus`, `evmWindowCost`, `weiToUqorCeil`, `classifyEvmWindowRejection`, `IQORE_PQC_ABI`, `PRECOMPILE_ADDRESSES`, `qorechainTestnet`, `toQorAddress` |
| `@qorechain/pqc` | 0.2.3 | `mldsa87` keygen, sign and verify for the test vectors |
| `@qorechain/sdk` (app) | 0.8.2 | `hexToBech32` for the dashboard's window lookup |
| Foundry, forge-std | 1.9.0, 1.17.0 | Build, unit, fuzz and invariant tests, anvil deploy script |
| viem | 2.x | EVM reads and writes in the CLI |

Network features: scoped EVM authorisation window (`allowedTargets`), the
`pqcVerify` precompile (0xA01), the `pqcKeyStatus` precompile (0xA02,
including `possessionProven`), ML-DSA-87 key registration with proof of
possession, hybrid-signed native transactions, the unified account (`qor1` and
`0x` are the same 20 bytes), and the Diana ERC-20 test tokens.

Reference: [qorechain/build-before-qday](https://github.com/qorechain/build-before-qday)
(workshop 1: `01-qday-counter/scripts/window.ts`).

### Notes for the QoreChain team

- `pqcKeyStatus` answers four values on Diana (`registered, algorithmId, pubkey,
  possessionProven`), as the docs say, but `IQORE_PQC_ABI` in
  `@qorechain/evm@0.14.0` lists three.
- `PRECOMPILE_ADDRESSES` in `@qorechain/evm@0.14.0` spells `0x...0A01` and
  `0x...0A02` in a case that is not a valid EIP-55 checksum, so viem refuses them
  as given. The CLI lowercases them first.

## QWAKK token (QoreChain Diana)

QWAKK is Qwakk's meme token on the Diana testnet: `Qwakk` / `QWAKK`, 6
decimals, 1,000,000,000 QWAKK (10^15 base units) minted once to the deployer in
the constructor. No owner or admin role, no mint or burn function, no fee, no
pause, no blocklist (`src/QwakkToken.sol`). It trades in Qwakk the same way as
fUSD, fETH and fBTC: as a bank coin `erc20:<address>` in an x/amm pool against
QOR, signed by QoreX.

| | |
| --- | --- |
| Contract and tests | Built. `forge test --match-path test/QwakkToken.t.sol`: 21 unit, 5 fuzz (1,024 runs each), 1 invariant (128 runs x 64 calls); 27 passed on 2026-11-18. |
| CLI | Built. `npm run token -- <command>` with the commands status, deploy, convert and send (and `propose` since 2026-11-25). CLI `npm test`: 30 of 30 passed on 2026-11-18. |
| Deploy dry run on Diana | `eth_estimateGas` of the deploy from the deployer: 379,212 gas, the same as Foundry's gas report (2026-11-18). |
| Native dry runs on Diana | Signed hybrid and simulated (never broadcast, sequence unchanged): a MsgConvertERC20 with a `qor1` sender reached the EVM transfer, and a bank send of an `erc20:` coin reached the bank keeper (2026-11-18). |
| On chain | **Deployed on 2026-11-18** at `0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23` (`qor15keu87ujut5f240ejzdeqpxxtu659m3r05j3gz`), block 10,322,273, 379,212 gas ([`7DAF1B36...10913`](https://explore.qore.network/tx/7DAF1B36430B7FD756561CF6ED5F0D86CE01214F5F8DC5D26990091EE8810913)). The CLI checked name, symbol, decimals, supply and the deployer's 1,000,000,000 QWAKK on chain. Expected bank denom: `erc20:0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23`. |
| Registration | **Registered on 2026-11-18** by testnet proposal 38 (passed, voting ended 18:09 UTC): token pair `erc20:0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23`, enabled, `OWNER_EXTERNAL`. |
| Conversion and transfer | The whole supply was converted to bank coins ([`93FD678D...6F4E`](https://explore.qore.network/tx/93FD678D7957CBA9173AE9F2627D2216302A2B917A7F00F190F8EBD89F2D6F4E)) and sent to the owner's QoreX wallet `qor1wl5jxt3n5fxez4csxe7t67xcfyvxr69y3mn4dq` ([`A20C7053...E333`](https://explore.qore.network/tx/A20C70534AA1A922E61B0FAC2C3359607D9A308E38D6A5AF19684160B4F3E333)). |
| Pool | QWAKK/QOR is pool 6, created with QoreX on 2026-11-18 with 200,000,000 QWAKK and 20,000 QOR (1 QWAKK = 0.0001 QOR) ([`C20F99E3...E8BE`](https://explore.qore.network/tx/C20F99E3D3A840F2AF25F5B4EF4DCA3CEC662024B5367C620B597C55FEECE8BE)). |

### How registration and conversion work

- **Registration is governance only on Diana** (`/cosmos/evm/erc20/v1/params`:
  `permissionless_registration: false`). A proposal carries `MsgRegisterERC20`
  (signer: the gov module `qor10d07y265gmmuvt4z0w9aw880jnsr700jwfyxr3`), as
  testnet proposal 26 did for fUSD, fETH and fBTC. Any funded account can
  submit one on the testnet: the live gov params (`/cosmos/gov/v1/params/deposit`,
  read 2026-11-25) ask a 10 QOR minimum deposit with a 4 hour voting period, or
  50 QOR for an expedited proposal with a 1 hour voting period, and the deposit
  is refunded unless the proposal is vetoed. The validators (QoreChain) vote.
  QWAKK's proposal 38 was submitted by QoreChain; from QCAT on, the deployer
  submits it with `npm run token -- propose`, a hybrid-signed Native-lane
  `cosmos.gov.v1.MsgSubmitProposal` that rebuilds proposal 38's message byte
  for byte (`cli/test/token.test.ts`). Proposal 42 shows a normal 10 QOR
  proposal passing.
- **What registration reads from the contract** (cosmos/evm v0.6.3, which
  QoreChain pins in `go.mod`; `x/erc20/keeper/proposals.go` and
  `keeper/evm.go`): `name()`, `symbol()` and `decimals()`, called from the erc20
  module address. No interface or ownership check. It then creates bank
  metadata and an `OWNER_EXTERNAL` token pair. For QWAKK the metadata will be:
  base and name `erc20:<EIP-55 address>`, symbol `QWAKK`, display unit `Qwakk`
  at exponent 6, description "Cosmos coin token representation of <address>".
  The CLI's replica of this rule reproduces Diana's live fUSD, fETH and fBTC
  records exactly (`cli/test/token.test.ts`), and `token status` compares the
  live record with it after registration.
- **Why proposal 24 failed.** It carried the same three addresses as 26 and
  ended later (24: 2026-10-28 01:48 UTC, 26: 2026-10-27 15:11 UTC, both passed
  the vote). 26 executed first, so 24 hit `token ERC20 contract already
  registered ... token pair already exists` (`failed_reason` at
  `/cosmos/gov/v1/proposals/24`). So: one proposal per address.
- **Registration does not move balances.** The whole supply stays an ERC-20
  balance of the deployer until it is converted with `MsgConvertERC20`
  (`keeper/convert.go`: the module takes the ERC-20 into escrow at
  `0x47EeB2eac350E1923b8CBDfA4396A077b36E62a0` and mints the same amount as bank
  coins to `receiver`). The token must return `true` from `transfer` and move
  exactly the amount; the Foundry tests check both.
- **Conversion is a Native-lane transaction**, signed hybrid with the
  account's registered ML-DSA-87 key. `sender` and `receiver` are `qor1`
  addresses: QoreChain patches the module to read a bech32 sender
  (`qorechain-core` `app/app_config.go`; docs: developer-guide/evm-development,
  "Converting between the two forms"). Diana holds 95 successful conversions in
  that form, for example
  [`D53380E8...FE3B6`](https://explore.qore.network/tx/D53380E8260EAA25A790D35E462AD14E07D13BD879C79C4BD43157E5B5FAE3B6)
  (428,257 gas). No EVM window is needed: `qor1ztgyvvcgrn5wnthhdmfswddtd3aexk7zz6yln2`
  converted fBTC and has never opened one. `@qorechain/sdk` 0.14.0 has no
  builder for this message, so the CLI adds a four-field encoder that matches
  that live transaction byte for byte.
- **The bank coin moves like any other bank coin.** A `MsgSend` of `erc20:`
  coins works (for example the faucet's
  [`79D42B78...233C1`](https://explore.qore.network/tx/79D42B78EA8EF31D0350189562D66C99699D70AE8922420365206B65A08233C1)),
  so the CLI sends QWAKK to the owner's QoreX wallet, and the pool is created in
  the Qwakk app with QoreX exactly like pools 2 to 4.

### Runbook

Run from `qwakk-app/contracts/cli` unless a step says otherwise. The deployer is
the testnet-only account of `QORE_MNEMONIC` in `contracts/.env`:
`0xfcDA8fF7c31dCF8900F99fc91c7Db6E8b3112A5C` /
`qor1lndgla7rrh8cjq8enly3cldkaze3z2jupzakmp`, a fresh account with its own
ML-DSA-87 key. It is not the Pond Vault account: that one is the Q-Day Drill
account, whose ECDSA key the drill bot holds, and the bot drained the budget of
the unscoped window we opened on it on drill day. Never open an unscoped window on
a drill account. Every command that sends prints
what it will send and waits for "yes". `deploy`, `convert` and `send` take `--dry-run` to
estimate or simulate on the node and stop.

| Step | Command or action | Env vars | Sends | Fee |
| --- | --- | --- | --- | --- |
| 1 | `cd .. && forge build && forge test --match-path test/QwakkToken.t.sol`, then `cd cli && npm test` | none | nothing | none |
| 2 | `npm run token -- status` (deployer QOR, key, window; "token not deployed yet") | `QORE_MNEMONIC` | nothing | none |
| 3 | `npm run pond -- window deploy` | `QORE_MNEMONIC` | Native tx (hybrid): opens an unscoped window for 1 EVM transaction, replacing the old vault window | 0.1 QOR; the window allows up to 0.75 QOR of EVM fees |
| 4 | `npm run token -- deploy`, then put the printed `QWAKK_TOKEN_ADDRESS=0x...` in `contracts/.env` | `QORE_MNEMONIC` | 1 EVM tx: deploys QwakkToken; the CLI then checks name, symbol, decimals, supply and the deployer's balance on chain | about 379,000 gas: about 0.043 QOR at 112.5 gwei (Diana's gas price on 2026-11-18), at most 0.124 QOR (gas limit 492,975 at the 250 gwei cap) |
| 5 | `npm run token -- propose --dry-run`, then `npm run token -- propose` (add `--expedited` for the 1 hour vote). Ask QoreChain to vote (the request below). Wait until `npm run token -- status` shows "token pair erc20:0x..., enabled, OWNER_EXTERNAL" and "bank metadata as expected" | `QORE_MNEMONIC`, `QWAKK_TOKEN_ADDRESS` | Native tx (hybrid): `MsgSubmitProposal` with one `MsgRegisterERC20` | the live minimum deposit (10 QOR, or 50 QOR expedited), refunded unless vetoed, plus 0.1 QOR |
| 6 | `npm run token -- convert all` | `QORE_MNEMONIC`, `QWAKK_TOKEN_ADDRESS` | Native tx (hybrid): `MsgConvertERC20` of the whole supply into the deployer's bank balance | 0.1 QOR (800,000 gas at 0.125 uqor per gas; more only if the dry run needs more) |
| 7 | `npm run token -- send <amount or all> --to qor1wl5jxt3n5fxez4csxe7t67xcfyvxr69y3mn4dq` | `QORE_MNEMONIC`, `QWAKK_TOKEN_ADDRESS` | Native tx (hybrid): bank `MsgSend` of QWAKK to the owner's QoreX wallet | 0.1 QOR |
| 8 | `npm run token -- status --holder qor1wl5jxt3n5fxez4csxe7t67xcfyvxr69y3mn4dq` | same | nothing | none |
| 9 | In the Qwakk app with QoreX (Diana): Pools, New pool, pick QWAKK (it appears from the wallet balance, labeled from its bank metadata) and QOR, enter both amounts, approve in QoreX. The amounts set the starting price. Add more liquidity from the pool page the same way. | none | QoreX signs `MsgCreatePool` (and later `MsgAddLiquidity`) | 100 QOR pool creation fee plus the network fee QoreX shows |
| 10 | `npm run token -- status` lists the pool. Then in the app repo set the same EIP-55 address in two places: `QWAKK_TOKEN_ADDRESS` in `lib/qwakk-assets.ts` and in `indexer/token-registry.ts`. Run `npm run typecheck`, `npm run lint`, `npm test`, then deploy the web and indexer services. | none | nothing | none |

After step 10 QWAKK carries the duck mark and its name everywhere in the app.
Before step 10 it already trades: the app and the indexer resolve it from the
bank metadata (symbol QWAKK, 6 decimals). Points count the QWAKK/QOR pool like
any pool with a QOR side.

Pool notes: each deposit must be at least 1,000 base units of each token
(`min_liquidity`), the AMM refuses swaps above 5% price impact
(`max_swap_impact_bps` 500), and the swap fee is 0.30% (0.20% to liquidity, 0.10%
burned). A shallow pool hits the impact cap after small swaps, so size the QOR
side for the swaps you expect.

### Registration request for QoreChain

Before 2026-11-25 QoreChain submitted the proposal for us. This is the text we
sent for QWAKK. Now the deployer submits it (step 5), so the message only has
to ask for a vote on the proposal number. Fill in the address from step 4 and
send it as plain text:

```text
My friend, we deployed Qwakk's meme token QWAKK on Diana and would like it registered as a bank denom so it can be pooled against QOR in x/amm, like fUSD, fETH and fBTC in proposal 26.

Could you submit a MsgRegisterERC20 proposal on qorechain-diana for this one contract: <QWAKK_TOKEN_ADDRESS>

It is a plain fixed-supply ERC-20: name Qwakk, symbol QWAKK, 6 decimals, 1,000,000,000 supply minted once to the deployer. No owner, no mint, no fee on transfer, no pause, no blocklist. The expected denom is erc20:<QWAKK_TOKEN_ADDRESS>. Source: contracts/src/QwakkToken.sol in github.com/qwakk-fun/qwakk-app.

Thank you!
```

## QCAT token (QoreChain Diana)

QCAT (Quantum Cat) is a QoreChain community meme token whose team partnered
with Qwakk. Its team agreed that Qwakk deploys it on the Diana testnet; they
deploy mainnet themselves. `Quantum Cat` / `QCAT`, 6 decimals, 1,000,000,000
QCAT (10^15 base units) minted once to the deployer, with the same shape as
QWAKK: no owner, no mint or burn, no fee, no pause, no blocklist
(`src/QcatToken.sol`). On the testnet the whole supply goes to the owner's
QoreX wallet `qor1wl5jxt3n5fxez4csxe7t67xcfyvxr69y3mn4dq`, with no
distribution or vesting.

The same CLI and runbook apply with `--token qcat` and `QCAT_TOKEN_ADDRESS` in
`contracts/.env`, for example `npm run token -- status --token qcat`.

| | |
| --- | --- |
| Contract and tests | Built. `forge test --match-path test/QcatToken.t.sol`: 27 passed (21 unit, 5 fuzz, 1 invariant) on 2026-11-25, and QWAKK's 27 unchanged. |
| CLI | `--token qwakk` (default) or `--token qcat`, and the new `propose` command. CLI `npm test`: 38 of 38 passed on 2026-11-25, among them the rebuild of Diana's proposal 38 message byte for byte. |
| EVM window | Unscoped, 1 transaction, opened on the deployer on 2026-11-25 ([`FEA81AD0...84A5`](https://explore.qore.network/tx/FEA81AD0EE854B33966B05BDC4F42474E4542DB5E9A1E43773DD6D563AE984A5), height 10,737,124, code 0) and used by the deploy. |
| On chain | **Deployed on 2026-11-25** at `0x36a4D630898e22dedD8eF5978FC8C527D1698456` (`qor1x6jdvvyf3c3dahvw7ktcljx9ylgknpzkpsaxw2`), block 10,737,140, 380,328 gas ([`6E5D3E68...AF78`](https://explore.qore.network/tx/6E5D3E6812546C463FAF55AF286F86172CBED72E9C430040C125E557286FAF78); EVM hash `0x78fb47cd...7a5b`). The CLI checked name, symbol, decimals, supply and the deployer's 1,000,000,000 QCAT on chain. Expected bank denom: `erc20:0x36a4D630898e22dedD8eF5978FC8C527D1698456`, display unit `QuantumCat` at exponent 6. |
| Registration | **Registered on 2026-11-25** by proposal 49, submitted by the deployer with the normal 10 QOR deposit ([`97701E51...205C`](https://explore.qore.network/tx/97701E511FA84CF78141B5393D90ED70D052039350F4498157BC53E3DA2D205C), height 10,737,162) and passed when voting ended at 20:12:35 UTC: token pair `erc20:0x36a4D630898e22dedD8eF5978FC8C527D1698456`, enabled, `OWNER_EXTERNAL`, bank metadata as expected. |
| Conversion and transfer | The whole supply was converted to bank coins on 2026-11-26 ([`F1D092C2...C9A4`](https://explore.qore.network/tx/F1D092C2982351A4D14C86CE0BCC75C8CFB8CD7CC1992213FDDA24448BEDC9A4), height 10,775,270, code 0) and sent to the owner's QoreX wallet `qor1wl5jxt3n5fxez4csxe7t67xcfyvxr69y3mn4dq` ([`A713AB56...A414`](https://explore.qore.network/tx/A713AB5692AA4B51F96B61405C4864A2C5C474804EBB0AFD0D08DE76E874A414), height 10,775,283, code 0). The owner holds 1,000,000,000 QCAT; the deployer holds 0. |
| Pool | QCAT/QOR is pool 7, created by the owner with QoreX on 2026-11-26 at height 10,775,408 with 400,000,000 QCAT and 40,000 QOR (1 QCAT = 0.0001 QOR). `QCAT_TOKEN_ADDRESS` is set in `lib/qwakk-assets.ts` and `indexer/token-registry.ts`. |

The app shows QCAT with a cat head cropped from the QCAT team's tokenomics
artwork (`public/tokens/qcat.webp`, source in `marketing/qcat/`), a
placeholder until the QCAT team sends an official logo.

## License

MIT, like the rest of this repository.

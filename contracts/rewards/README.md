# qwakk-rewards

A small CosmWasm contract that pays Qwakk liquidity rewards as Merkle claims
on QoreChain Diana. Each week the indexer finalizes an epoch into a Merkle
tree of `(address, amount)`; the owner registers it here as a **stage**, funded
with exactly the stage total, and each LP claims its own amount with QoreX.

CosmWasm is open on QoreChain Diana only; mainnet keeps code upload and
instantiation closed (docs: developer-guide/cosmwasm-development).

## Status

| | |
| --- | --- |
| Contract and tests | Built. `cargo test`: 18 passed (3 unit, 15 cw-multi-test), 2026-11-25. |
| Optimized build | Reproducible: two clean builds with `cosmwasm/optimizer-arm64:0.16.1` gave the same sha256. See "Build". |
| Static check | `cosmwasm-check` 2.3.5 (the VM in Diana's wasmvm v2.3.5) passes with only the `iterator` capability. |
| Local chain rehearsal | Passed on a throwaway wasmd v0.60.2 node (wasmvm v2.2.4, SDK v0.53.0) on 2026-11-25. See "Rehearsal". |
| Store-code proposal | **Passed.** Diana proposal 50 (expedited), submitted 2026-11-25 17:50 UTC ([`7AC3CD90...3555`](https://explore.qore.network/tx/7AC3CD90DA59D5BE8ABB51250EA2C57A410D8452429C598DB93CED9B8AD03555)), passed at 18:50 UTC. |
| On QoreChain Diana | **Stored as code 866** (checksum `3c953fbc...f006`, matches `artifacts/checksums.txt`). **Instantiated** at `qor1xdmy3ruvchrt8rmcg6kqx08lypgsahfz79qnqq6nxk4qmmv856pqe8y28w`, height 10,743,928 ([`D0C01343...1256`](https://explore.qore.network/tx/D0C0134397EEC5ED6B7076D8779F5D786E7CCCC40740506F122F9A5E07D81256)). Owner and wasm admin: the testnet deployer `qor1lndgla7rrh8cjq8enly3cldkaze3z2jupzakmp`. No stages yet. |
| Claim with QoreX | **Not verified.** The app builds the claim (`lib/qwakk-native-rewards.ts`); no QoreX-signed claim exists yet. |

## The contract

| Message | Who | What |
| --- | --- | --- |
| `instantiate {owner}` | anyone | Sets the owner. No funds. |
| `register_stage {denom, merkle_root, total, start, end, pool_id, label}` | owner | Must carry exactly `total` of `denom` and nothing else. `merkle_root` is 64 hex characters. `start` and `end` are Unix seconds; claims are open in `[start, end)` and `end` must be in the future. Stage ids count up from 1. `label` is at most 128 characters. |
| `claim {stage_id, amount, proof}` | anyone | Inside the window, not paused, not yet claimed by the sender for this stage, proof valid, and `claimed + amount <= total` for this stage. Pays `amount` to the sender. No funds may be attached. |
| `reclaim {stage_id}` | owner | From `end` on: sends the unclaimed rest to the owner and closes the stage. |
| `pause_stage` / `resume_stage {stage_id}` | owner | Stops or restarts claims on one stage. |
| `propose_owner {new_owner}`, `cancel_owner_proposal {}`, `accept_owner {}` | owner, then the new owner | Two-step ownership transfer. |
| `migrate {}` | wasm admin (enforced by the chain) | Upgrades in place, keeps all state, refuses another contract's state and any downgrade (cw2). |

Queries: `config {}`, `stage {id}`, `stages {start_after, limit}` (default 10,
max 30), `is_claimed {stage_id, address}` (returns `claimed` and `amount`).

Every error starts with `qwakk-rewards: `, so the app maps a refused simulation
to fixed copy (`classifySimulationError` in `lib/qwakk-native-tx.ts`).

### Stages are isolated

The reference `cw20-merkle-airdrop` 0.14.2 only checks the contract's whole
balance when it pays a claim, so one wrong root can drain every stage. Here
every stage is funded with exactly its own total at registration and keeps its
own `claimed` counter, and a claim is refused once it would pass that stage's
total. A wrong root or a bug in one week's tree can therefore only ever cost
that one stage's funds. The tests `a_bad_root_cannot_touch_another_stage` and
the rehearsal's stage 3 check exactly that.

### Merkle encoding (shared with the indexer)

```
leaf = sha256("qwakk-rewards-v1" || u64_be(stage_id) || u8(len(address)) || address (qor1 bech32, UTF-8) || u128_be(amount))
node = sha256(min(a, b) || max(a, b))      byte-wise comparison
tree: leaves sorted ascending, neighbours paired, an odd last node carried up unchanged
verify: h = leaf; for p in proof: h = node(h, p); h == root
```

The leaf binds the stage id, so a tree only works as the stage id it was built
for: register stages in order (the CLI refuses a stage file whose `stage_id`
is not the contract's next stage). The shared vector `testdata/vector.json`
(made by `testdata/vector.py`, root `a546da3d...eeacac`) is asserted by the
contract tests, the app tests (`tests/qwakk-native-rewards.test.ts`) and the
indexer.

### Upgrades

The contract is instantiated with a wasm **admin** (by default the owner's
wallet), so a fixed version can be migrated in place at the same address,
keeping every stage and claim. A new code version on Diana still needs its own
store-code governance proposal first, because code upload is governance only.
`migrate` refuses a downgrade and another contract's state. Per-stage funding
keeps any bug's blast radius to one stage even before a fix is migrated in.

## Build

```sh
cd contracts/rewards
docker run --rm -v "$(pwd)":/code \
  --mount type=volume,source=qwakk_rewards_cache,target=/target \
  --mount type=volume,source=qwakk_rewards_registry,target=/usr/local/cargo/registry \
  cosmwasm/optimizer-arm64:0.16.1
cat artifacts/checksums.txt
```

| | |
| --- | --- |
| Artifact | `artifacts/qwakk_rewards.wasm`, 276,340 bytes (101,027 bytes gzip) |
| sha256 | `3c953fbcdcaa8c2899d04d97dff5de6b762f3b366d9d098575e8f2d3bff0f006` |
| Toolchain | the optimizer image's Rust 1.81.0 and wasm-opt 116; `Cargo.lock` is pinned to crates that build on Rust 1.81 (`rust-version = "1.81"`) |
| Shape | 11 exports, 372 functions, 17 initial memory pages, no floats; Diana allows 128 exports, 4,096 functions and 64 pages (docs: cosmwasm-gas-and-limits) |

The x86 image (`cosmwasm/optimizer:0.16.1`) produces a different checksum; the
proposal names the arm64 image, as Diana's docs example does.

Tests (any machine with Docker; the same image has `cargo`):

```sh
docker run --rm -v "$(pwd)":/code -w /code --entrypoint sh cosmwasm/optimizer-arm64:0.16.1 -c 'cargo test --locked'
```

Static check:

```sh
cosmwasm-check --available-capabilities iterator artifacts/qwakk_rewards.wasm   # cosmwasm-check 2.3.5
```

## Rehearsal (local chain, 2026-11-25)

A throwaway `cosmwasm/wasmd:v0.60.2` node (no host ports, removed afterwards)
with a bank denom spelled exactly like QWAKK's
(`erc20:0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23`) ran the optimized
artifact:

| Step | Result |
| --- | --- |
| Store | Code 1, checksum `3C953FBC...F006` (matches the build), 1,917,005 gas |
| Instantiate with admin = owner | 148,847 gas; contract admin is the owner |
| Register with wrong funds, no funds, from a stranger | refused (`attach exactly the stage total`, `unauthorized`) |
| Stage 1: the shared vector root, total 3,500,007 | registered, 146,561 gas (its claims need the vector's `qor1` keys, which a `wasm1` chain cannot have) |
| A local account using a vector proof | refused, `invalid proof` |
| Stage 2: same amounts, local addresses | 3 claims paid exactly 1,000,000, 2,500,000 and 7 (about 160,000 gas each) |
| Double claim, someone else's proof, funds attached | refused (`already claimed`, `invalid proof`, `no funds may be attached`) |
| Stage 3: tree promises 200, funded 150 | first 100 paid; the second refused with `stage total exceeded`; stage 1's 3,500,007 untouched |
| Stage with a 25 s window | claim inside paid; `reclaim` before the end refused (`stage still running`); claim after the end refused (`claim window ended`); stranger reclaim refused; owner reclaim returned exactly the unclaimed 20; a second reclaim refused (`stage closed`) |
| Tree built for the wrong stage id | its claims refused (`stage not found`, then `claim window ended`); owner reclaimed all 30 |
| Migrate | by a stranger refused (`can not migrate: unauthorized`); by the admin to the same code succeeded (116,396 gas), history INIT then MIGRATE, cw2 `crates.io:qwakk-rewards` 0.1.0, every claim and stage kept, double claim still refused |
| Contract balance at the end | 3,500,057 = stage 1's 3,500,007 + stage 3's unclaimed 50 |

Diana's own gas will differ: Diana charges a cold code load on the first call
of a code in a block (docs: cosmwasm-gas-and-limits), so always simulate.

## Proposal

`npm run rewards -- propose --dry-run` (from `contracts/cli`) builds the
proposal, checks it against the live chain and simulates the hybrid-signed
transaction on Diana without sending it. Dry run on 2026-11-25:

| | |
| --- | --- |
| Messages | 1. `MsgResetCircuitBreaker` for `/cosmwasm.wasm.v1.MsgStoreCode`; 2. `MsgStoreCode` with the gzip code and instantiate permission Everybody; 3. `MsgTripCircuitBreaker` for the same. All signed by the gov module `qor10d07y265gmmuvt4z0w9aw880jnsr700jwfyxr3`. Identical, field by field apart from the code, to the first three messages of Diana proposal 40 (checked live by the CLI). No instantiate inside the proposal. |
| Live state | `MsgStoreCode` breaker tripped, `code_upload_access` Nobody, `instantiate_default_permission` Everybody |
| Kind | Expedited (default; `--normal` for a regular one): deposit 50 QOR (live `expedited_min_deposit`), voting 3,600 s, yes threshold 66.7%; a failed expedited tally continues as a normal proposal |
| Gas | simulated 19,981,492; limit 25,975,940 (1.3x), under Diana's 50,000,000 per-transaction cap |
| Fee | 3.246993 QOR (0.125 uqor per gas) |
| Deployer | `qor1lndgla7rrh8cjq8enly3cldkaze3z2jupzakmp`: 86.314551 QOR before, 33.067558 QOR after the deposit and fee (the deposit returns when the proposal passes) |

The summary names the checksum and the source path, so commit and push
`contracts/rewards` before submitting, so voters can rebuild it.

## Runbook (QoreChain Diana)

From `contracts/cli`, with `QORE_MNEMONIC` (the testnet-only deployer) in
`contracts/.env`. Every sending command prints its plan and waits for "yes".

| Step | Command | Sends |
| --- | --- | --- |
| 1 | `npm run rewards -- propose --dry-run` | nothing |
| 2 | `npm run rewards -- propose` | the proposal (50 QOR deposit, about 3.25 QOR fee) |
| 3 | after it passes: `npm run rewards -- code-id` | nothing |
| 4 | `npm run rewards -- instantiate --code-id <id> --owner <owner qor1> [--admin <qor1>]` (admin defaults to the owner) | one instantiate |
| 5 | put `QWAKK_REWARDS_CONTRACT_ADDRESS` in `contracts/.env`, the indexer and the web app | nothing |
| 6 | indexer: `npm run rewards -- finalize ... --apply --out stage.json`; then here: `npm run rewards -- register stage.json` (only when the deployer is the owner; the owner wallet registers otherwise) | one register_stage with the stage total |
| 7 | test claim: `npm run rewards -- claim --stage 1 --amount <a> --proof <h1,h2>` | one claim |
| 8 | after a stage ends: `npm run rewards -- reclaim <stage>` | one reclaim |

`npm run rewards -- status` prints the contract, its config and stages.

## Layout

```
src/contract.rs      entry points: instantiate, execute, query, migrate
src/merkle.rs        leaf, node, verify
src/msg.rs, state.rs messages and storage
src/error.rs         errors, all prefixed "qwakk-rewards: "
tests/integration.rs cw-multi-test suite and the shared vector
testdata/            vector.json and vector.py (shared with the indexer and the app)
artifacts/           the optimized wasm and checksums.txt
```

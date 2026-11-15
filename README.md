# Qwakk

Swap it. Qwakk it.

Qwakk is a non-custodial interface for QoreChain's native `x/amm` module. The
current target is the Diana testnet. Qwakk does not deploy or use a separate EVM
AMM contract.

## Current status

Qwakk is read-only today. Swap, pool creation and liquidity flows are built but
stay hidden until native signing works end to end (see Wallet actions below).

What works:

- Pool, market, account and transaction data are read from Diana.
- Swap quotes use the native AMM quote endpoint (`/qorechain/amm/v1/quote/exact_in`),
  which the live keeper answers (it returns "pool not found" until a pool
  exists). Qwakk adds price impact, blocks swaps above the chain's
  `max_swap_impact_bps` cap and re-quotes before the wallet opens.
- Liquidity positions are read from the AMM LP balance query. The AMM keeps LP
  shares in its own store, not as bank tokens.
- The indexer stores pools, swaps and 1m, 5m, 1h, 6h and 1d candles in
  PostgreSQL. Pool pages chart 1m, 5m, 1h and 1d candles.
- Native actions are prepared on the server (`/api/native-tx/prepare`): it
  builds the messages, simulates them against Diana and returns them for QoreX
  `signAndBroadcast` (QoreX 0.3.5 or newer). QoreX asks the user to approve,
  adds its post-quantum layer, signs and broadcasts. Qwakk never signs or relays
  a transaction. The server only prepares native AMM messages, plus the
  disclosed interface fee transfer on a swap.
- QOR/USD price, volume and market cap come from CoinGecko and are labeled as
  such wherever they appear.

What is blocking trading (checked on 2026-10-12):

- The native AMM keeper is live on Diana: a simulated `MsgCreatePool` fails on
  balances instead of "not implemented". No pool exists yet.
- Update 2026-10-31: Diana now has test tokens next to `uqor`. Qwakk's asset
  registry (`lib/qwakk-assets.ts`) lists them with their exact, case-sensitive
  denoms: fUSD (6 decimals), fETH (18), fBTC (8), each an `erc20:0x...` denom,
  and ATOM (`ibc/27394FB...`, shown with 6 decimals because its chain metadata
  only lists `uatom`). Other denoms are read from bank metadata through
  `/api/native/assets`. When a token's decimals cannot be confirmed, amount
  entry for it is blocked instead of guessed. Pool 1 (fETH/QOR) exists with dust
  reserves. A keyless simulation of a QOR to fETH swap on it succeeded.
- QoreX 0.3.5 refuses bare classical `signDirect` on QoreChain networks. Qwakk
  now uses QoreX `signAndBroadcast`, where the wallet adds the post-quantum
  layer. This path is built but not yet verified end to end on Diana: run the
  signing probe below.

### Wallet actions

Swap, pool creation and add or remove liquidity are implemented behind one
switch:

```text
QWAKK_NATIVE_ACTIONS=enabled
```

It is read at runtime, so it can be changed in CapRover without a rebuild.
While it is off, no wallet action is rendered and `/api/native-tx/prepare`
returns 404. When it is on, every action is built on the server, simulated against QoreChain
Diana (so a failing transaction is explained before the wallet opens, and the
gas limit comes from simulated gas), then approved, signed and broadcast by
QoreX and followed into a block. Turn it on only after the signing probe below
succeeds.

QoreX must be 0.3.5 or newer and set to QoreChain Diana (in QoreX: turn on
Developer mode, then Switch to testnet (diana)). Otherwise Qwakk shows an update
or network instruction instead of opening the wallet.

Gas: the prepare route sets `gasLimit = simulated gas x 1.3 + 100000`, clamped to
QoreX's 100000 to 5000000 range. Simulation runs without the post-quantum layer,
which costs about 77k to 91k extra gas on Diana, so the 100k headroom covers it.
QoreX prices the fee itself at 0.15 uqor per gas. If an account has no
post-quantum key on chain yet, QoreX first registers one in a separate
transaction with its own fee.

### Signing probe

`/dev/signing-probe` is available in development only and runs only when you
click "Run probe". It asks QoreX to approve, sign and broadcast a 1 uqor
transfer from the connected wallet to itself on QoreChain Diana, so no pool is
needed. It proves the wallet-built post-quantum transaction and the bank
transfer used for the interface fee. It shows the transaction hash, result
code, block height and an explorer link. The network fee is about 0.03 QOR.

Never add a mnemonic or private key to the repository, browser, PostgreSQL or
CapRover. Qwakk only needs public wallet addresses.

## Pond Vault (Build Before Q-Day)

`contracts/` holds the Qwakk Pond Vault: a post-quantum guarded vault for
Qwakk's interface fees on the QoreChain EVM, Qwakk's entry in the Build Before
Q-Day Post-Quantum dApp category. Every withdrawal or rule change needs the
owner's transaction (sent inside an EVM window scoped to the vault) plus an
ML-DSA-87 approval that the contract checks with QoreChain's `pqcVerify` and
`pqcKeyStatus` precompiles, then waits out a timelock (withdrawals also stay
within a daily cap). By default the owner and the approver are one account, so
one mnemonic holds both keys; a separate approver account makes them independent.

- Contract, Foundry tests and threat model: [`contracts/README.md`](contracts/README.md)
- Owner and approver CLI: `contracts/cli` (`npm run pond -- help`)
- Read-only dashboard: `/vault`, enabled by `QWAKK_VAULT_ADDRESS` (web app,
  testnet only). Without it the page says the vault is not deployed.

The vault is separate from trading: swaps, pools and liquidity stay on the
QoreChain Native rail (`x/amm`). It is not deployed on Diana yet, and the
interface fee treasury does not point at it. Approvals are signed by the
owner's local CLI, never by the web app or a server.

## Requirements

- Node.js `>=22.13.0`
- PostgreSQL 16 for the indexer
- Docker for the production image

## Local verification

```bash
npm ci
npm test
npm run lint
npm run typecheck
```

To run the full local stack (testnet by default):

```bash
docker compose up --build
```

The web application is available on port `3001`, the indexer on port `4400`
and PostgreSQL on port `5438`. For a separate mainnet stack, add
`--env-file deploy/compose.mainnet.env` (ports `3101`, `4500` and `5439`).

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, lint, typecheck and
`npm test` on pushes to `main` and on pull requests, and builds the production
Docker image.

## Architecture

The same root Docker image can run in two roles:

- `QWAKK_PROCESS_ROLE=web`: starts the Qwakk web application on port `3000`.
- `QWAKK_PROCESS_ROLE=indexer`: starts the QoreChain indexer on port `4400`.

The indexer reads Diana REST/RPC data and writes normalized pools, swaps and
candles to PostgreSQL. The web application reads that indexed data through the
indexer and queries Diana server-side for live account and quote data.

## CapRover deployment

Each network is its own deployment of three CapRover apps: PostgreSQL, the
indexer and the web app. Testnet and mainnet never share an app, a database or
a treasury address. All six apps deploy the same repository and the same
`captain-definition`; environment variables pick the role and the network.

| Role | Testnet app | Mainnet app | Container HTTP port |
| --- | --- | --- | --- |
| PostgreSQL | `qwakk-postgres` | `qwakk-mainnet-postgres` | 5432 (private) |
| Indexer | `qwakk-indexer` | `qwakk-mainnet-indexer` | 4400 (private) |
| Web | `qwakk-web` | `qwakk-mainnet-web` | 3000 (public, HTTPS) |

The names are suggestions and also become CapRover's internal hostnames
(`srv-captain--<app-name>`). Only the web apps get a public domain. Do not
enable "Expose as web app" or port mappings on PostgreSQL or the indexer, and
never map the web container port to the host: the rate limiter trusts the
client IP that CapRover's nginx adds (see "Rate limits and client IPs").

### Environment per network

`QWAKK_NETWORK` selects the chain preset on both the web app and the indexer.
The public QoreChain endpoints come from that preset
(`lib/qwakk-network.ts`), so `QORECHAIN_REST_URL`, `QORECHAIN_RPC_URL` and
`QORECHAIN_EVM_RPC_URL` are optional overrides for a private node. Do not set
them to an empty value. The full list with comments is in `.env.example`.

| Variable | Web | Indexer | Testnet | Mainnet |
| --- | --- | --- | --- | --- |
| `QWAKK_PROCESS_ROLE` | `web` | `indexer` | | |
| `QWAKK_NETWORK` | yes | yes | `testnet` | `mainnet` |
| `DATABASE_URL` | | yes | testnet database | mainnet database |
| `QWAKK_INDEXER_URL` | yes | | `http://srv-captain--qwakk-indexer:4400` | `http://srv-captain--qwakk-mainnet-indexer:4400` |
| `QWAKK_INDEXER_PORT` | | yes | `4400` | `4400` |
| `QWAKK_INDEXER_START_HEIGHT` | | optional | a block the node still keeps (Diana prunes, about six days) | any block (mainnet keeps all) |
| `QWAKK_TREASURY_ADDRESS` | yes | yes (excluded from points) | testnet treasury (pending) | mainnet treasury, owner decides |
| `QWAKK_SWAP_FEE_BPS` | yes | | `10` (fee on) | owner decides |
| `QWAKK_POINTS_ENABLED` | yes | yes | `enabled` | owner decides |
| `QWAKK_NATIVE_ACTIONS` | yes | | per launch checklist | owner decides |
| `QWAKK_VAULT_ADDRESS` | yes | | Pond Vault `0x` address, optional (`/vault`) | ignored |
| `QWAKK_BLOCKED_POOL_IDS`, `QWAKK_BLOCKED_DENOMS` | yes | | empty unless pausing | empty unless pausing |
| `QWAKK_HEALTH_MAX_INDEXER_LAG` | optional | | `600` default | `600` default |
| `QWAKK_SITE_URL` | yes | | the testnet web domain | the mainnet web domain |
| `COINGECKO_API_KEY` | optional | | | |
| `QWAKK_RATE_LIMIT`, `QWAKK_TRUSTED_PROXY_HOPS` | optional | | defaults | defaults |
| `PORT` | `3000` | | | |

Owner decisions for the testnet launch: the interface fee is on
(`QWAKK_SWAP_FEE_BPS=10` plus a valid public `QWAKK_TREASURY_ADDRESS`; without
a valid address the fee stays off) and points are on
(`QWAKK_POINTS_ENABLED=enabled` on both testnet apps). Mainnet values are
decided separately.

`QWAKK_SWAP_FEE_BPS` must be a whole number from 0 to 30 (0.30%, the limit
promised on the public `/fees` page); any other value turns the fee off, and so
does a missing or invalid treasury address.

### 1. PostgreSQL

Create a one-click PostgreSQL 16 app per network (`qwakk-postgres`,
`qwakk-mainnet-postgres`) with a persistent volume. Give each its own strong
password and keep it private to the CapRover network.

```text
POSTGRES_DB=qwakk
POSTGRES_USER=qwakk
POSTGRES_PASSWORD=<strong-password, different per network>
```

### 2. Indexer

Create `qwakk-indexer` (and `qwakk-mainnet-indexer`), deploy this repository
and set the container HTTP port to `4400`. Testnet example:

```text
QWAKK_PROCESS_ROLE=indexer
QWAKK_NETWORK=testnet
DATABASE_URL=postgresql://qwakk:<url-encoded-password>@srv-captain--qwakk-postgres:5432/qwakk
QWAKK_INDEXER_PORT=4400
# Optional: first block to index on a fresh database. It must still be kept by
# the node. Without it the indexer starts from the current height.
QWAKK_INDEXER_START_HEIGHT=
QWAKK_POINTS_ENABLED=enabled
QWAKK_TREASURY_ADDRESS=<public-testnet-qor-address>
# Owner and test wallets kept off the leaderboard (comma separated qor1 addresses).
QWAKK_POINTS_EXCLUDED_ADDRESSES=
```

For mainnet use `QWAKK_NETWORK=mainnet`, the mainnet database host
`srv-captain--qwakk-mainnet-postgres` and the mainnet decisions above. The
indexer health endpoint is `/health`.

#### Points settings

Points rank on-chain activity on Qwakk pools and have no monetary value. Every
rule is an indexer environment variable. Leave a variable empty to use the
default. A change applies on the next indexer start, and the whole season is
rescored from the stored swaps, liquidity events and hourly LP snapshots.
Pools without a QOR side score 0 for now.

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWAKK_POINTS_ENABLED` | off | `enabled` turns on the public points API (web app and indexer) |
| `QWAKK_POINTS_SEASON` | `testnet-1` | Season name |
| `QWAKK_POINTS_SEASON_START_HEIGHT` | `0` | First block of the season (0 = first indexed block) |
| `QWAKK_POINTS_SEASON_END_HEIGHT` | open | Last block of the season |
| `QWAKK_POINTS_EXCLUDED_ADDRESSES` | none | Addresses kept off the leaderboard; `QWAKK_TREASURY_ADDRESS` is added when set |
| `QWAKK_POINTS_MIN_SWAP_QOR` | `1` | Smallest swap (QOR side) that counts |
| `QWAKK_POINTS_SWAP_POINTS_PER_QOR` | `1` | Points per QOR of counted swap volume |
| `QWAKK_POINTS_SWAP_DAILY_FULL_QOR` | `1000` | Daily volume per address at the full rate |
| `QWAKK_POINTS_SWAP_DAILY_MAX_QOR` | `10000` | Daily volume per address above which nothing counts |
| `QWAKK_POINTS_SWAP_EXCESS_FACTOR_BPS` | `2000` | Rate between the full and max daily volume (20%) |
| `QWAKK_POINTS_ROUND_TRIP_WINDOW_SECONDS` | `1800` | A reversal in the same pool within this window is a round trip |
| `QWAKK_POINTS_ROUND_TRIP_FACTOR_BPS` | `1000` | Weight of round trip volume on both legs (10%) |
| `QWAKK_POINTS_LP_POINTS_PER_QOR_HOUR` | `0.01` | Points per QOR of position value per hour held |
| `QWAKK_POINTS_LP_HOURLY_FULL_QOR` | `5000` | Hourly position value per address at the full rate |
| `QWAKK_POINTS_LP_HOURLY_MAX_QOR` | `50000` | Hourly position value per address above which nothing counts |
| `QWAKK_POINTS_LP_EXCESS_FACTOR_BPS` | `2000` | Rate between the full and max hourly value (20%) |
| `QWAKK_POINTS_LP_MIN_HOLD_HOURS` | `6` | Consecutive hours a position must be held before any hour counts |
| `QWAKK_POINTS_LP_MAX_INTERVAL_HOURS` | `3` | Longest gap between two snapshots that is still credited |
| `QWAKK_POINTS_POOL_BONUS` | `500` | One-time points for a created pool once it is used |
| `QWAKK_POINTS_POOL_BONUS_MIN_TRADERS` | `5` | Other addresses with counted swaps needed to unlock the bonus |
| `QWAKK_POINTS_POOL_BONUS_MAX_PER_ADDRESS` | `3` | Most pool bonuses per creator in a season |
| `QWAKK_POINTS_ACTIVE_DAY_POINTS` | `50` | Points per UTC day with a qualifying action |
| `QWAKK_POINTS_MIN_ACTION_QOR` | `1` | Smallest liquidity add or pool creation (QOR side) that counts as activity |

### 3. Web application

Create `qwakk-web` (and `qwakk-mainnet-web`), deploy the same repository, set
the container HTTP port to `3000`, attach the domain and turn on HTTPS with
"Force HTTPS". Testnet example:

```text
QWAKK_PROCESS_ROLE=web
QWAKK_NETWORK=testnet
QWAKK_INDEXER_URL=http://srv-captain--qwakk-indexer:4400
QWAKK_TREASURY_ADDRESS=<public-testnet-qor-address>
QWAKK_SWAP_FEE_BPS=10
QWAKK_POINTS_ENABLED=enabled
# Off until the launch checklist says otherwise. A comma list such as
# swap,liquidity turns on only those actions.
QWAKK_NATIVE_ACTIONS=
# Emergency pause for single pools or tokens.
QWAKK_BLOCKED_POOL_IDS=
QWAKK_BLOCKED_DENOMS=
QWAKK_SITE_URL=https://<testnet-web-domain>
# Optional CoinGecko demo key for higher market data limits.
COINGECKO_API_KEY=
PORT=3000
```

Health checks:

- `/api/health?shallow=1` only says the process answers. The Docker
  `HEALTHCHECK` uses it, so a QoreChain or indexer outage never makes Swarm
  restart the web container.
- `/api/health` is the deep check for monitoring: the configured endpoints
  answer with the configured chain id, the indexer answers and is at most
  `QWAKK_HEALTH_MAX_INDEXER_LAG` blocks behind. It returns 503 otherwise.

After configuring the apps of a network, deploy the same branch to each:

```bash
caprover deploy -n <captain-machine-name> -a qwakk-indexer -b main
caprover deploy -n <captain-machine-name> -a qwakk-web -b main
# Mainnet
caprover deploy -n <captain-machine-name> -a qwakk-mainnet-indexer -b main
caprover deploy -n <captain-machine-name> -a qwakk-mainnet-web -b main
```

The root `captain-definition` uses the production `Dockerfile`; the environment
role selects which process starts. To try the mainnet stack locally:
`docker compose --env-file deploy/compose.mainnet.env up --build` (its own
containers, ports 3101, 4500 and 5439, and its own volume).

### Rate limits and client IPs

`proxy.ts` runs before every page and API route. It sets the security headers
(a nonce based Content-Security-Policy on pages, `frame-ancestors 'none'`,
`X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`)
and rate limits `/api/*` per client IP with in-memory token buckets
(`lib/qwakk-rate-limit.ts`). Over budget, a route answers 429 with a JSON
`error` and `Retry-After`.

| Bucket | Routes | Burst | Refill per minute |
| --- | --- | --- | --- |
| `tx-build` | `/api/native-tx/prepare`, `/api/native-tx/probe` | 10 | 12 |
| `positions` | `/api/positions` | 5 | 4 |
| `tx-status` | `/api/native-tx/status` | 30 | 40 |
| `quote` | `/api/swap-quote` | 30 | 30 |
| `chain-read` | `/api/account`, `/api/transactions`, `/api/native/*` | 40 | 60 |
| `api` | every other `/api/*` route | 120 | 240 |

`/api/health` is never limited. Network, markets and activity are also served
from 4 to 5 second server caches, so polling them costs one upstream read per
cache period no matter how many clients poll.

The client IP is the last `X-Forwarded-For` entry, which CapRover's nginx
appends from the TCP peer it saw (`proxy_add_x_forwarded_for`). Entries a
client sends itself sit to the left and are ignored. If another proxy that
appends to `X-Forwarded-For`, such as Cloudflare, is put in front of CapRover,
set `QWAKK_TRUSTED_PROXY_HOPS=2`. `QWAKK_RATE_LIMIT=off` turns the limiter off
in an emergency. Buckets live in one process: with several web replicas each
replica counts on its own.

Optional outer layer in CapRover's nginx (shared by all replicas, applied
before a request reaches Node). The zones go into the http context once, in
CapRover's base nginx configuration (Settings, NGINX Configurations, inside
`http { ... }`), because an app's own configuration can be rendered more than
once and a duplicate zone stops nginx from reloading:

```nginx
limit_req_zone $binary_remote_addr zone=qwakk_testnet_api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=qwakk_testnet_tx:10m rate=20r/m;
```

Then in the web app's HTTP Settings, "Edit Default Nginx Configurations", add
these two locations inside the main `server { ... }` block, next to the
existing `location / { ... }` (they reuse its `$upstream` and proxy headers).
Use `qwakk_mainnet_*` zones for the mainnet app.

```nginx
        location ~ ^/api/(native-tx/(prepare|probe)|positions)(/|$) {
            limit_req zone=qwakk_testnet_tx burst=15 nodelay;
            limit_req_status 429;
            proxy_pass $upstream;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        location /api/ {
            limit_req zone=qwakk_testnet_api burst=100 nodelay;
            limit_req_status 429;
            proxy_pass $upstream;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
```

These limits are looser than the app's own, so the app stays the primary
limiter and nginx only stops floods. Save during a quiet moment and check
that the site still loads; CapRover rejects a configuration nginx cannot load.

### Database backups

The indexer database holds the points history and every indexed swap. Diana
prunes old blocks after about six days, so testnet data older than that cannot
be indexed again; mainnet can be re-indexed but slowly. CapRover's own backup
covers its configuration, not app volumes. Recommended per network:

- A nightly `pg_dump` on the server, kept for 14 days and copied off the
  server (object storage or another machine):

  ```bash
  mkdir -p /var/backups/qwakk
  docker exec $(docker ps -q -f name=srv-captain--qwakk-postgres) \
    pg_dump -U qwakk -d qwakk -Fc > /var/backups/qwakk/testnet-$(date +%F).dump
  find /var/backups/qwakk -name '*.dump' -mtime +14 -delete
  ```

  Run it from the host crontab, for example `15 3 * * *`. Repeat with
  `srv-captain--qwakk-mainnet-postgres` and a `mainnet-` file name.
- Before every deploy that changes `indexer/schema.sql`, take one manual dump.
- Once a month, restore the latest dump into a scratch database with
  `pg_restore` to prove the backups work.

## First Diana pool

The bootstrap command uses the official QoreChain SDK and creates a native
`MsgCreatePool`. It performs a dry run unless `--broadcast` is explicitly
provided.

Set `QWAKK_TESTNET_MNEMONIC` only in the current trusted terminal session. Do not
put it in `.env`, shell history, CapRover or source control.

```bash
npm run pool:testnet -- --denom-a uqor --amount-a 100000000 --denom-b <second-denom> --amount-b <base-units>
npm run pool:testnet -- --denom-a uqor --amount-a 100000000 --denom-b <second-denom> --amount-b <base-units> --broadcast
```

The wallet must have enough QOR for the current 100 QOR pool creation fee,
initial liquidity and transaction gas. Use a separate testnet-only wallet.

## Launch-day AMM check

Once a pool exists, run the keyless verifier before turning
`QWAKK_NATIVE_ACTIONS` on. It never signs or broadcasts. It compares Qwakk's
swap, add-liquidity and remove-liquidity math with QoreChain's quote and with
simulated keeper events, simulates the interface fee transfer and the swap in
one transaction, and prints a pass/fail table:

```bash
npm run verify:amm -- --pool <id> --address <qor1 address holding both tokens>
```

Use an address that holds both pool tokens and some QOR so the simulations get
past the bank step. The script header lists every option.

## Useful commands

- `npm run build`: build the production application.
- `npm test`: build and run SSR plus native AMM calculation tests.
- `npm run lint`: lint the full project.
- `npm run typecheck`: type-check the full project. The build does not type-check.
- `npm run indexer`: start only the local indexer.
- `npm run pool:testnet`: prepare or broadcast the first native Diana pool.
- `npm run verify:amm`: check Qwakk's AMM math and messages against a live pool without signing.

Native AMM reference: <https://docs.qorechain.io/architecture/amm/>

## License

The source code is MIT, see [LICENSE](LICENSE). The Qwakk name, logo, icons and artwork are not: all rights reserved, see [NOTICE.md](NOTICE.md). Forks must use their own name and branding.

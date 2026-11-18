# Qwakk indexer

Reads QoreChain blocks (RPC) and AMM state (REST), writes pools, swaps,
liquidity events, candles and LP snapshots to PostgreSQL, and serves them on
port 4400. `schema.sql` is applied on every start and only ever adds things.

Run it locally with `npm run indexer` from `qwakk-app` (or `./dev.sh`).

## Network

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWAKK_NETWORK` | `testnet` | `testnet` (QoreChain Diana, `qorechain-diana`) or `mainnet` (`qorechain-vladi`). Picks the default endpoints and the curated token list. |
| `QORECHAIN_REST_URL` | network preset | Overrides the REST endpoint (for example a private node). The other network's public endpoint is ignored with a warning. |
| `QORECHAIN_RPC_URL` | network preset | Same, for the RPC endpoint. |
| `QWAKK_INDEXER_ADOPT_CHAIN_ID` | unset | Only for an old database written before chain ids were recorded: confirms which chain it holds. Without it such a database is treated as testnet data. |

The presets mirror `lib/qwakk-network.ts` (the indexer image ships only this
folder, so it keeps its own copy in `indexer-config.ts`).

### Chain id guard

On start the indexer reads the chain id from the RPC (`/status`,
`node_info.network`) and the REST gateway (`/cosmos/base/tendermint/v1beta1/node_info`).
It refuses to start, with a clear error, when:

- the node serves a different chain than `QWAKK_NETWORK` names,
- REST and RPC serve different chains,
- the database is labelled with another chain (`indexer_state.chain_id`).

A new database is labelled on its first start. Every sync tick checks the RPC
chain id again and writes nothing if it changed. Use one database per network.

## Start height

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWAKK_INDEXER_START_HEIGHT` | unset | First block to index on a fresh database. |

On a fresh database without `QWAKK_INDEXER_START_HEIGHT`, indexing starts at
the earliest pool's creation block when pools already exist (no swap can be
older than its pool), otherwise at the chain tip. It never starts below the
node's earliest kept block.

- **Testnet (Diana)** prunes old blocks (about 6 days kept on 2026-10-31). If a
  saved height falls behind the earliest kept block, the gap is logged, stored
  in `indexer_state.pruned_gap` and indexing resumes at the earliest kept block.
- **Mainnet** keeps every block (earliest height 1) and had no pools and only
  `uqor` on 2026-10-31. Start at the tip, the default. If pools exist by the
  time the mainnet indexer first runs, the default above starts at the first
  pool's creation block. To keep history from before the first pool (for
  example a token's registration), set `QWAKK_INDEXER_START_HEIGHT` to that
  block on the first start only.

Far behind the tip, the indexer finds AMM blocks with the RPC `tx_search` and
reads only those. Before trusting the search it checks that it finds an AMM
event already known to the database; otherwise it scans every block.

## Health

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWAKK_INDEXER_MAX_LAG` | `600` | Blocks behind the tip before `/health` is not ok. Same default as the web's deep health check. |
| `QWAKK_INDEXER_MAX_SYNC_AGE_SECONDS` | `120` | Seconds without sync progress before `/health` reports `stalled`. |

- `GET /livez`: `200 {"ok":true}` while the process answers. Use it for container restarts.
- `GET /health`: `200` when ok, `503` otherwise.

```json
{
  "network": "testnet",
  "ok": true,
  "status": "ok",
  "chainId": "qorechain-diana",
  "height": "9236634",
  "chainHeight": "9236650",
  "lag": 16,
  "maxLag": 600,
  "lastSyncAt": "2026-10-31T20:00:00.000Z",
  "lastErrorAt": null
}
```

`status` is `starting` (no sync yet), `ok`, `lagging` (more than `maxLag`
behind) or `stalled` (no progress for `maxSyncAgeSeconds`). `height` is the
last indexed block.

## Retention

A job runs every `QWAKK_RETENTION_INTERVAL_MINUTES` and logs what it pruned.
Raw swaps and liquidity events are never deleted.

| Variable | Default | What is pruned |
| --- | --- | --- |
| `QWAKK_RETENTION` | on | `off` disables the whole job. |
| `QWAKK_RETENTION_INTERVAL_MINUTES` | `60` | How often the job runs (minimum 5). |
| `QWAKK_RETENTION_CANDLES_1M_DAYS` | `7` | 1m candles older than this. The API serves 24 hours of them (minimum 2). |
| `QWAKK_RETENTION_CANDLES_5M_DAYS` | `14` | 5m candles older than this. The API serves 3 days of them (minimum 4). |
| `QWAKK_RETENTION_SWAP_RAW_EVENT_DAYS` | `30` | `swaps.raw_event` of older swaps is emptied to `{}`. Amounts, denoms, sender and price stay. |
| `QWAKK_RETENTION_LP_SNAPSHOT_DAYS` | `90` | LP snapshots older than this, only when no season is set (`QWAKK_POINTS_SEASON_START_HEIGHT` is 0 or unset). When a season start height is set, only snapshots below it are pruned, whether or not points are public, because scoring rebuilds the season from them either way. The latest snapshot of every position is always kept. |

Setting any period to `0` keeps that data forever. The 1h, 4h and 1d candles
are not pruned; latest prices are read from 1h candles so they survive 1m
pruning.

4h candles replaced 6h. On every start, before the first sync, the indexer
fills 4h candles that are missing from the stored 1h candles (open of the first
hour, close of the last, high and low extremes, summed volume and trades), so
history indexed before 4h existed gets charts without a reindex or manual SQL.
Buckets that already have a 4h row are left untouched. Old 6h rows stay in the
table, are no longer written or served, and `interval=6h` answers 400.

## Endpoints

- `GET /markets`: every pool with quote-oriented prices, volume, TVL and `low_liquidity`.
- `GET /pools/:id?interval=1m|5m|1h|4h|1d`: one pool, its candles (`candles` B per A, `quote_candles` quote per base) and its latest 60 swaps.
- `GET /positions/:address`: the address's open LP positions from indexed data:

```json
{
  "address": "qor1...",
  "indexedHeight": "9236634",
  "positions": [
    {
      "poolId": "1",
      "tokenA": "erc20:0x0229...",
      "tokenB": "uqor",
      "tokenASymbol": "fETH",
      "tokenBSymbol": "QOR",
      "tokenADecimals": 18,
      "tokenBDecimals": 6,
      "lpDenom": "amm-lp/1",
      "lpBalance": "1000022",
      "lpSupply": "1000022",
      "reserveA": "980129",
      "reserveB": "1020319",
      "source": "snapshot_and_events",
      "asOfHeight": "9005181"
    }
  ]
}
```

  The balance is the latest hourly LP snapshot (the chain's LP balance query)
  plus LP minted and burned by the address's later events, or the sum of its
  events when no snapshot exists yet (`source`: `snapshot`,
  `snapshot_and_events`, `events`). `lpBalance` is `null` with `source`
  `incomplete` when an event did not carry an LP amount; read that pool from
  the chain. Positions opened while the indexer was not indexing (for example
  inside a pruned gap) only appear once they have an indexed event.
- `GET /points/...`: only while `QWAKK_POINTS_ENABLED` is on.

## Rebuilding candles

When a token's decimals change, affected pools are listed in
`indexer_state.stale_candle_pools`. `rebuild-candles.ts` rebuilds their swap
prices and candles from raw swaps; see its header. It is never run automatically.
It refuses to run when `QWAKK_NETWORK` does not match the database's
`indexer_state.chain_id`, or when the database has no label and
`--assume-chain-id` is not given.

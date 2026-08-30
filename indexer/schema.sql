CREATE TABLE IF NOT EXISTS indexer_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tokens (
  denom TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT,
  decimals INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pools (
  id BIGINT PRIMARY KEY,
  pool_type TEXT NOT NULL,
  creator TEXT,
  token_a TEXT NOT NULL,
  token_b TEXT NOT NULL,
  lp_denom TEXT,
  status TEXT NOT NULL,
  created_at_chain TIMESTAMPTZ,
  amplification_coefficient INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pool_snapshots (
  id BIGSERIAL PRIMARY KEY,
  pool_id BIGINT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reserve_a NUMERIC NOT NULL,
  reserve_b NUMERIC NOT NULL,
  lp_supply NUMERIC NOT NULL,
  weighted_avg_price NUMERIC,
  UNIQUE (pool_id, observed_at)
);

CREATE INDEX IF NOT EXISTS pool_snapshots_pool_observed_idx ON pool_snapshots (pool_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS swaps (
  id BIGSERIAL PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL DEFAULT 0,
  pool_id BIGINT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  height BIGINT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL,
  sender TEXT,
  denom_in TEXT NOT NULL,
  amount_in NUMERIC NOT NULL,
  denom_out TEXT NOT NULL,
  amount_out NUMERIC NOT NULL,
  price_b_per_a NUMERIC,
  raw_event JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tx_hash, event_index)
);

CREATE INDEX IF NOT EXISTS swaps_pool_executed_idx ON swaps (pool_id, executed_at DESC);

CREATE TABLE IF NOT EXISTS candles (
  pool_id BIGINT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  interval TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume_qor NUMERIC,
  transactions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pool_id, interval, start_time)
);

CREATE INDEX IF NOT EXISTS candles_pool_interval_time_idx ON candles (pool_id, interval, start_time DESC);

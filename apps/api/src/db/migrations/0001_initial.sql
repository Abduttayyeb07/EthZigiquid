CREATE TABLE IF NOT EXISTS settings (
  id UUID PRIMARY KEY,
  wallet_address TEXT,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_runtime (
  id TEXT PRIMARY KEY,
  encrypted_payload TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cycles (
  id UUID PRIMARY KEY,
  cycle_number BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'stopped')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY,
  cycle_id UUID REFERENCES cycles(id),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  status TEXT NOT NULL,
  transaction_hash TEXT UNIQUE,
  sell_token TEXT NOT NULL,
  buy_token TEXT NOT NULL,
  sell_amount NUMERIC(78, 0) NOT NULL,
  buy_amount NUMERIC(78, 0),
  gas_used NUMERIC(78, 0),
  gas_cost_usd NUMERIC(20, 8),
  volume_usd NUMERIC(20, 8),
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gas_history (
  id BIGSERIAL PRIMARY KEY,
  max_fee_per_gas NUMERIC(78, 0) NOT NULL,
  gas_limit NUMERIC(78, 0) NOT NULL,
  eth_usd NUMERIC(20, 8) NOT NULL,
  estimated_fee_usd NUMERIC(20, 8) NOT NULL,
  accepted BOOLEAN NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS error_events (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  retryable BOOLEAN NOT NULL,
  suggested_action TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rpc_health (
  id BIGSERIAL PRIMARY KEY,
  endpoint_hash TEXT NOT NULL,
  healthy BOOLEAN NOT NULL,
  latency_ms INTEGER,
  block_number BIGINT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  request_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trades_created_at_idx ON trades (created_at DESC);
CREATE INDEX IF NOT EXISTS cycles_started_at_idx ON cycles (started_at DESC);
CREATE INDEX IF NOT EXISTS gas_history_recorded_at_idx ON gas_history (recorded_at DESC);
CREATE INDEX IF NOT EXISTS error_events_created_at_idx ON error_events (created_at DESC);

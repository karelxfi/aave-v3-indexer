-- Aave V3 Events Table
CREATE TABLE IF NOT EXISTS aave_events (
  -- Event metadata
  block_number UInt32,
  tx_hash String,
  log_index UInt16,
  timestamp DateTime CODEC (DoubleDelta, ZSTD),

  -- Event type
  event_type LowCardinality(String),

  -- Common fields
  reserve String,
  user String,
  amount UInt256,

  -- Supply/Withdraw specific
  on_behalf_of Nullable(String),
  to Nullable(String),

  -- Borrow/Repay specific
  interest_rate_mode Nullable(UInt8),
  borrow_rate Nullable(UInt256),
  repayer Nullable(String),
  use_a_tokens Nullable(Bool),

  -- Referral
  referral_code Nullable(UInt16),

  -- Rollback tracking
  sign Int8 DEFAULT toInt8(1)
)
ENGINE = CollapsingMergeTree(sign)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (reserve, block_number, tx_hash, log_index, event_type);

-- Daily Metrics Table
CREATE TABLE IF NOT EXISTS aave_daily_metrics (
  date Date,
  reserve String,

  -- Deposits (Supply + Repay)
  total_deposits Float64,
  deposit_count UInt64,

  -- Withdrawals (Withdraw + Borrow)
  total_withdrawals Float64,
  withdrawal_count UInt64,

  -- Net flow
  net_flow Float64,

  -- Rollback tracking
  sign Int8 DEFAULT toInt8(1)
)
ENGINE = CollapsingMergeTree(sign)
PARTITION BY toYYYYMM(date)
ORDER BY (date, reserve);

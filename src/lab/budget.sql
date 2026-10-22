CREATE TABLE IF NOT EXISTS lab_budget_limits (
  scope TEXT PRIMARY KEY,
  limit_micro_usd INTEGER NOT NULL CHECK (limit_micro_usd >= 0)
);
CREATE TABLE IF NOT EXISTS lab_budget_models (
  agent_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  max_request_cost_micro_usd INTEGER NOT NULL CHECK (max_request_cost_micro_usd >= 0)
);
CREATE TABLE IF NOT EXISTS lab_budget_reservations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  max_cost_micro_usd INTEGER NOT NULL CHECK (max_cost_micro_usd >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'settled', 'uncertain')),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  cost_micro_usd INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  failed INTEGER NOT NULL DEFAULT 0,
  retry INTEGER NOT NULL DEFAULT 0,
  breached INTEGER NOT NULL DEFAULT 0,
  settlement TEXT
);
CREATE INDEX IF NOT EXISTS lab_budget_agent ON lab_budget_reservations(agent_id);
CREATE INDEX IF NOT EXISTS lab_budget_task ON lab_budget_reservations(task_id);

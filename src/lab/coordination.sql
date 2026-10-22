CREATE TABLE IF NOT EXISTS lab_agents (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('active', 'stopped', 'expired')),
  registered_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lab_fencing_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT
);
CREATE TABLE IF NOT EXISTS lab_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'done')),
  owner TEXT REFERENCES lab_agents(id),
  token TEXT UNIQUE,
  expires_at INTEGER,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  evidence TEXT,
  claim_count INTEGER NOT NULL DEFAULT 0,
  execution_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lab_task_dependencies (
  task_id TEXT NOT NULL REFERENCES lab_tasks(id),
  depends_on TEXT NOT NULL REFERENCES lab_tasks(id),
  PRIMARY KEY (task_id, depends_on)
);
CREATE TABLE IF NOT EXISTS lab_file_claims (
  path TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES lab_agents(id),
  token TEXT UNIQUE NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lab_file_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES lab_agents(id),
  token TEXT,
  operation TEXT NOT NULL,
  previous_owner TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lab_task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES lab_tasks(id),
  agent_id TEXT REFERENCES lab_agents(id),
  token TEXT,
  operation TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lab_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES lab_agents(id),
  recipient TEXT REFERENCES lab_agents(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lab_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES lab_agents(id),
  category TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  task_id TEXT REFERENCES lab_tasks(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER CHECK (ended_at >= started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS lab_activity_current ON lab_activity(agent_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS lab_activity_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL REFERENCES lab_activity(id),
  category TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL,
  corrected_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lab_tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES lab_agents(id),
  task_id TEXT REFERENCES lab_tasks(id),
  tool TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  created_at INTEGER NOT NULL
);

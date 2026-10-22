import type { SwarmDb } from "../store/db.js";
import type { ClaimResult, LabTask } from "./lab-types.js";
import {
  DEFAULT_LEASE_TTL_MS,
  fencingToken,
  getTask,
  liveAgent,
  nonempty,
  positiveDuration,
} from "./coordination-store.js";

function event(
  db: SwarmDb,
  taskId: string,
  agentId: string | null,
  token: string | null,
  operation: string,
  now: number,
): void {
  db.sql
    .prepare("INSERT INTO lab_task_events (task_id, agent_id, token, operation, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(taskId, agentId, token, operation, now);
}
export function createTask(db: SwarmDb, id: string, title: string, dependencies: string[], now: number): LabTask {
  nonempty(id, "task id", 128);
  nonempty(title, "task title", 4096);
  if (new Set(dependencies).size !== dependencies.length) throw new Error("Duplicate task dependency");
  for (const dependency of dependencies) {
    if (dependency === id) throw new Error("Task cannot depend on itself");
    getTask(db, dependency);
  }
  // Dependencies must already exist, so task creation cannot introduce a cycle.
  db.sql.prepare("INSERT INTO lab_tasks (id, title, created_at) VALUES (?, ?, ?)").run(id, title, now);
  for (const dependency of dependencies) {
    db.sql.prepare("INSERT INTO lab_task_dependencies (task_id, depends_on) VALUES (?, ?)").run(id, dependency);
  }
  event(db, id, null, null, "created", now);
  return getTask(db, id);
}

function dependenciesComplete(db: SwarmDb, task: LabTask): void {
  if (task.dependencies.some((id) => getTask(db, id).status !== "done"))
    throw new Error(`Task dependencies are incomplete: ${task.id}`);
}

export function acquireTask(
  db: SwarmDb,
  agentId: string,
  id: string,
  now: number,
  ttlMs = DEFAULT_LEASE_TTL_MS,
): ClaimResult {
  const agent = liveAgent(db, agentId, now);
  const task = getTask(db, id);
  positiveDuration(ttlMs);
  if (task.status !== "open") throw new Error(`Task is not open: ${id}`);
  dependenciesComplete(db, task);
  const token = fencingToken(db);
  const expiresAt = Math.min(now + ttlMs, agent.expiresAt);
  db.sql
    .prepare(
      `UPDATE lab_tasks SET status = 'claimed', owner = ?, token = ?, expires_at = ?,
    claimed_at = ?, claim_count = claim_count + 1 WHERE id = ?`,
    )
    .run(agentId, token, expiresAt, now, id);
  event(db, id, agentId, token, "claimed", now);
  return { token, expiresAt };
}

function ownedTask(db: SwarmDb, agentId: string, id: string, token: string, now: number): LabTask {
  liveAgent(db, agentId, now);
  const task = getTask(db, id);
  if (
    task.status !== "claimed" ||
    task.owner !== agentId ||
    task.token !== token ||
    task.expiresAt === null ||
    task.expiresAt <= now
  )
    throw new Error(`Valid task lease required: ${id}`);
  return task;
}

export function renewTask(
  db: SwarmDb,
  agentId: string,
  id: string,
  token: string,
  now: number,
  ttlMs = DEFAULT_LEASE_TTL_MS,
): ClaimResult {
  ownedTask(db, agentId, id, token, now);
  positiveDuration(ttlMs);
  const expiresAt = Math.min(now + ttlMs, liveAgent(db, agentId, now).expiresAt);
  db.sql.prepare("UPDATE lab_tasks SET expires_at = ? WHERE id = ?").run(expiresAt, id);
  event(db, id, agentId, token, "renewed", now);
  return { token, expiresAt };
}

function reopen(db: SwarmDb, id: string, now: number): void {
  db.sql
    .prepare(
      `UPDATE lab_tasks SET execution_ms = execution_ms + MAX(0, ? - claimed_at),
    status = 'open', owner = NULL, token = NULL, expires_at = NULL, claimed_at = NULL WHERE id = ?`,
    )
    .run(now, id);
}

export function expireTasks(db: SwarmDb, now: number, agentId?: string): void {
  const rows = db.sql.prepare("SELECT id, owner, token, expires_at FROM lab_tasks WHERE status = 'claimed'").all();
  for (const row of rows) {
    if (agentId ? row.owner !== agentId : Number(row.expires_at) > now) continue;
    const at = Math.min(now, Number(row.expires_at));
    reopen(db, String(row.id), at);
    event(db, String(row.id), String(row.owner), String(row.token), "expired", at);
  }
}

export function releaseTask(db: SwarmDb, agentId: string, id: string, token: string, now: number): LabTask {
  ownedTask(db, agentId, id, token, now);
  reopen(db, id, now);
  event(db, id, agentId, token, "released", now);
  return getTask(db, id);
}

export function completeTask(
  db: SwarmDb,
  agentId: string,
  id: string,
  token: string,
  evidence: string,
  now: number,
): LabTask {
  const task = ownedTask(db, agentId, id, token, now);
  nonempty(evidence, "completion evidence");
  dependenciesComplete(db, task);
  db.sql
    .prepare(
      `UPDATE lab_tasks SET execution_ms = execution_ms + MAX(0, ? - claimed_at),
    status = 'done', token = NULL, expires_at = NULL, claimed_at = NULL, completed_at = ?, evidence = ? WHERE id = ?`,
    )
    .run(now, now, evidence, id);
  event(db, id, agentId, token, "completed", now);
  return getTask(db, id);
}

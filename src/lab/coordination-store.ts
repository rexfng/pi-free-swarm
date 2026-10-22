import path from "node:path";
import type { SwarmDb } from "../store/db.js";
import type { FileClaim, LabAgent, LabMessage, LabTask } from "./lab-types.js";

export const DEFAULT_AGENT_TTL_MS = 60_000;
export const DEFAULT_LEASE_TTL_MS = 30_000;

export function positiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Duration must be a positive safe integer");
  return value;
}
export function nonempty(value: string, label: string, max = 16_384): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
export function logicalPath(value: string): string {
  nonempty(value, "path", 4096);
  const portable = value.normalize("NFC").replaceAll("\\", "/").toLowerCase();
  const parts = portable.split("/");
  if (
    path.posix.isAbsolute(portable) ||
    /^[A-Za-z]:/.test(portable) ||
    parts.some(
      (part) =>
        part === ".." ||
        /^(?:\.git|git~[1-9])$/.test(part.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "")) ||
        /[:\x00-\x1f\x7f]/.test(part) ||
        (part !== "." && /[. ]$/.test(part)) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(part),
    )
  ) {
    throw new Error("File path must be project-relative without traversal, Git metadata, or platform aliases");
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === "." || normalized.endsWith("/")) throw new Error("A file path is required");
  return normalized;
}
export function fencingToken(db: SwarmDb): string {
  const allocate = db.sql.prepare("INSERT INTO lab_fencing_tokens DEFAULT VALUES");
  allocate.setReadBigInts(true);
  const sequence = allocate.run().lastInsertRowid;
  return `lease:${sequence}`;
}
export function getAgent(db: SwarmDb, id: string): LabAgent | undefined {
  const row = db.sql.prepare("SELECT * FROM lab_agents WHERE id = ?").get(id);
  if (!row) return undefined;
  const state = row.state;
  if (state !== "active" && state !== "stopped" && state !== "expired") throw new Error("Invalid agent state");
  return {
    id: String(row.id),
    state,
    registeredAt: Number(row.registered_at),
    heartbeatAt: Number(row.heartbeat_at),
    expiresAt: Number(row.expires_at),
  };
}
export function liveAgent(db: SwarmDb, id: string, now: number): LabAgent {
  const agent = getAgent(db, id);
  if (!agent || agent.state !== "active" || agent.expiresAt <= now) throw new Error(`Agent is not active: ${id}`);
  return agent;
}
export function agents(db: SwarmDb): LabAgent[] {
  return db.sql
    .prepare("SELECT id FROM lab_agents ORDER BY registered_at, id")
    .all()
    .map((row) => {
      const agent = getAgent(db, String(row.id));
      if (!agent) throw new Error("Agent disappeared inside transaction");
      return agent;
    });
}
export function getTask(db: SwarmDb, id: string): LabTask {
  const row = db.sql.prepare("SELECT * FROM lab_tasks WHERE id = ?").get(id);
  if (!row) throw new Error(`Task not found: ${id}`);
  const status = row.status;
  if (status !== "open" && status !== "claimed" && status !== "done") throw new Error("Invalid task state");
  const dependencies = db.sql
    .prepare("SELECT depends_on FROM lab_task_dependencies WHERE task_id = ? ORDER BY depends_on")
    .all(id)
    .map((dependency) => String(dependency.depends_on));
  return {
    id: String(row.id),
    title: String(row.title),
    status,
    owner: nullableString(row.owner),
    token: nullableString(row.token),
    expiresAt: nullableNumber(row.expires_at),
    dependencies,
    createdAt: Number(row.created_at),
    completedAt: nullableNumber(row.completed_at),
    evidence: nullableString(row.evidence),
    claimCount: Number(row.claim_count),
    executionMs: Number(row.execution_ms),
  };
}
export function tasks(db: SwarmDb): LabTask[] {
  return db.sql
    .prepare("SELECT id FROM lab_tasks ORDER BY created_at, id")
    .all()
    .map((row) => getTask(db, String(row.id)));
}
export function claims(db: SwarmDb): FileClaim[] {
  return db.sql
    .prepare("SELECT * FROM lab_file_claims ORDER BY path")
    .all()
    .map((row) => ({
      path: String(row.path),
      agentId: String(row.agent_id),
      token: String(row.token),
      acquiredAt: Number(row.acquired_at),
      expiresAt: Number(row.expires_at),
    }));
}
export function messages(db: SwarmDb, agentId?: string, after = 0): LabMessage[] {
  const query =
    agentId === undefined
      ? db.sql.prepare("SELECT * FROM lab_messages WHERE id > ? ORDER BY id").all(after)
      : db.sql
          .prepare(
            "SELECT * FROM lab_messages WHERE id > ? AND (recipient IS NULL OR recipient = ? OR agent_id = ?) ORDER BY id",
          )
          .all(after, agentId, agentId);
  return query.map((row) => ({
    id: Number(row.id),
    agentId: String(row.agent_id),
    to: nullableString(row.recipient),
    body: String(row.body),
    createdAt: Number(row.created_at),
  }));
}
export function nullableString(value: unknown): string | null {
  return value === null ? null : String(value);
}
export function nullableNumber(value: unknown): number | null {
  return value === null ? null : Number(value);
}

import type { SwarmDb } from "../store/db.js";
import {
  ACTIVITY_CATEGORIES,
  type ActivityCategory,
  type ActivityInterval,
  type ActivitySource,
  type AgentActivityMetrics,
  type LabAgent,
  type ToolCall,
} from "./lab-types.js";
import { nullableNumber, nullableString } from "./coordination-store.js";

const ACTIVITY_SOURCES = ["explicit", "tool", "lifecycle", "correction"] as const;

export function category(value: unknown): ActivityCategory {
  for (const allowed of ACTIVITY_CATEGORIES) if (value === allowed) return allowed;
  throw new Error(`Unknown activity category: ${String(value)}`);
}
export function source(value: unknown): ActivitySource {
  for (const allowed of ACTIVITY_SOURCES) if (value === allowed) return allowed;
  throw new Error(`Unknown activity source: ${String(value)}`);
}
export function confidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Confidence must be between 0 and 1");
  return value;
}
export function classifyTool(tool: string, success = true): { category: ActivityCategory; confidence: number } {
  if (!success) return { category: "debugging", confidence: 0.55 };
  const name = tool.toLowerCase();
  if (/compact|summariz/.test(name)) return { category: "compaction", confidence: 0.95 };
  if (/test|vitest|pytest|jest|playwright/.test(name)) return { category: "testing", confidence: 0.95 };
  if (/review|git diff/.test(name)) return { category: "review", confidence: 0.8 };
  if (/claim|lease|message|register|heartbeat|task|swarm|budget/.test(name))
    return { category: "coordination", confidence: 0.95 };
  if (/patch|edit|write_file/.test(name)) return { category: "implementation", confidence: 0.9 };
  if (/search|read|fetch|browse|\brg\b|\bls\b/.test(name)) return { category: "research", confidence: 0.75 };
  if (/debug|trace/.test(name)) return { category: "debugging", confidence: 0.8 };
  return { category: "housekeeping", confidence: 0.25 };
}

export function closeActivity(db: SwarmDb, agentId: string, at: number): void {
  db.sql
    .prepare("UPDATE lab_activity SET ended_at = MAX(started_at, ?) WHERE agent_id = ? AND ended_at IS NULL")
    .run(at, agentId);
}

export function transition(
  db: SwarmDb,
  agentId: string,
  activity: ActivityCategory,
  origin: ActivitySource,
  certainty: number,
  at: number,
  taskId: string | null = null,
): number {
  category(activity);
  source(origin);
  confidence(certainty);
  const current = db.sql.prepare("SELECT * FROM lab_activity WHERE agent_id = ? AND ended_at IS NULL").get(agentId);
  const start = Math.max(at, Number(current?.started_at ?? at));
  closeActivity(db, agentId, start);
  return Number(
    db.sql
      .prepare(
        `INSERT INTO lab_activity
    (agent_id, category, source, confidence, task_id, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(agentId, activity, origin, certainty, taskId, start).lastInsertRowid,
  );
}

export function toolActivity(
  db: SwarmDb,
  agentId: string,
  tool: string,
  success: boolean,
  durationMs: number,
  now: number,
  taskId: string | null,
): void {
  const inferred = classifyTool(tool, success);
  const current = db.sql.prepare("SELECT * FROM lab_activity WHERE agent_id = ? AND ended_at IS NULL").get(agentId);
  const resumeExplicit = current?.source === "explicit" || current?.source === "correction";
  // Clamp overlapping tool spans against the current interval; aggregate wall time cannot double count.
  transition(db, agentId, inferred.category, "tool", inferred.confidence, now - durationMs, taskId);
  if (resumeExplicit && current) {
    transition(
      db,
      agentId,
      category(current.category),
      source(current.source),
      Number(current.confidence),
      now,
      nullableString(current.task_id),
    );
  } else {
    transition(db, agentId, "idle", "lifecycle", 1, now, null);
  }
}

export function correctActivity(
  db: SwarmDb,
  agentId: string,
  id: number,
  activity: ActivityCategory,
  now: number,
): void {
  category(activity);
  const row = db.sql.prepare("SELECT * FROM lab_activity WHERE id = ? AND agent_id = ?").get(id, agentId);
  if (!row) throw new Error("Activity interval not found for agent");
  db.sql
    .prepare(
      `INSERT INTO lab_activity_corrections
    (activity_id, category, source, confidence, corrected_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, String(row.category), String(row.source), Number(row.confidence), now);
  db.sql
    .prepare("UPDATE lab_activity SET category = ?, source = 'correction', confidence = 1 WHERE id = ?")
    .run(activity, id);
}

export function intervals(db: SwarmDb, now: number): ActivityInterval[] {
  return db.sql
    .prepare("SELECT * FROM lab_activity ORDER BY started_at, id")
    .all()
    .map((row) => ({
      id: Number(row.id),
      agentId: String(row.agent_id),
      category: category(row.category),
      source: source(row.source),
      confidence: Number(row.confidence),
      taskId: nullableString(row.task_id),
      startedAt: Number(row.started_at),
      endedAt: nullableNumber(row.ended_at),
      durationMs: Math.max(0, Number(row.ended_at ?? now) - Number(row.started_at)),
    }));
}

export function toolCalls(db: SwarmDb): ToolCall[] {
  return db.sql
    .prepare("SELECT * FROM lab_tool_calls ORDER BY id")
    .all()
    .map((row) => ({
      id: Number(row.id),
      agentId: String(row.agent_id),
      taskId: nullableString(row.task_id),
      tool: String(row.tool),
      success: Number(row.success) === 1,
      durationMs: Number(row.duration_ms),
      createdAt: Number(row.created_at),
    }));
}

export function activityMetrics(
  agents: LabAgent[],
  activity: ActivityInterval[],
  calls: ToolCall[],
): AgentActivityMetrics[] {
  return agents.map((agent) => {
    const activityMs: Record<ActivityCategory, number> = {
      understanding: 0,
      research: 0,
      hypothesis: 0,
      implementation: 0,
      debugging: 0,
      testing: 0,
      review: 0,
      coordination: 0,
      compaction: 0,
      housekeeping: 0,
      idle: 0,
      blocked: 0,
    };
    for (const interval of activity)
      if (interval.agentId === agent.id) activityMs[interval.category] += interval.durationMs;
    const ownCalls = calls.filter((call) => call.agentId === agent.id);
    const activeMs = Object.values(activityMs).reduce((a, b) => a + b, 0) - activityMs.idle - activityMs.blocked;
    return {
      agentId: agent.id,
      activityMs,
      activeMs,
      idleMs: activityMs.idle,
      blockedMs: activityMs.blocked,
      toolCalls: ownCalls.length,
      toolFailures: ownCalls.filter((call) => !call.success).length,
    };
  });
}

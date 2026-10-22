import { readFileSync } from "node:fs";
import type { SwarmDb } from "../store/db.js";
import { closeActivity, correctActivity, toolActivity, transition } from "./activity.js";
import { acquireFile, assertLease, expireFiles, releaseFile, renewFile } from "./coordination-claims.js";
import { snapshot } from "./coordination-status.js";
import {
  agents,
  claims,
  DEFAULT_AGENT_TTL_MS,
  getAgent,
  getTask,
  liveAgent,
  messages,
  nonempty,
  positiveDuration,
  tasks,
} from "./coordination-store.js";
import { acquireTask, completeTask, createTask, expireTasks, releaseTask, renewTask } from "./coordination-tasks.js";
import type {
  ActivityCategory,
  ActivitySource,
  ClaimResult,
  CoordinationStatus,
  FileClaim,
  LabAgent,
  LabMessage,
  LabTask,
  ToolCall,
} from "./lab-types.js";

export { ACTIVITY_CATEGORIES } from "./lab-types.js";

export class Coordination {
  private readonly now: () => number;
  private readonly agentTtlMs: number;

  constructor(
    private readonly db: SwarmDb,
    options: { now?: () => number; agentTtlMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.agentTtlMs = positiveDuration(options.agentTtlMs ?? DEFAULT_AGENT_TTL_MS);
    db.write(() => db.sql.exec(readFileSync(new URL("./coordination.sql", import.meta.url), "utf8")));
    this.recover();
  }

  registerAgent(id: string): LabAgent {
    return this.write((now) => {
      nonempty(id, "agent id", 128);
      if (getAgent(this.db, id)?.state === "active") throw new Error(`Agent is already active: ${id}`);
      this.db.sql
        .prepare(
          `INSERT INTO lab_agents (id, state, registered_at, heartbeat_at, expires_at)
        VALUES (?, 'active', ?, ?, ?) ON CONFLICT (id) DO UPDATE SET state = 'active',
        registered_at = excluded.registered_at, heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at`,
        )
        .run(id, now, now, now + this.agentTtlMs);
      transition(this.db, id, "idle", "lifecycle", 1, now);
      return liveAgent(this.db, id, now);
    });
  }

  heartbeat(id: string): LabAgent {
    return this.write((now) => {
      liveAgent(this.db, id, now);
      this.db.sql
        .prepare("UPDATE lab_agents SET heartbeat_at = ?, expires_at = ? WHERE id = ?")
        .run(now, now + this.agentTtlMs, id);
      return liveAgent(this.db, id, now);
    });
  }

  stopAgent(id: string): void {
    this.write((now) => {
      liveAgent(this.db, id, now);
      this.db.sql.prepare("UPDATE lab_agents SET state = 'stopped', expires_at = ? WHERE id = ?").run(now, id);
      this.releaseResources(id, now);
    });
  }

  recover(): { agents: number; files: number; tasks: number } {
    return this.db.write(() => this.recoverAt(this.clock()));
  }

  createTask(id: string, title: string, dependencies: string[] = []): LabTask {
    return this.write((now) => createTask(this.db, id, title, dependencies, now));
  }

  listTasks(): LabTask[] {
    return this.write(() => tasks(this.db));
  }

  claimTask(agentId: string, taskId: string, ttlMs?: number): ClaimResult {
    return this.write((now) => acquireTask(this.db, agentId, taskId, now, ttlMs));
  }

  renewTask(agentId: string, taskId: string, token: string, ttlMs?: number): ClaimResult {
    return this.write((now) => renewTask(this.db, agentId, taskId, token, now, ttlMs));
  }

  releaseTask(agentId: string, taskId: string, token: string): LabTask {
    return this.write((now) => releaseTask(this.db, agentId, taskId, token, now));
  }

  completeTask(agentId: string, taskId: string, token: string, evidence: string): LabTask {
    return this.write((now) => completeTask(this.db, agentId, taskId, token, evidence, now));
  }

  claimFile(agentId: string, path: string, ttlMs?: number): ClaimResult {
    const result = this.write((now) => acquireFile(this.db, agentId, path, now, ttlMs));
    // Throw after the transaction commits so the failed claim remains in the conflict history.
    if (!result) throw new Error(`File is already claimed: ${path}`);
    return result;
  }

  renewLease(agentId: string, path: string, token: string, ttlMs?: number): ClaimResult {
    return this.write((now) => renewFile(this.db, agentId, path, token, now, ttlMs));
  }

  releaseFile(agentId: string, path: string, token: string): void {
    this.write((now) => releaseFile(this.db, agentId, path, token, now));
  }

  assertFileLease(agentId: string, path: string, token: string): FileClaim {
    return this.write((now) => assertLease(this.db, agentId, path, token, now));
  }

  postMessage(agentId: string, body: string, to?: string): LabMessage {
    return this.write((now) => {
      liveAgent(this.db, agentId, now);
      nonempty(body, "message");
      if (to !== undefined && !getAgent(this.db, to)) throw new Error(`Unknown recipient: ${to}`);
      const id = Number(
        this.db.sql
          .prepare("INSERT INTO lab_messages (agent_id, recipient, body, created_at) VALUES (?, ?, ?, ?)")
          .run(agentId, to ?? null, body, now).lastInsertRowid,
      );
      return { id, agentId, body, to: to ?? null, createdAt: now };
    });
  }

  readMessages(agentId: string, after = 0): LabMessage[] {
    return this.write((now) => {
      liveAgent(this.db, agentId, now);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error("Message cursor must be a nonnegative integer");
      return messages(this.db, agentId, after);
    });
  }

  reportActivity(
    agentId: string,
    category: ActivityCategory,
    source: ActivitySource = "explicit",
    confidence = 1,
    taskId?: string,
  ): number {
    return this.write((now) => {
      liveAgent(this.db, agentId, now);
      if (taskId !== undefined) getTask(this.db, taskId);
      return transition(this.db, agentId, category, source, confidence, now, taskId ?? null);
    });
  }

  correctActivity(agentId: string, intervalId: number, category: ActivityCategory): void {
    this.write((now) => {
      liveAgent(this.db, agentId, now);
      correctActivity(this.db, agentId, intervalId, category, now);
    });
  }

  recordTool(agentId: string, tool: string, success: boolean, durationMs: number, taskId?: string): ToolCall {
    return this.write((now) => {
      const stopped = tool === "stop_agent" && getAgent(this.db, agentId)?.state === "stopped";
      if (!stopped) liveAgent(this.db, agentId, now);
      nonempty(tool, "tool name", 256);
      if (!Number.isSafeInteger(durationMs) || durationMs < 0)
        throw new Error("Tool duration must be a nonnegative integer");
      if (taskId !== undefined) getTask(this.db, taskId);
      const id = Number(
        this.db.sql
          .prepare(
            `INSERT INTO lab_tool_calls
        (agent_id, task_id, tool, success, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(agentId, taskId ?? null, tool, success ? 1 : 0, durationMs, now).lastInsertRowid,
      );
      if (!stopped && tool !== "report_activity" && tool !== "correct_activity") {
        toolActivity(this.db, agentId, tool, success, durationMs, now, taskId ?? null);
      }
      return { id, agentId, tool, success, durationMs, taskId: taskId ?? null, createdAt: now };
    });
  }

  status(): CoordinationStatus {
    return this.write((now) => snapshot(this.db, now));
  }

  private clock(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Clock must return a nonnegative integer timestamp");
    return now;
  }

  private write<T>(fn: (now: number) => T): T {
    const outcome = this.db.write((): { ok: true; value: T } | { ok: false; error: unknown } => {
      const now = this.clock();
      this.recoverAt(now);
      this.db.sql.exec("SAVEPOINT lab_operation");
      try {
        const value = fn(now);
        this.db.sql.exec("RELEASE lab_operation");
        return { ok: true, value };
      } catch (error) {
        this.db.sql.exec("ROLLBACK TO lab_operation; RELEASE lab_operation");
        return { ok: false, error };
      }
    });
    // Recovery commits even when a rejected operation attempts to use expired ownership.
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  private releaseResources(agentId: string, at: number): void {
    expireFiles(this.db, at, agentId);
    expireTasks(this.db, at, agentId);
    closeActivity(this.db, agentId, at);
  }

  private recoverAt(now: number): { agents: number; files: number; tasks: number } {
    const before = {
      agents: 0,
      files: claims(this.db).length,
      tasks: tasks(this.db).filter((task) => task.status === "claimed").length,
    };
    for (const agent of agents(this.db)) {
      if (agent.state !== "active" || agent.expiresAt > now) continue;
      this.db.sql.prepare("UPDATE lab_agents SET state = 'expired' WHERE id = ?").run(agent.id);
      this.releaseResources(agent.id, agent.expiresAt);
      before.agents++;
    }
    expireFiles(this.db, now);
    expireTasks(this.db, now);
    return {
      agents: before.agents,
      files: before.files - claims(this.db).length,
      tasks: before.tasks - tasks(this.db).filter((task) => task.status === "claimed").length,
    };
  }
}

import { z } from "zod";
import { openSwarmDb } from "../store/db.js";
import { Coordination } from "./coordination.js";
import { BudgetLedger } from "./budget.js";
import { WorkspaceManager } from "./workspace.js";
import { ACTIVITY_CATEGORIES } from "./lab-types.js";

export interface LabOptions {
  dbPath: string;
  agentId: string;
  repoPath?: string;
  workspaceRoot?: string;
  agentTtlMs?: number;
}

interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  run(input: unknown): unknown;
}

const id = z.string().min(1).max(120);
const token = z.string().min(1).max(200);
const ttl = z.number().int().min(100).max(3_600_000).optional();

export function openLab(options: LabOptions) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.agentId))
    throw new Error("Agent IDs use 1–64 lowercase letters, digits, underscores or hyphens.");
  if (Boolean(options.repoPath) !== Boolean(options.workspaceRoot))
    throw new Error("Configure both --repo and --workspaces.");
  const db = openSwarmDb(options.dbPath, { create: true });
  const coordination = new Coordination(db, { agentTtlMs: options.agentTtlMs });
  const budget = new BudgetLedger(db);
  const agent = options.agentId;
  const workspaces =
    options.repoPath && options.workspaceRoot
      ? new WorkspaceManager(options.repoPath, options.workspaceRoot)
      : undefined;
  const tools: Tool[] = [];
  function add<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (input: z.infer<z.ZodObject<S>>) => unknown,
  ) {
    const schema = z.strictObject(shape);
    tools.push({ name, description, schema, run: (input) => run(schema.parse(input)) });
  }
  add("register_agent", "Register this connection's fixed agent identity.", {}, () =>
    coordination.registerAgent(agent),
  );
  add("heartbeat", "Renew this agent's presence; resource leases require separate renewal.", {}, () =>
    coordination.heartbeat(agent),
  );
  add("stop_agent", "Stop this agent and recover its claims.", {}, () => coordination.stopAgent(agent));
  add(
    "post_message",
    "Post to the durable board or send a direct message.",
    {
      body: z.string().min(1).max(16_000),
      to: id.optional(),
    },
    ({ body, to }) => coordination.postMessage(agent, body, to),
  );
  add(
    "read_messages",
    "Read board messages and this agent's inbox after a cursor.",
    {
      after: z.number().int().nonnegative().optional(),
    },
    ({ after }) => coordination.readMessages(agent, after),
  );
  add(
    "create_task",
    "Announce a task with explicit prerequisite IDs.",
    {
      id,
      title: z.string().min(1).max(1000),
      dependencies: z.array(id).max(100).optional(),
    },
    ({ id: task, title, dependencies }) => coordination.createTask(task, title, dependencies),
  );
  add("list_tasks", "Discover tasks and their dependencies, owners and status.", {}, () => coordination.listTasks());
  add(
    "claim_task",
    "Atomically claim an available task; retain the returned fencing token.",
    {
      taskId: id,
      ttlMs: ttl,
    },
    ({ taskId, ttlMs }) => coordination.claimTask(agent, taskId, ttlMs),
  );
  add("renew_task", "Renew a still-valid task claim.", { taskId: id, token, ttlMs: ttl }, ({ taskId, token, ttlMs }) =>
    coordination.renewTask(agent, taskId, token, ttlMs),
  );
  add("release_task", "Release a task for another peer to discover.", { taskId: id, token }, ({ taskId, token }) =>
    coordination.releaseTask(agent, taskId, token),
  );
  add(
    "complete_task",
    "Record completion evidence. Evidence is peer-attested, not independent verification.",
    {
      taskId: id,
      token,
      evidence: z.string().min(1).max(16_000),
    },
    ({ taskId, token, evidence }) => coordination.completeTask(agent, taskId, token, evidence),
  );
  add("claim_file", "Acquire an exclusive project-relative file lease.", { path: id, ttlMs: ttl }, ({ path, ttlMs }) =>
    coordination.claimFile(agent, path, ttlMs),
  );
  add(
    "renew_lease",
    "Renew an unexpired file lease with its fencing token.",
    { path: id, token, ttlMs: ttl },
    ({ path, token, ttlMs }) => coordination.renewLease(agent, path, token, ttlMs),
  );
  add("release_file", "Release a file lease owned by this agent.", { path: id, token }, ({ path, token }) =>
    coordination.releaseFile(agent, path, token),
  );
  add(
    "get_budget",
    "Inspect accounted spending, reserved in-flight spending and limits.",
    { taskId: id.optional() },
    ({ taskId }) => budget.status(agent, taskId),
  );
  add(
    "report_activity",
    "Set activity explicitly; use correction source to correct the current classification.",
    {
      category: z.enum(ACTIVITY_CATEGORIES),
      source: z.enum(["explicit", "correction"]).optional(),
      confidence: z.number().min(0).max(1).optional(),
      taskId: id.optional(),
    },
    ({ category, source, confidence, taskId }) =>
      coordination.reportActivity(agent, category, source, confidence, taskId),
  );
  add(
    "correct_activity",
    "Correct an earlier interval while retaining an audit record.",
    {
      intervalId: z.number().int().positive(),
      category: z.enum(ACTIVITY_CATEGORIES),
    },
    ({ intervalId, category }) => coordination.correctActivity(agent, intervalId, category),
  );
  add("get_swarm_status", "Read current peers, tasks, activity, leases and completion state.", {}, () => snapshot());
  add("create_workspace", "Create or return this agent's isolated Git worktree.", {}, () => {
    if (!workspaces) throw new Error("Configure --repo and --workspaces to enable controlled source writes.");
    return db.write(() => workspaces.list().find((entry) => entry.agentId === agent) ?? workspaces.create(agent));
  });
  add(
    "write_file",
    "Write within this agent's worktree while holding a valid exclusive lease.",
    {
      path: id,
      token,
      content: z.string().max(1_048_576),
    },
    ({ path, token, content }) => {
      if (!workspaces) throw new Error("Workspace writes are not configured.");
      const workspace = workspaces.list().find((entry) => entry.agentId === agent);
      if (!workspace) throw new Error("Call create_workspace first.");
      // Hold the DB writer lock through authorization and rename, fencing concurrent reclaims.
      db.write(() =>
        workspaces.writeFile(workspace, path, content, () => coordination.assertFileLease(agent, path, token)),
      );
      return { path, bytes: Buffer.byteLength(content) };
    },
  );

  function snapshot() {
    return { coordination: coordination.status(), budget: budget.status() };
  }
  function call(name: string, input: unknown): unknown {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const started = Date.now();
    let success = false;
    try {
      const result = tool.run(input);
      success = true;
      return result ?? { ok: true };
    } finally {
      // Registration and stopped agents cannot reliably emit their own tool events.
      try {
        if (
          (name === "stop_agent" && success) ||
          coordination.status().agents.some((entry) => entry.id === agent && entry.state === "active")
        ) {
          const taskId =
            typeof input === "object" &&
            input !== null &&
            "taskId" in input &&
            typeof input.taskId === "string" &&
            coordination.listTasks().some((task) => task.id === input.taskId)
              ? input.taskId
              : undefined;
          coordination.recordTool(agent, name, success, Date.now() - started, taskId);
        }
      } catch (error) {
        // A telemetry failure must not turn a committed mutation into an apparent failed operation.
        console.error(`Lab telemetry failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { db, coordination, budget, tools, call, snapshot, close: () => db.close() };
}

export type Lab = ReturnType<typeof openLab>;
export type LabSnapshot = ReturnType<Lab["snapshot"]>;

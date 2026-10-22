import type { SwarmDb } from "../store/db.js";
import { activityMetrics, intervals, toolCalls } from "./activity.js";
import { agents, claims, messages, nullableString, tasks } from "./coordination-store.js";
import type { CoordinationStatus } from "./lab-types.js";

export function snapshot(db: SwarmDb, now: number): CoordinationStatus {
  const allAgents = agents(db);
  const allTasks = tasks(db).map((task) => {
    if (task.status !== "claimed") return task;
    const claimedAt = Number(db.sql.prepare("SELECT claimed_at FROM lab_tasks WHERE id = ?").get(task.id)?.claimed_at);
    return { ...task, executionMs: task.executionMs + Math.max(0, now - claimedAt) };
  });
  const allClaims = claims(db);
  const allMessages = messages(db);
  const allActivities = intervals(db, now);
  const allCalls = toolCalls(db);
  const fileHistory = db.sql
    .prepare("SELECT * FROM lab_file_events ORDER BY id")
    .all()
    .map((row) => ({
      id: Number(row.id),
      path: String(row.path),
      agentId: String(row.agent_id),
      token: nullableString(row.token),
      operation: String(row.operation),
      previousOwner: nullableString(row.previous_owner),
      createdAt: Number(row.created_at),
    }));
  const completed = allTasks.filter((task) => task.status === "done");
  const byAgent = activityMetrics(allAgents, allActivities, allCalls);
  const activeMs = byAgent.reduce((sum, agent) => sum + agent.activeMs, 0);
  const coordinationMs = byAgent.reduce((sum, agent) => sum + agent.activityMs.coordination, 0);
  const taskDurations = completed.reduce(
    (sum, task) => sum + Math.max(0, (task.completedAt ?? now) - task.createdAt),
    0,
  );
  const end =
    allTasks.length > 0 && completed.length === allTasks.length
      ? Math.max(...completed.map((task) => task.completedAt ?? now))
      : now;
  const elapsed = allTasks.length ? Math.max(0, end - Math.min(...allTasks.map((task) => task.createdAt))) : 0;
  return {
    now,
    complete: allTasks.length > 0 && completed.length === allTasks.length && allClaims.length === 0,
    agents: allAgents,
    tasks: allTasks,
    claims: allClaims,
    messages: allMessages,
    activities: allActivities,
    fileHistory,
    toolCalls: allCalls,
    metrics: {
      totalTasks: allTasks.length,
      completedTasks: completed.length,
      messages: allMessages.length,
      fileConflicts: fileHistory.filter((event) => event.operation === "conflict").length,
      taskRetries: allTasks.reduce((sum, task) => sum + Math.max(0, task.claimCount - 1), 0),
      toolCalls: allCalls.length,
      toolFailures: allCalls.filter((call) => !call.success).length,
      averageTaskDurationMs: completed.length ? taskDurations / completed.length : null,
      completedTasksPerMinute: elapsed ? (completed.length * 60_000) / elapsed : 0,
      activeMs,
      coordinationMs,
      coordinationOverheadRatio: activeMs ? coordinationMs / activeMs : 0,
      byAgent,
    },
  };
}

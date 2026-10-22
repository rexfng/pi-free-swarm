export const ACTIVITY_CATEGORIES = [
  "understanding",
  "research",
  "hypothesis",
  "implementation",
  "debugging",
  "testing",
  "review",
  "coordination",
  "compaction",
  "housekeeping",
  "idle",
  "blocked",
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];
export type ActivitySource = "explicit" | "tool" | "lifecycle" | "correction";
export interface LabAgent {
  id: string;
  state: "active" | "stopped" | "expired";
  registeredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}
export interface LabTask {
  id: string;
  title: string;
  status: "open" | "claimed" | "done";
  owner: string | null;
  token: string | null;
  expiresAt: number | null;
  dependencies: string[];
  createdAt: number;
  completedAt: number | null;
  evidence: string | null;
  claimCount: number;
  executionMs: number;
}
export interface ClaimResult {
  token: string;
  expiresAt: number;
}
export interface FileClaim extends ClaimResult {
  path: string;
  agentId: string;
  acquiredAt: number;
}
export interface LabMessage {
  id: number;
  agentId: string;
  to: string | null;
  body: string;
  createdAt: number;
}
export interface ActivityInterval {
  id: number;
  agentId: string;
  category: ActivityCategory;
  source: ActivitySource;
  confidence: number;
  taskId: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
}
export interface FileEvent {
  id: number;
  path: string;
  agentId: string;
  token: string | null;
  operation: string;
  previousOwner: string | null;
  createdAt: number;
}
export interface ToolCall {
  id: number;
  agentId: string;
  taskId: string | null;
  tool: string;
  success: boolean;
  durationMs: number;
  createdAt: number;
}
export interface AgentActivityMetrics {
  agentId: string;
  activeMs: number;
  idleMs: number;
  blockedMs: number;
  toolCalls: number;
  toolFailures: number;
  activityMs: Record<ActivityCategory, number>;
}
export interface CoordinationStatus {
  now: number;
  complete: boolean;
  agents: LabAgent[];
  tasks: LabTask[];
  claims: FileClaim[];
  messages: LabMessage[];
  activities: ActivityInterval[];
  fileHistory: FileEvent[];
  toolCalls: ToolCall[];
  metrics: {
    totalTasks: number;
    completedTasks: number;
    messages: number;
    fileConflicts: number;
    taskRetries: number;
    toolCalls: number;
    toolFailures: number;
    averageTaskDurationMs: number | null;
    completedTasksPerMinute: number;
    activeMs: number;
    coordinationMs: number;
    coordinationOverheadRatio: number;
    byAgent: AgentActivityMetrics[];
  };
}

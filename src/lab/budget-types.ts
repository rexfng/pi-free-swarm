export interface AgentModelBudget {
  provider: string;
  model: string;
  maxRequestCostMicroUsd: number;
  providerEnforcesBound: true;
}

export interface BudgetRequest {
  id: string;
  agentId: string;
  taskId: string;
  provider: string;
  model: string;
  maxCostMicroUsd: number;
}

export interface BudgetUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMicroUsd: number;
  failed?: boolean;
  retry?: boolean;
}

export interface BudgetReservation extends BudgetRequest {
  state: "pending" | "settled" | "uncertain";
  createdAt: number;
  settledAt: number | null;
  costMicroUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  failed: boolean;
  retry: boolean;
  breached: boolean;
}

export interface BudgetScopeStatus {
  scope: string;
  limitMicroUsd: number;
  spentMicroUsd: number;
  reservedMicroUsd: number;
  remainingMicroUsd: number;
}

export interface BudgetStatus {
  frozen: boolean;
  scopes: BudgetScopeStatus[];
  models: (AgentModelBudget & { agentId: string })[];
  reservations: BudgetReservation[];
  requests: number;
  failures: number;
  retries: number;
  unknownUsage: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
  return value;
}

export function identifier(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be nonempty`);
  return value;
}

export function requestScopes(agentId: string, taskId: string): string[] {
  return ["swarm", `agent:${agentId}`, `task:${taskId}`];
}

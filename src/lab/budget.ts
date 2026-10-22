import { readFileSync } from "node:fs";
import type { SwarmDb } from "../store/db.js";
import {
  identifier,
  nonnegativeInteger,
  requestScopes,
  type AgentModelBudget,
  type BudgetRequest,
  type BudgetReservation,
  type BudgetScopeStatus,
  type BudgetStatus,
  type BudgetUsage,
} from "./budget-types.js";

export type * from "./budget-types.js";

export class BudgetLedger {
  constructor(
    private readonly db: SwarmDb,
    private readonly now: () => number = Date.now,
  ) {
    db.write(() => db.sql.exec(readFileSync(new URL("budget.sql", import.meta.url), "utf8")));
  }

  setLimit(scope: string, limitMicroUsd: number): void {
    if (scope !== "swarm" && !/^(agent|task):\S.*$/.test(scope)) throw new Error("Invalid budget scope");
    nonnegativeInteger(limitMicroUsd, "limitMicroUsd");
    this.db.write(() => {
      if (this.scopeStatus(scope, limitMicroUsd).remainingMicroUsd < 0) {
        throw new Error("Limit cannot be lower than spent and in-flight cost");
      }
      this.db.sql
        .prepare(
          `INSERT INTO lab_budget_limits VALUES (?, ?)
        ON CONFLICT(scope) DO UPDATE SET limit_micro_usd=excluded.limit_micro_usd`,
        )
        .run(scope, limitMicroUsd);
    });
  }

  setAgentModel(agentId: string, config: AgentModelBudget): void {
    identifier(agentId, "agentId");
    identifier(config.provider, "provider");
    identifier(config.model, "model");
    nonnegativeInteger(config.maxRequestCostMicroUsd, "maxRequestCostMicroUsd");
    if (config.providerEnforcesBound !== true) throw new Error("A verified provider-enforced bound is required");
    this.db.write(() => {
      this.db.sql
        .prepare(
          `INSERT INTO lab_budget_models VALUES (?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET provider=excluded.provider, model=excluded.model,
        max_request_cost_micro_usd=excluded.max_request_cost_micro_usd`,
        )
        .run(agentId, config.provider, config.model, config.maxRequestCostMicroUsd);
    });
  }

  reserve(request: BudgetRequest): BudgetReservation {
    for (const key of ["id", "agentId", "taskId", "provider", "model"] as const) identifier(request[key], key);
    nonnegativeInteger(request.maxCostMicroUsd, "maxCostMicroUsd");
    return this.db.write(() => {
      if (this.frozen()) throw new Error("Budget frozen: a provider exceeded a reserved bound");
      if (this.find(request.id)) throw new Error("Request ID already used; retries require a new ID");
      const model = this.db.sql.prepare("SELECT * FROM lab_budget_models WHERE agent_id=?").get(request.agentId);
      if (
        !model ||
        model.provider !== request.provider ||
        model.model !== request.model ||
        request.maxCostMicroUsd > Number(model.max_request_cost_micro_usd)
      ) {
        throw new Error("Unknown model or unverified request bound");
      }
      for (const scope of requestScopes(request.agentId, request.taskId)) {
        const limit = this.db.sql.prepare("SELECT limit_micro_usd FROM lab_budget_limits WHERE scope=?").get(scope);
        if (!limit) throw new Error(`Missing budget: ${scope}`);
        const available = this.scopeStatus(scope, Number(limit.limit_micro_usd)).remainingMicroUsd;
        if (request.maxCostMicroUsd > available) throw new Error(`Budget exhausted: ${scope}`);
      }
      this.db.sql
        .prepare(
          `INSERT INTO lab_budget_reservations
        (id,agent_id,task_id,provider,model,max_cost_micro_usd,state,created_at)
        VALUES (?,?,?,?,?,?,'pending',?)`,
        )
        .run(
          request.id,
          request.agentId,
          request.taskId,
          request.provider,
          request.model,
          request.maxCostMicroUsd,
          this.now(),
        );
      return this.require(request.id);
    });
  }

  settle(id: string, usage: BudgetUsage): BudgetReservation {
    const normalized = {
      inputTokens: nonnegativeInteger(usage.inputTokens, "inputTokens"),
      outputTokens: nonnegativeInteger(usage.outputTokens, "outputTokens"),
      cacheReadTokens: nonnegativeInteger(usage.cacheReadTokens ?? 0, "cacheReadTokens"),
      cacheWriteTokens: nonnegativeInteger(usage.cacheWriteTokens ?? 0, "cacheWriteTokens"),
      costMicroUsd: nonnegativeInteger(usage.costMicroUsd, "costMicroUsd"),
      failed: flag(usage.failed),
      retry: flag(usage.retry),
    };
    return this.finish(id, "settled", normalized);
  }

  markUncertain(
    id: string,
    flags: { failed?: boolean; retry?: boolean; observedCostMicroUsd?: number } = {},
  ): BudgetReservation {
    const observedCost = nonnegativeInteger(flags.observedCostMicroUsd ?? 0, "observedCostMicroUsd");
    return this.db.write(() =>
      this.finish(id, "uncertain", {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costMicroUsd: Math.max(this.require(id).maxCostMicroUsd, observedCost),
        failed: flag(flags.failed),
        retry: flag(flags.retry),
      }),
    );
  }

  status(agentId?: string, taskId?: string): BudgetStatus {
    return this.db.write(() => {
      const reservations = this.db.sql
        .prepare(
          `SELECT * FROM lab_budget_reservations
        WHERE (? IS NULL OR agent_id=?) AND (? IS NULL OR task_id=?) ORDER BY created_at,id`,
        )
        .all(agentId ?? null, agentId ?? null, taskId ?? null, taskId ?? null)
        .map(readReservation);
      const selected = new Set([
        "swarm",
        ...(agentId ? [`agent:${agentId}`] : []),
        ...(taskId ? [`task:${taskId}`] : []),
      ]);
      const scopes = this.db.sql
        .prepare("SELECT * FROM lab_budget_limits ORDER BY scope")
        .all()
        .filter((row) => (!agentId && !taskId) || selected.has(String(row.scope)))
        .map((row) => this.scopeStatus(String(row.scope), Number(row.limit_micro_usd)));
      const models: BudgetStatus["models"] = this.db.sql
        .prepare(
          `SELECT * FROM lab_budget_models
        WHERE (? IS NULL OR agent_id=?) ORDER BY agent_id`,
        )
        .all(agentId ?? null, agentId ?? null)
        .map((row) => ({
          agentId: String(row.agent_id),
          provider: String(row.provider),
          model: String(row.model),
          maxRequestCostMicroUsd: Number(row.max_request_cost_micro_usd),
          providerEnforcesBound: true,
        }));
      const sum = (key: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens") =>
        nonnegativeInteger(
          reservations.reduce((total, row) => total + (row[key] ?? 0), 0),
          key,
        );
      return {
        frozen: this.frozen(),
        scopes,
        models,
        reservations,
        requests: reservations.length,
        failures: reservations.filter((row) => row.failed).length,
        retries: reservations.filter((row) => row.retry).length,
        unknownUsage: reservations.filter((row) => row.inputTokens === null).length,
        inputTokens: sum("inputTokens"),
        outputTokens: sum("outputTokens"),
        cacheReadTokens: sum("cacheReadTokens"),
        cacheWriteTokens: sum("cacheWriteTokens"),
      };
    });
  }

  private scopeStatus(scope: string, limitMicroUsd: number): BudgetScopeStatus {
    const [column, owner] =
      scope === "swarm"
        ? [null, null]
        : [scope.startsWith("agent:") ? "agent_id" : "task_id", scope.slice(scope.indexOf(":") + 1)];
    const rows = this.db.sql
      .prepare(
        `SELECT state,cost_micro_usd,max_cost_micro_usd
      FROM lab_budget_reservations ${column ? `WHERE ${column}=?` : ""}`,
      )
      .all(...(owner === null ? [] : [owner]));
    const spentMicroUsd = nonnegativeInteger(
      rows.reduce((sum, row) => sum + (row.state === "pending" ? 0 : Number(row.cost_micro_usd)), 0),
      "spentMicroUsd",
    );
    const reservedMicroUsd = nonnegativeInteger(
      rows.reduce((sum, row) => sum + (row.state === "pending" ? Number(row.max_cost_micro_usd) : 0), 0),
      "reservedMicroUsd",
    );
    const committed = nonnegativeInteger(spentMicroUsd + reservedMicroUsd, "committedMicroUsd");
    return { scope, limitMicroUsd, spentMicroUsd, reservedMicroUsd, remainingMicroUsd: limitMicroUsd - committed };
  }

  private finish(id: string, state: "settled" | "uncertain", usage: Settlement): BudgetReservation {
    return this.db.write(() => {
      const existing = this.require(id);
      const fingerprint = JSON.stringify({ state, ...usage });
      if (existing.state !== "pending") {
        const row = this.db.sql.prepare("SELECT settlement FROM lab_budget_reservations WHERE id=?").get(id);
        if (row?.settlement !== fingerprint)
          throw new Error("Conflicting settlement; recorded cost cannot be refunded");
        return existing;
      }
      this.db.sql
        .prepare(
          `UPDATE lab_budget_reservations SET state=?,settled_at=?,cost_micro_usd=?,
        input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,failed=?,retry=?,breached=?,
        settlement=? WHERE id=?`,
        )
        .run(
          state,
          this.now(),
          usage.costMicroUsd,
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          Number(usage.failed),
          Number(usage.retry),
          Number(usage.costMicroUsd > existing.maxCostMicroUsd),
          fingerprint,
          id,
        );
      return this.require(id);
    });
  }

  private frozen(): boolean {
    return !!this.db.sql.prepare("SELECT 1 FROM lab_budget_reservations WHERE breached=1 LIMIT 1").get();
  }

  private find(id: string): BudgetReservation | undefined {
    const row = this.db.sql.prepare("SELECT * FROM lab_budget_reservations WHERE id=?").get(id);
    return row ? readReservation(row) : undefined;
  }

  private require(id: string): BudgetReservation {
    const row = this.find(id);
    if (!row) throw new Error(`Unknown reservation: ${id}`);
    return row;
  }
}

interface Settlement {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costMicroUsd: number;
  failed: boolean;
  retry: boolean;
}

function flag(value: boolean | undefined): boolean {
  if (value !== undefined && typeof value !== "boolean") throw new Error("Usage flags must be boolean");
  return value ?? false;
}

function readReservation(row: Record<string, unknown>): BudgetReservation {
  const state = row.state;
  if (state !== "pending" && state !== "settled" && state !== "uncertain") throw new Error("Invalid reservation state");
  const nullable = (key: string) => (row[key] === null ? null : Number(row[key]));
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    taskId: String(row.task_id),
    provider: String(row.provider),
    model: String(row.model),
    maxCostMicroUsd: Number(row.max_cost_micro_usd),
    state,
    createdAt: Number(row.created_at),
    settledAt: nullable("settled_at"),
    costMicroUsd: nullable("cost_micro_usd"),
    inputTokens: nullable("input_tokens"),
    outputTokens: nullable("output_tokens"),
    cacheReadTokens: nullable("cache_read_tokens"),
    cacheWriteTokens: nullable("cache_write_tokens"),
    failed: Boolean(row.failed),
    retry: Boolean(row.retry),
    breached: Boolean(row.breached),
  };
}

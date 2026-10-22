import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BudgetLedger, type BudgetRequest } from "../../src/lab/budget.js";
import { BoundedGateway } from "../../src/lab/budget-gateway.js";
import { createTempDb } from "../helpers/temp-db.js";

const request = (id: string, maxCostMicroUsd = 40): BudgetRequest => ({
  id,
  agentId: "worker",
  taskId: "task",
  provider: "fixture",
  model: "bounded",
  maxCostMicroUsd,
});
const usage = (costMicroUsd = 30) => ({ inputTokens: 12, outputTokens: 4, cacheReadTokens: 3, costMicroUsd });

function setup(ledger: BudgetLedger, limit = 100): void {
  for (const scope of ["swarm", "agent:worker", "task:task"]) ledger.setLimit(scope, limit);
  ledger.setAgentModel("worker", {
    provider: "fixture",
    model: "bounded",
    maxRequestCostMicroUsd: limit,
    providerEnforcesBound: true,
  });
}

test("reservations require all three limits and an explicitly bounded known model", (t) => {
  const fixture = createTempDb();
  t.after(fixture.cleanup);
  const ledger = new BudgetLedger(fixture.db);
  assert.throws(() => ledger.reserve(request("unknown")), /Unknown model/);
  ledger.setAgentModel("worker", {
    provider: "fixture",
    model: "bounded",
    maxRequestCostMicroUsd: 100,
    providerEnforcesBound: true,
  });
  for (const scope of ["swarm", "agent:worker", "task:task"]) {
    assert.throws(() => ledger.reserve(request("missing")), /Missing budget/);
    ledger.setLimit(scope, 100);
  }
  assert.throws(() => ledger.reserve({ ...request("wrong"), model: "unverified" }), /Unknown model/);
  assert.throws(() => ledger.reserve(request("invalid", NaN)), /safe integer/);
  assert.throws(() => ledger.reserve(request("over-ceiling", 101)), /unverified request bound/);
  ledger.reserve(request("ok"));
  assert.throws(() => ledger.setLimit("swarm", 39), /spent and in-flight/);
  for (const scope of ledger.status().scopes) {
    assert.equal(scope.reservedMicroUsd, 40);
    assert.equal(scope.remainingMicroUsd, 60);
  }
});

test("settlement records costs and tokens once, rejects reused IDs and conflicting refunds", (t) => {
  const fixture = createTempDb();
  t.after(fixture.cleanup);
  let now = 100;
  const ledger = new BudgetLedger(fixture.db, () => now);
  setup(ledger);
  ledger.reserve(request("call"));
  assert.throws(() => ledger.reserve(request("call")), /already used/);
  now = 200;
  const first = ledger.settle("call", { ...usage(), failed: true, retry: true });
  now = 300;
  assert.deepEqual(ledger.settle("call", { ...usage(), failed: true, retry: true }), first);
  assert.throws(() => ledger.settle("call", usage(1)), /Conflicting settlement/);
  assert.throws(() => ledger.markUncertain("call"), /Conflicting settlement/);
  assert.equal(first.createdAt, 100);
  assert.equal(first.settledAt, 200);
  const status = ledger.status("worker", "task");
  assert.equal(status.inputTokens, 12);
  assert.equal(status.outputTokens, 4);
  assert.equal(status.cacheReadTokens, 3);
  assert.equal(status.failures, 1);
  assert.equal(status.retries, 1);
  assert.ok(status.scopes.every((scope) => scope.spentMicroUsd === 30 && scope.reservedMicroUsd === 0));
});

test("each budget scope independently blocks a callback before it runs", async (t) => {
  for (const blocked of ["swarm", "agent:worker", "task:task"]) {
    const fixture = createTempDb();
    t.after(fixture.cleanup);
    const ledger = new BudgetLedger(fixture.db);
    setup(ledger);
    ledger.setLimit(blocked, 1);
    let called = false;
    await assert.rejects(
      new BoundedGateway(ledger).execute(request("blocked"), async () => {
        called = true;
        return { value: true, usage: usage() };
      }),
      /Budget exhausted/,
    );
    assert.equal(called, false);
    assert.equal(ledger.status().requests, 0);
  }
});

test("concurrent in-flight requests cannot overshoot valid bounds", async (t) => {
  const fixture = createTempDb();
  t.after(fixture.cleanup);
  const ledger = new BudgetLedger(fixture.db);
  setup(ledger);
  const gateway = new BoundedGateway(ledger);
  let calls = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, index) =>
      gateway.execute(request(`call-${index}`, 30), async (reservation) => {
        assert.ok(Object.isFrozen(reservation));
        calls++;
        return { value: index, usage: usage(25) };
      }),
    ),
  );
  assert.equal(calls, 3);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 3);
  assert.ok(ledger.status().scopes.every((scope) => scope.spentMicroUsd === 75 && scope.reservedMicroUsd === 0));
});

test("ambiguous failure and invalid usage consume the entire bound without a refund", async (t) => {
  const fixture = createTempDb();
  t.after(fixture.cleanup);
  const ledger = new BudgetLedger(fixture.db);
  setup(ledger);
  const gateway = new BoundedGateway(ledger);
  await assert.rejects(
    gateway.execute(request("failed"), async () => {
      throw new Error("connection lost");
    }),
    /connection lost/,
  );
  await assert.rejects(
    gateway.execute(
      request("unknown"),
      async () => ({
        value: "unknown",
        usage: { ...usage(), inputTokens: NaN },
      }),
      { retry: true },
    ),
    /safe integer/,
  );
  const status = ledger.status();
  assert.equal(status.failures, 2);
  assert.equal(status.retries, 1);
  assert.equal(status.unknownUsage, 2);
  assert.ok(status.scopes.every((scope) => scope.spentMicroUsd === 80));
  assert.throws(() => ledger.settle("failed", usage(0)), /Conflicting settlement/);
  assert.deepEqual(
    ledger.markUncertain("unknown", { failed: true, retry: true }),
    status.reservations.find((row) => row.id === "unknown"),
  );
  let called = false;
  await assert.rejects(
    gateway.execute(request("over-limit"), async () => {
      called = true;
      return { value: true, usage: usage() };
    }),
    /Budget exhausted/,
  );
  assert.equal(called, false);
});

test("reported provider overspend is preserved and freezes all future requests", async (t) => {
  const fixture = createTempDb();
  t.after(fixture.cleanup);
  const ledger = new BudgetLedger(fixture.db);
  setup(ledger);
  await assert.rejects(
    new BoundedGateway(ledger).execute(request("breach"), async () => ({
      value: true,
      usage: usage(120),
    })),
    /Provider exceeded/,
  );
  const status = ledger.status();
  assert.equal(status.frozen, true);
  assert.equal(status.reservations[0].costMicroUsd, 120);
  assert.ok(status.scopes.every((scope) => scope.remainingMicroUsd === -20));
  ledger.setLimit("swarm", 1_000);
  assert.throws(() => ledger.reserve(request("after", 1)), /Budget frozen/);
});

test("invalid token metadata cannot hide a known provider cost breach", async (t) => {
  const fixture = createTempDb();
  t.after(fixture.cleanup);
  const ledger = new BudgetLedger(fixture.db);
  setup(ledger);
  await assert.rejects(
    new BoundedGateway(ledger).execute(request("invalid-breach"), async () => ({
      value: true,
      usage: { ...usage(120), inputTokens: NaN },
    })),
    /safe integer/,
  );
  const status = ledger.status();
  assert.equal(status.frozen, true);
  assert.equal(status.unknownUsage, 1);
  assert.equal(status.reservations[0].costMicroUsd, 120);
  assert.throws(() => ledger.reserve(request("after", 1)), /Budget frozen/);
});

async function launch(dbPath: string, id: string, amount: number, hold = false) {
  const script = fileURLToPath(new URL("./budget-child.ts", import.meta.url));
  const child = fork(script, [dbPath, id, String(amount), ...(hold ? ["hold"] : [])], {
    execArgv: ["--import", "tsx/esm"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [ready] = await once(child, "message");
  assert.deepEqual(ready, { ready: true }, stderr);
  return {
    child,
    exited,
    start() {
      const result = once(child, "message");
      child.send({ start: true });
      return result.then(([message]) => message);
    },
  };
}

test("independent processes atomically reserve a shared allowance", { timeout: 30_000 }, async (t) => {
  const fixture = createTempDb();
  t.after(fixture.cleanup);
  const ledger = new BudgetLedger(fixture.db);
  setup(ledger);
  const children = await Promise.all(
    Array.from({ length: 8 }, (_, index) => launch(fixture.db.path, `process-${index}`, 60)),
  );
  t.after(() => children.forEach(({ child }) => child.kill("SIGKILL")));
  const results = await Promise.all(children.map((child) => child.start()));
  await Promise.all(children.map((child) => child.exited));
  assert.equal(results.filter((result) => result.reserved === true).length, 1);
  assert.equal(ledger.status().requests, 1);
  assert.ok(ledger.status().scopes.every((scope) => scope.reservedMicroUsd === 60));
});

test("process death preserves an in-flight reservation indefinitely", { timeout: 15_000 }, async (t) => {
  const fixture = createTempDb();
  t.after(fixture.cleanup);
  const ledger = new BudgetLedger(fixture.db);
  setup(ledger);
  const child = await launch(fixture.db.path, "crashed", 80, true);
  t.after(() => child.child.kill("SIGKILL"));
  assert.deepEqual(await child.start(), { reserved: true });
  child.child.kill("SIGKILL");
  await child.exited;
  const recovered = new BudgetLedger(fixture.db, () => Date.now() + 365 * 24 * 60 * 60 * 1_000);
  assert.throws(() => recovered.reserve(request("after-crash", 30)), /Budget exhausted/);
  assert.equal(recovered.status().reservations[0].state, "pending");
  assert.ok(recovered.status().scopes.every((scope) => scope.reservedMicroUsd === 80));
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { runBenchmark } from "../../src/lab/benchmark.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function destination(): string {
  const root = mkdtempSync(join(tmpdir(), "swarm-benchmark-"));
  roots.push(root);
  return join(root, "new-run");
}

it("three real MCP workers claim, write, integrate and verify a bounded project", { timeout: 60_000 }, async () => {
  const directory = destination();
  const report = await runBenchmark(directory);
  assert.equal(report.autonomousAiBenchmark, false);
  assert.equal(report.tokens, null);
  assert.equal(report.apiSpendUsd, 0);
  assert.equal(report.paidApiRequests, 0);
  assert.equal(report.complete, true);
  assert.equal(report.verification.passed, true);
  assert.equal(report.workspaces.length, 3);
  assert.equal(report.commits.length, 3);
  assert.equal(report.snapshot.coordination.agents.length, 3);
  assert.ok(report.snapshot.coordination.agents.every((agent) => agent.state === "stopped"));
  assert.equal(new Set(report.snapshot.coordination.tasks.map((task) => task.owner)).size, 3);
  assert.equal(report.metrics.completedTasks, 3);
  assert.ok(report.metrics.toolCalls > 20);
  assert.ok(report.metrics.messages >= 9);
  assert.equal(report.snapshot.coordination.claims.length, 0);
  assert.equal(report.snapshot.budget.reservations.length, 0);
  assert.equal(JSON.parse(readFileSync(join(directory, "report.json"), "utf8")).complete, true);
  await assert.rejects(() => runBenchmark(directory), /EEXIST/);
});

it("one-worker baseline uses the same three tasks without claiming AI results", { timeout: 60_000 }, async () => {
  const report = await runBenchmark(destination(), 1);
  assert.equal(report.workspaces.length, 1);
  assert.equal(report.metrics.completedTasks, 3);
  assert.equal(report.snapshot.coordination.agents.length, 1);
  assert.equal(report.apiSpendUsd, 0);
  assert.equal(report.tokens, null);
  assert.equal(report.verification.passed, true);
});

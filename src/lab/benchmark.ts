import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BENCHMARK_FIXTURES } from "./benchmark-worker.js";
import { openLab } from "./service.js";
import { WorkspaceManager } from "./workspace.js";

const RUN_TIMEOUT_MS = 45_000;
const workerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), agentId: z.string() }),
  z.object({ type: z.literal("done"), agentId: z.string(), completed: z.number(), claimConflicts: z.number() }),
  z.object({ type: z.literal("failure"), error: z.string() }),
]);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const verification = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dot } from './vector.mjs';
import { hitSphere } from './sphere.mjs';
import { lambert } from './shade.mjs';
test('vector handles signs and zero', () => { assert.equal(dot([1,2,3], [4,-5,6]), 12); assert.equal(dot([0,0,0], [3,4,5]), 0); });
test('sphere hits nearest root and rejects misses', () => { assert.equal(hitSphere([0,0,-3], [0,0,1]), 2); assert.equal(hitSphere([0,0,-3], [0,1,0]), null); assert.equal(hitSphere([0,0,0], [0,0,1]), 1); });
test('Lambert clips back-facing light', () => { assert.equal(lambert([0,0,1], [0,0,1]), 1); assert.equal(lambert([0,0,1], [0,0,-1]), 0); });
`;

function stopGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function runWorkers(directory: string, agents: number): Promise<number> {
  const children: ChildProcess[] = [];
  const done = new Set<string>();
  let ready = 0;
  let conflicts = 0;
  let fail: (error: Error) => void = () => {};
  const failure = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const timer = setTimeout(() => fail(new Error(`Benchmark exceeded ${RUN_TIMEOUT_MS}ms`)), RUN_TIMEOUT_MS);
  try {
    const exits = Array.from({ length: agents }, (_, index) => {
      const agentId = `worker-${index + 1}`;
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx/esm",
          fileURLToPath(new URL("./benchmark-worker.ts", import.meta.url)),
          JSON.stringify({
            dbPath: join(directory, "lab.db"),
            repoPath: join(directory, "repo"),
            workspaceRoot: join(directory, "workspaces"),
            agentId,
            maxTasks: agents === 1 ? 3 : 1,
          }),
        ],
        {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          detached: process.platform !== "win32",
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      children.push(child);
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      child.on("message", (raw: unknown) => {
        const parsed = workerMessage.safeParse(raw);
        if (!parsed.success) {
          fail(new Error("Invalid worker protocol message"));
          return;
        }
        const message = parsed.data;
        if (message.type === "failure") fail(new Error(message.error));
        else if (message.agentId !== agentId) fail(new Error("Worker identity mismatch"));
        else if (message.type === "ready") {
          ready += 1;
          if (ready === agents) for (const peer of children) peer.send("start");
        } else {
          done.add(agentId);
          conflicts += message.claimConflicts;
        }
      });
      return new Promise<void>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code, signal) => {
          if (code !== 0 || !done.has(agentId))
            rejectExit(new Error(`${agentId} exited (${code ?? signal}): ${stderr}`));
          else resolveExit();
        });
      });
    });
    await Promise.race([Promise.all(exits), failure]);
    return conflicts;
  } finally {
    clearTimeout(timer);
    for (const child of children) stopGroup(child);
  }
}

/** A zero-model MCP integration smoke test, never a measure of autonomous coding quality. */
export async function runBenchmark(directory: string, agents = 3) {
  if (agents !== 1 && agents !== 3) throw new Error("Benchmark supports one or three workers");
  const destination = resolve(directory);
  mkdirSync(destination); // Existing directories are always preserved and refused.
  const started = Date.now();
  const repoPath = join(destination, "repo");
  const workspaceRoot = join(destination, "workspaces");
  mkdirSync(repoPath);
  git(repoPath, "init", "-b", "main");
  git(repoPath, "config", "user.name", "Atom Swarm Lab Benchmark");
  git(repoPath, "config", "user.email", "benchmark@example.invalid");
  writeFileSync(join(repoPath, "verification.test.mjs"), verification);
  git(repoPath, "add", "verification.test.mjs");
  git(repoPath, "commit", "-m", "Initialize deterministic protocol benchmark");
  const lab = openLab({ dbPath: join(destination, "lab.db"), agentId: "benchmark-observer" });
  try {
    lab.budget.setLimit("swarm", 0);
    for (const fixture of BENCHMARK_FIXTURES) lab.coordination.createTask(fixture.id, fixture.title);
    const claimConflicts = await runWorkers(destination, agents);
    const manager = new WorkspaceManager(repoPath, workspaceRoot);
    const workspaces = manager.list();
    const commits: { agentId: string; sourceCommit: string; integratedCommit: string }[] = [];
    for (const workspace of workspaces) {
      const paths = BENCHMARK_FIXTURES.filter(
        (fixture) => lab.coordination.listTasks().find((task) => task.id === fixture.id)?.owner === workspace.agentId,
      ).map((fixture) => fixture.path);
      git(workspace.path, "add", "--", ...paths);
      git(workspace.path, "commit", "-m", `Complete scripted fixtures for ${workspace.agentId}`);
      const sourceCommit = git(workspace.path, "rev-parse", "HEAD");
      commits.push({
        agentId: workspace.agentId,
        sourceCommit,
        integratedCommit: manager.integrate(workspace, sourceCommit),
      });
    }
    const testOutput = execFileSync(process.execPath, ["--test", "verification.test.mjs"], {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const snapshot = lab.snapshot();
    if (!snapshot.coordination.complete) throw new Error("Benchmark ended without collective completion");
    const report = {
      kind: "deterministic-mcp-protocol-smoke",
      autonomousAiBenchmark: false,
      description:
        "Scripted workers copied fixed fixtures. This verifies protocol, coordination and source integration; it does not measure model quality or AI cost-effectiveness.",
      directory: destination,
      agents,
      startedAt: new Date(started).toISOString(),
      wallClockMs: Date.now() - started,
      tokens: null,
      apiSpendUsd: 0,
      paidApiRequests: 0,
      duplicateInvestigations: null,
      taskClaimConflicts: claimConflicts,
      metrics: snapshot.coordination.metrics,
      workspaces,
      commits,
      verification: { passed: true, output: testOutput },
      complete: snapshot.coordination.complete,
      snapshot,
    };
    writeFileSync(join(destination, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    writeFileSync(
      join(destination, "failure.json"),
      JSON.stringify(
        {
          kind: "deterministic-mcp-protocol-smoke",
          completed: false,
          agents,
          wallClockMs: Date.now() - started,
          apiSpendUsd: 0,
          tokens: null,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    lab.close();
  }
}

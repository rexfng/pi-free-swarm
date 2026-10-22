import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { Coordination } from "../../src/lab/coordination.js";
import { openSwarmDb } from "../../src/store/db.js";
import { createTempDb } from "../helpers/temp-db.js";

const worker = fileURLToPath(new URL("./coordination-worker.ts", import.meta.url));

function waitFor(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Worker did not report ${type}`)), 10_000);
    const onMessage = (message: unknown) => {
      if (typeof message === "object" && message !== null && "type" in message && message.type === type) {
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("message", onMessage);
        resolve(Object.fromEntries(Object.entries(message)));
      }
    };
    const onExit = (code: number | null) => finish(new Error(`Worker exited before ${type}: ${code}`));
    const finish = (error: Error) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("message", onMessage);
      reject(error);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function launch(dbPath: string, agentId: string, mode = "race"): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx/esm", worker, dbPath, agentId, mode], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

it("two synchronized processes cannot both own the same file or task", { timeout: 20_000 }, async () => {
  const temp = createTempDb();
  const lab = new Coordination(temp.db, { now: () => 1_000, agentTtlMs: 100 });
  lab.createTask("core", "Build core");
  const children = [launch(temp.db.path, "alice"), launch(temp.db.path, "bob")];
  try {
    await Promise.all(children.map((child) => waitFor(child, "ready")));
    const waiting = children.map((child) => waitFor(child, "result"));
    for (const child of children) child.send("go");
    const results = await Promise.all(waiting);
    assert.equal(results.filter((result) => typeof result.fileToken === "string").length, 1);
    assert.equal(results.filter((result) => typeof result.taskToken === "string").length, 1);
    const status = lab.status();
    assert.equal(status.claims.length, 1);
    assert.equal(status.tasks.filter((task) => task.status === "claimed").length, 1);
    assert.equal(status.metrics.fileConflicts, 1);
    assert.equal(status.messages.length, 2);
    assert.equal(status.agents.filter((agent) => agent.state === "active").length, 2);
  } finally {
    await Promise.all(children.map(kill));
    temp.cleanup();
  }
});

it(
  "SIGKILL rolls back an in-progress transaction and reopening recovers leased work",
  { timeout: 20_000 },
  async () => {
    const temp = createTempDb();
    let now = 1_000;
    const lab = new Coordination(temp.db, { now: () => now, agentTtlMs: 100 });
    lab.createTask("core", "Build core");
    const child = launch(temp.db.path, "alice", "crash");
    try {
      await waitFor(child, "ready");
      const waiting = waitFor(child, "uncommitted");
      child.send("go");
      const result = await waiting;
      assert.equal(typeof result.fileToken, "string");
      assert.equal(typeof result.taskToken, "string");
      await kill(child);
      assert.equal(lab.status().messages.length, 1);
      assert.equal(lab.status().claims.length, 1);
      now = 1_100;
      const reopenedDb = openSwarmDb(temp.db.path, { create: false });
      try {
        const reopened = new Coordination(reopenedDb, { now: () => now, agentTtlMs: 100 });
        const status = reopened.status();
        assert.equal(status.agents[0].state, "expired");
        assert.equal(status.claims.length, 0);
        assert.equal(status.tasks[0].status, "open");
        assert.equal(status.tasks[0].executionMs, 100);
        assert.deepEqual(
          status.fileHistory.map((event) => event.operation),
          ["acquired", "expired"],
        );
        reopened.registerAgent("replacement");
        assert.notEqual(reopened.claimFile("replacement", "src/core.ts").token, result.fileToken);
        assert.notEqual(reopened.claimTask("replacement", "core").token, result.taskToken);
        assert.equal(reopened.status().metrics.taskRetries, 1);
      } finally {
        reopenedDb.close();
      }
    } finally {
      await kill(child);
      temp.cleanup();
    }
  },
);

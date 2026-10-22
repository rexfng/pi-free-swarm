import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Coordination } from "../../src/lab/coordination.js";
import { createTempDb, type TempDb } from "../helpers/temp-db.js";

let temp: TempDb;
let lab: Coordination;
let now: number;
beforeEach(() => {
  temp = createTempDb();
  now = 1_000;
  lab = new Coordination(temp.db, { now: () => now, agentTtlMs: 100 });
});
afterEach(() => temp.cleanup());

describe("durable coordination lifecycle", () => {
  it("rejects duplicate live identities and invalid heartbeats", () => {
    assert.equal(lab.status().complete, false);
    lab.registerAgent("alice");
    assert.throws(() => lab.registerAgent("alice"), /already active/);
    now = 1_050;
    assert.equal(lab.heartbeat("alice").expiresAt, 1_150);
    now = 1_150;
    assert.throws(() => lab.heartbeat("alice"), /not active/);
    assert.equal(temp.db.sql.prepare("SELECT state FROM lab_agents WHERE id = 'alice'").get()?.state, "expired");
    assert.equal(lab.status().agents[0].state, "expired");
    assert.equal(lab.registerAgent("alice").state, "active");
    lab.stopAgent("alice");
    assert.equal(lab.status().agents[0].state, "stopped");
    assert.throws(() => lab.postMessage("alice", "stale"), /not active/);
  });

  it("blocks dependent tasks, fences ownership, and requires evidence", () => {
    lab.registerAgent("alice");
    lab.registerAgent("bob");
    lab.createTask("core", "Build core");
    lab.createTask("ui", "Build UI", ["core"]);
    assert.throws(() => lab.createTask("cycle", "Cannot self depend", ["cycle"]), /itself/);
    assert.throws(() => lab.createTask("missing", "Missing dependency", ["absent"]), /not found/);
    assert.throws(() => lab.claimTask("bob", "ui"), /dependencies/);
    const claim = lab.claimTask("alice", "core", 30);
    assert.throws(() => lab.claimTask("bob", "core"), /not open/);
    assert.throws(() => lab.completeTask("bob", "core", claim.token, "tests passed"), /lease/);
    assert.throws(() => lab.completeTask("alice", "core", claim.token, ""), /evidence/);
    now += 10;
    lab.completeTask("alice", "core", claim.token, "unit tests passed");
    const ui = lab.claimTask("bob", "ui");
    now += 10;
    lab.completeTask("bob", "ui", ui.token, "browser verified");
    const status = lab.status();
    assert.equal(status.complete, true);
    assert.equal(status.metrics.averageTaskDurationMs, 15);
    assert.equal(status.tasks.find((task) => task.id === "ui")?.executionMs, 10);
    assert.throws(() => lab.completeTask("bob", "ui", ui.token, "again"), /lease/);
  });

  it("expires task leases independently, renews, releases, and records retries", () => {
    lab.registerAgent("alice");
    lab.registerAgent("bob");
    lab.createTask("core", "Build core");
    const first = lab.claimTask("alice", "core", 10);
    now += 5;
    assert.equal(lab.renewTask("alice", "core", first.token, 15).expiresAt, 1_020);
    now = 1_020;
    const second = lab.claimTask("bob", "core", 20);
    assert.notEqual(second.token, first.token);
    assert.throws(() => lab.renewTask("alice", "core", first.token), /lease/);
    now += 5;
    lab.releaseTask("bob", "core", second.token);
    const task = lab.listTasks()[0];
    assert.equal(task.status, "open");
    assert.equal(task.executionMs, 25);
    assert.equal(lab.status().metrics.taskRetries, 1);
  });

  it("preserves board messages, filters DMs, and supports cursors", () => {
    for (const id of ["alice", "bob", "charlie"]) lab.registerAgent(id);
    const board = lab.postMessage("alice", "Working on the core");
    const direct = lab.postMessage("alice", "Please check the UI", "bob");
    assert.deepEqual(
      lab.readMessages("bob").map((message) => message.id),
      [board.id, direct.id],
    );
    assert.deepEqual(
      lab.readMessages("charlie").map((message) => message.id),
      [board.id],
    );
    assert.deepEqual(
      lab.readMessages("alice", board.id).map((message) => message.id),
      [direct.id],
    );
    assert.throws(() => lab.readMessages("bob", -1), /cursor/);
    assert.throws(() => lab.postMessage("alice", "unknown", "missing"), /recipient/);
    const reopened = new Coordination(temp.db, { now: () => now });
    assert.equal(reopened.status().messages.length, 2);
  });
});

describe("exclusive file leases", () => {
  it("normalizes platform aliases and persists conflict history", () => {
    lab.registerAgent("alice");
    lab.registerAgent("bob");
    const lease = lab.claimFile("alice", "./SRC//Caf\u00e9.ts");
    assert.throws(() => lab.claimFile("bob", "src\\cafe\u0301.ts"), /already claimed/);
    assert.equal(lab.assertFileLease("alice", "src/caf\u00e9.ts", lease.token).path, "src/caf\u00e9.ts");
    assert.equal(lab.status().metrics.fileConflicts, 1);
    for (const path of [
      "../secret",
      "a/../b",
      ".git/config",
      ".GIT/hooks",
      ".g\u200dit/config",
      "git~1/config",
      "a\nb",
      "/tmp/x",
      "C:\\foo",
      "file.",
      "file ",
      "nul.txt",
      "a:b",
      ".",
    ]) {
      assert.throws(() => lab.claimFile("bob", path), /path|file/);
    }
    assert.ok(lab.claimFile("bob", ".gitignore").token);
  });

  it("renews only live owners and fences stale tokens on expiry and reuse", () => {
    lab.registerAgent("alice");
    lab.registerAgent("bob");
    const first = lab.claimFile("alice", "core.ts", 10);
    now += 5;
    assert.equal(lab.renewLease("alice", "core.ts", first.token, 15).expiresAt, 1_020);
    assert.throws(() => lab.releaseFile("bob", "core.ts", first.token), /lease/);
    now = 1_020;
    const second = lab.claimFile("bob", "core.ts");
    assert.notEqual(first.token, second.token);
    assert.throws(() => lab.renewLease("alice", "core.ts", first.token), /lease/);
    lab.releaseFile("bob", "core.ts", second.token);
    const third = lab.claimFile("alice", "core.ts");
    assert.notEqual(third.token, first.token);
    assert.throws(() => lab.releaseFile("alice", "core.ts", first.token), /lease/);
  });

  it("stopping releases resources and claims prevent premature completion", () => {
    lab.registerAgent("alice");
    lab.createTask("core", "Build core");
    const task = lab.claimTask("alice", "core");
    lab.claimFile("alice", "core.ts");
    lab.completeTask("alice", "core", task.token, "tests passed");
    assert.equal(lab.status().complete, false);
    lab.stopAgent("alice");
    assert.equal(lab.status().complete, true);
    assert.equal(lab.status().claims.length, 0);
  });

  it("caps leases at agent expiry and reopens work after crashed agents expire", () => {
    lab.registerAgent("alice");
    lab.createTask("core", "Build core");
    const file = lab.claimFile("alice", "core.ts", 1_000);
    const task = lab.claimTask("alice", "core", 1_000);
    assert.equal(file.expiresAt, 1_100);
    now = 1_200;
    assert.deepEqual(lab.recover(), { agents: 1, files: 1, tasks: 1 });
    const status = lab.status();
    assert.equal(status.tasks[0].status, "open");
    assert.equal(status.tasks[0].executionMs, 100);
    assert.throws(() => lab.renewLease("alice", "core.ts", file.token), /not active/);
    assert.throws(() => lab.renewTask("alice", "core", task.token), /not active/);
    lab.registerAgent("alice");
    assert.throws(() => lab.renewLease("alice", "core.ts", file.token), /lease/);
    assert.notEqual(lab.claimFile("alice", "core.ts").token, file.token);
  });
});

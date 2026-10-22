import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { classifyTool } from "../../src/lab/activity.js";
import { Coordination } from "../../src/lab/coordination.js";
import { createTempDb, type TempDb } from "../helpers/temp-db.js";

let temp: TempDb;
let lab: Coordination;
let now: number;
beforeEach(() => {
  temp = createTempDb();
  now = 1_000;
  lab = new Coordination(temp.db, { now: () => now, agentTtlMs: 100 });
  lab.registerAgent("alice");
});
afterEach(() => temp.cleanup());

describe("activity accounting", () => {
  it("shows live task time and freezes completion throughput after the last task finishes", () => {
    lab.createTask("one", "One task");
    const claim = lab.claimTask("alice", "one", 100);
    now += 10;
    assert.equal(lab.status().tasks[0].executionMs, 10);
    lab.completeTask("alice", "one", claim.token, "Tested");
    const throughput = lab.status().metrics.completedTasksPerMinute;
    lab.stopAgent("alice");
    lab.recordTool("alice", "stop_agent", true, 1);
    now += 500;
    assert.equal(lab.status().metrics.completedTasksPerMinute, throughput);
    assert.equal(lab.status().metrics.toolCalls, 1);
    assert.equal(lab.status().activities.filter((interval) => interval.endedAt === null).length, 0);
  });
  it("classifies observed operations deterministically with uncertainty", () => {
    assert.deepEqual(classifyTool("npm test"), { category: "testing", confidence: 0.95 });
    assert.equal(classifyTool("read_file").category, "research");
    assert.equal(classifyTool("apply_patch").category, "implementation");
    assert.equal(classifyTool("post_message").category, "coordination");
    assert.equal(classifyTool("compact_context").category, "compaction");
    assert.equal(classifyTool("test", false).category, "debugging");
    assert.ok(classifyTool("opaque_tool").confidence < 0.5);
  });

  it("records observed tool intervals and never overlaps concurrent spans", () => {
    now = 1_020;
    lab.recordTool("alice", "apply_patch", true, 10);
    lab.recordTool("alice", "run_tests", true, 15);
    now = 1_030;
    lab.recordTool("alice", "run_tests", false, 5);
    now = 1_040;
    const status = lab.status();
    assert.equal(status.metrics.toolCalls, 3);
    assert.equal(status.metrics.toolFailures, 1);
    assert.equal(
      status.activities.reduce((sum, activity) => sum + activity.durationMs, 0),
      40,
    );
    assert.equal(status.metrics.activeMs, 15);
    assert.equal(status.metrics.byAgent[0].idleMs, 25);
    assert.equal(status.activities.filter((activity) => activity.endedAt === null).length, 1);
    assert.equal(
      status.toolCalls.reduce((sum, tool) => sum + tool.durationMs, 0),
      30,
    );
  });

  it("preserves explicit reports, supports correction, and audits prior labels", () => {
    const id = lab.reportActivity("alice", "understanding");
    lab.recordTool("alice", "report_activity", true, 0);
    now += 10;
    assert.equal(lab.status().metrics.byAgent[0].activityMs.understanding, 10);
    lab.correctActivity("alice", id, "hypothesis");
    lab.recordTool("alice", "correct_activity", true, 0);
    now += 10;
    const activity = lab.status().activities.find((interval) => interval.id === id);
    assert.equal(activity?.category, "hypothesis");
    assert.equal(activity?.source, "correction");
    assert.equal(activity?.durationMs, 20);
    const prior = temp.db.sql.prepare("SELECT * FROM lab_activity_corrections WHERE activity_id = ?").get(id);
    assert.equal(prior?.category, "understanding");
    lab.registerAgent("bob");
    assert.throws(() => lab.correctActivity("bob", id, "research"), /not found/);
    assert.throws(() => lab.reportActivity("alice", "research", "explicit", 2), /Confidence/);
  });

  it("ends crashed agent activity at lease expiry and excludes downtime", () => {
    now += 10;
    lab.reportActivity("alice", "implementation");
    now = 1_500;
    let status = lab.status();
    assert.equal(status.metrics.activeMs, 90);
    assert.equal(status.metrics.byAgent[0].idleMs, 10);
    assert.equal(status.activities.filter((activity) => activity.endedAt === null).length, 0);
    lab.registerAgent("alice");
    now += 5;
    status = lab.status();
    assert.equal(
      status.activities.reduce((sum, activity) => sum + activity.durationMs, 0),
      105,
    );
    assert.equal(status.metrics.byAgent[0].idleMs, 15);
  });

  it("resumes an explicit state after incidental observed tools", () => {
    lab.reportActivity("alice", "implementation");
    now += 20;
    lab.recordTool("alice", "read_messages", true, 5);
    now += 10;
    lab.recordTool("alice", "heartbeat", true, 0);
    now += 10;
    const status = lab.status();
    assert.equal(status.metrics.byAgent[0].activityMs.implementation, 35);
    assert.equal(status.metrics.byAgent[0].activityMs.coordination, 5);
    assert.equal(
      status.activities.reduce((sum, activity) => sum + activity.durationMs, 0),
      40,
    );
    assert.equal(status.activities.find((activity) => activity.endedAt === null)?.category, "implementation");
  });
});

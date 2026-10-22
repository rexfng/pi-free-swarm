import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { AgentProcess } from "../../src/agents/agent-process.js";
import { hasSessionFile } from "../../src/agents/launch.js";
import { SCENARIOS, waitFor } from "../fixtures/fake-pi/harness.js";
import { prompt, superviseFake } from "./supervisor-helpers.js";
import { FakeClock } from "./fake-clock.js";

test("launch → starting → working → idle, with usage, activity, read markers and a session file", async () => {
  const agent = superviseFake(SCENARIOS.settle);
  try {
    const spec = agent.fake.spec();
    assert.equal(hasSessionFile(spec.sessionFile), false);
    const outcome = await agent.supervisor.launch(spec, prompt("Kick off.\n\n[swarm message #5] hi", [5]));
    assert.deepEqual(outcome, { accepted: true });
    await agent.waitStatus("idle");
    assert.deepEqual(agent.recorded.statuses, ["starting", "working", "idle"]);
    assert.deepEqual(agent.recorded.reads, [[5]]);
    assert.deepEqual(agent.recorded.usage, [
      { kind: "message", input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01, model: "fake-model" },
    ]);
    assert.deepEqual(agent.recorded.activity, [{ kind: "thinking" }, { kind: "writing" }, null]);

    const types = agent.fake.log().flatMap((record) => (typeof record.type === "string" ? [record.type] : []));
    assert.deepEqual(types, ["set_steering_mode", "prompt"]);
    assert.deepEqual(agent.commands("prompt")[0], {
      type: "prompt",
      message: "Kick off.\n\n[swarm message #5] hi",
      streamingBehavior: "steer",
      id: "swarm-2",
    });
    const argv = agent.fake.log()[0].argv;
    assert.ok(Array.isArray(argv));
    assert.deepEqual(argv.slice(0, 6), [
      "--mode",
      "rpc",
      "--session",
      spec.sessionFile,
      "--append-system-prompt",
      spec.systemPromptFile,
    ]);
    assert.ok(!argv.includes("-ne") && !argv.includes("--continue"));

    assert.ok(hasSessionFile(spec.sessionFile));
    const entries = fs.readFileSync(spec.sessionFile, "utf8").trim().split("\n");
    assert.equal(entries.length, 3, "header, user, assistant");
  } finally {
    await agent.cleanup();
  }
});

test("batched prompt responses and complete turns preserve idle transitions and leave no idle timers", async () => {
  const clock = new FakeClock();
  const agent = superviseFake({ ...SCENARIOS.settle, batchRunOutput: true }, { clock });
  try {
    assert.deepEqual(await agent.supervisor.launch(agent.fake.spec(), prompt("go")), { accepted: true });
    assert.equal(agent.supervisor.status, "idle");
    assert.equal(clock.pending, 0);
    assert.deepEqual(await agent.supervisor.deliver(prompt("[swarm] Reminder: keep working.")), { accepted: true });
    assert.equal(agent.supervisor.status, "idle");
    assert.equal(clock.pending, 0);
    assert.deepEqual(agent.recorded.statuses, ["starting", "working", "idle", "working", "idle"]);
  } finally {
    await agent.cleanup();
  }
});

test("an idle agent is woken by a delivered prompt and settles again", async () => {
  const agent = superviseFake(SCENARIOS.settle);
  try {
    await agent.supervisor.launch(agent.fake.spec(), prompt("go"));
    await agent.waitStatus("idle");
    const outcome = await agent.supervisor.deliver(prompt("[swarm message #7] x\n\n[swarm message #8] y", [7, 8]));
    assert.deepEqual(outcome, { accepted: true });
    await agent.waitStatus("idle", 2);
    assert.deepEqual(agent.recorded.statuses, ["starting", "working", "idle", "working", "idle"]);
    assert.deepEqual(agent.recorded.reads, [[7, 8]], "several markers in one prompt are all read");
    assert.equal(agent.recorded.usage.length, 2);
  } finally {
    await agent.cleanup();
  }
});

test("an accepted prompt cannot be recovered again before its run events arrive", async (t) => {
  const spawn = AgentProcess.spawn;
  let holdEvents = false;
  const held: (() => void)[] = [];
  const delayedSpawn: typeof AgentProcess.spawn = (spec, handlers, clock) =>
    spawn(
      spec,
      {
        ...handlers,
        onEvent: (event) => {
          if (holdEvents) held.push(() => handlers.onEvent(event));
          else handlers.onEvent(event);
        },
      },
      clock,
    );
  t.mock.method(AgentProcess, "spawn", delayedSpawn);
  const agent = superviseFake(SCENARIOS.settle);
  try {
    await agent.supervisor.launch(agent.fake.spec(), null);
    assert.equal(agent.supervisor.status, "idle");
    // Reproduce a prompt response arriving in an earlier stdout chunk than agent_start.
    holdEvents = true;
    const notice = prompt("[swarm message #7] checkpoint", [7]);
    assert.deepEqual(await agent.supervisor.deliver(notice), { accepted: true });
    assert.equal(agent.supervisor.status, "working");
    assert.deepEqual(agent.recorded.reads, []);
    assert.deepEqual(await agent.supervisor.recoverUnread(notice), { accepted: false, error: "Maria is working." });
    holdEvents = false;
    for (const deliverEvent of held.splice(0)) deliverEvent();
    await agent.waitStatus("idle", 2);
    assert.equal(agent.commands("prompt").length, 1);
    assert.equal(agent.commands("clear_queue").length, 0);
    assert.deepEqual(agent.recorded.reads, [[7]]);
  } finally {
    await agent.cleanup();
  }
});

test("prompts delivered while working are steered and read as separate user messages", async () => {
  const agent = superviseFake(SCENARIOS.steer);
  try {
    await agent.supervisor.launch(agent.fake.spec(), prompt("go"));
    await agent.waitStatus("working");
    const outcomes = await Promise.all([
      agent.supervisor.deliver(prompt("[swarm message #11] a", [11])),
      agent.supervisor.deliver(prompt("[swarm message #12] b", [12])),
    ]);
    assert.deepEqual(outcomes, [{ accepted: true }, { accepted: true }]);
    assert.deepEqual(agent.recorded.reads, [], "delivered, not yet read");
    await agent.waitStatus("idle");
    assert.deepEqual(agent.recorded.reads, [[11], [12]]);
    assert.deepEqual(agent.recorded.statuses, ["starting", "working", "idle"], "one run");
  } finally {
    await agent.cleanup();
  }
});

test("deliver is refused unless working or idle", async () => {
  const agent = superviseFake(SCENARIOS.settle);
  try {
    assert.deepEqual(await agent.supervisor.deliver(prompt("x")), { accepted: false, error: "Maria is pending." });
    await agent.supervisor.stop();
    assert.deepEqual(await agent.supervisor.deliver(prompt("x")), { accepted: false, error: "Maria is stopped." });
    const late = await agent.supervisor.launch(agent.fake.spec(), prompt("x"));
    assert.equal(late.accepted, false);
  } finally {
    await agent.cleanup();
  }
});

test("settle gap: a stale agent_settled before a successful prompt response keeps the agent working", async () => {
  const agent = superviseFake(SCENARIOS.settleGap);
  try {
    await agent.supervisor.launch(agent.fake.spec(), prompt("go"));
    await waitFor(() => agent.recorded.usage.length === 1, "first run finished");
    // The fake holds agent_settled until this prompt arrives, then sends it before the response.
    assert.deepEqual(await agent.supervisor.deliver(prompt("[swarm message #3] next", [3])), { accepted: true });
    await waitFor(() => agent.recorded.usage.length === 2, "second run finished");
    assert.deepEqual(agent.recorded.statuses, ["starting", "working"]);
    assert.deepEqual(agent.recorded.reads, [[3]]);

    // A rejected prompt applies the deferred settle instead.
    const rejected = await agent.supervisor.deliver(prompt("REJECT me"));
    assert.deepEqual(rejected, { accepted: false, error: "Rejected by fake pi." });
    assert.deepEqual(agent.recorded.statuses, ["starting", "working", "idle"]);
  } finally {
    await agent.cleanup();
  }
});

test("dialog requests are answered cancelled; notify records are ignored", async () => {
  const agent = superviseFake(SCENARIOS.dialog);
  try {
    await agent.supervisor.launch(agent.fake.spec(), prompt("go"));
    await agent.waitStatus("idle");
    const answers = agent.commands("extension_ui_response");
    assert.equal(answers.length, 1);
    assert.equal(answers[0].cancelled, true);
    assert.match(String(answers[0].id), /^dialog-/);
  } finally {
    await agent.cleanup();
  }
});

test("compaction usage is reported with kind compaction", async () => {
  const agent = superviseFake(SCENARIOS.compaction);
  try {
    await agent.supervisor.launch(agent.fake.spec(), prompt("go"));
    await agent.waitStatus("idle");
    assert.deepEqual(
      agent.recorded.usage.map((sample) => [sample.kind, sample.input, sample.model]),
      [
        ["message", 10, "fake-model"],
        ["compaction", 700, null],
      ],
    );
  } finally {
    await agent.cleanup();
  }
});

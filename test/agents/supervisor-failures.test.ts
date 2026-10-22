import assert from "node:assert/strict";
import { test } from "node:test";
import { PI_ARGS_PREFIX_ENV, PI_COMMAND_ENV, STARTUP_RETRY_BASE_BACKOFF_MS } from "../../src/constants.js";
import { SCENARIOS, waitFor } from "../fixtures/fake-pi/harness.js";
import { FakeClock } from "./fake-clock.js";
import { prompt, superviseFake } from "./supervisor-helpers.js";

const FAST = { startupTimeoutMs: 300, idleTimeoutMs: 300, startupRetries: 0 };

function spawnCount(log: Record<string, unknown>[]): number {
  return log.filter((record) => record.fake === "spawn").length;
}

test("an unexpected exit crashes the agent with exit code and stderr", async () => {
  const agent = superviseFake(SCENARIOS.crash);
  try {
    assert.deepEqual(await agent.supervisor.launch(agent.fake.spec(), prompt("go")), { accepted: true });
    await agent.waitStatus("crashed");
    assert.deepEqual(agent.recorded.statuses, ["starting", "working", "crashed"]);
    const [crash] = agent.recorded.crashes;
    assert.equal(crash.reason, "exit");
    assert.equal(crash.fatal, false);
    assert.equal(crash.exitCode, 3);
    assert.equal(crash.message, "Agent process exited with code 3.");
    assert.match(crash.stderrTail, /boom/);
  } finally {
    await agent.cleanup();
  }
});

test("a crashed agent can be launched again on the same session file", async () => {
  const agent = superviseFake({ spawns: [SCENARIOS.crash, SCENARIOS.settle] });
  try {
    await agent.supervisor.launch(agent.fake.spec(), prompt("go"));
    await agent.waitStatus("crashed");
    assert.deepEqual(await agent.supervisor.launch(agent.fake.spec(), prompt("revive")), { accepted: true });
    await agent.waitStatus("idle");
    assert.deepEqual(agent.recorded.statuses, ["starting", "working", "crashed", "starting", "working", "idle"]);
  } finally {
    await agent.cleanup();
  }
});

test("the inactivity watchdog kills a silent agent and reports a crash", async () => {
  const clock = new FakeClock();
  const agent = superviseFake(SCENARIOS.inactivityStall, { clock, watchdog: FAST });
  try {
    await agent.supervisor.launch(agent.fake.spec(), prompt("go"));
    await agent.waitStatus("working");
    await waitFor(() => clock.nextDelay() === FAST.idleTimeoutMs, "first turn");
    clock.advance(FAST.idleTimeoutMs);
    await agent.waitStatus("crashed");
    const [crash] = agent.recorded.crashes;
    assert.equal(crash.reason, "inactivity");
    assert.equal(crash.fatal, false);
    assert.equal(crash.exitCode, 143, "the fake exits on SIGTERM like pi");
  } finally {
    await agent.cleanup();
  }
});

test("a tool running longer than the inactivity timeout is never killed", async () => {
  const clock = new FakeClock();
  const agent = superviseFake(SCENARIOS.longTool(1_000), { clock, watchdog: FAST });
  try {
    await agent.supervisor.launch(agent.fake.spec(), prompt("go"));
    await waitFor(() => agent.recorded.activity.some((activity) => activity?.kind === "tool"), "tool starts");
    clock.advance(FAST.idleTimeoutMs * 3);
    await agent.waitStatus("idle");
    assert.deepEqual(agent.recorded.crashes, []);
    assert.ok(agent.recorded.activity.some((activity) => activity?.kind === "tool"));
  } finally {
    await agent.cleanup();
  }
});

test("an idle agent is never killed, however long it waits", async () => {
  const clock = new FakeClock();
  const agent = superviseFake(SCENARIOS.settle, { clock, watchdog: FAST });
  try {
    await agent.supervisor.launch(agent.fake.spec(), prompt("go"));
    await agent.waitStatus("idle");
    clock.advance(FAST.idleTimeoutMs * 3);
    assert.equal(agent.supervisor.status, "idle");
    assert.deepEqual(await agent.supervisor.deliver(prompt("wake")), { accepted: true });
    await agent.waitStatus("idle", 2);
    assert.deepEqual(agent.recorded.crashes, []);
  } finally {
    await agent.cleanup();
  }
});

test("startup timeouts respawn the same spec and prompt with backoff, staying starting", async () => {
  const clock = new FakeClock();
  const scenario = { spawns: [SCENARIOS.startupStall, SCENARIOS.startupStall, SCENARIOS.settle] };
  const agent = superviseFake(scenario, { clock, watchdog: { ...FAST, startupRetries: 2 } });
  try {
    const launched = agent.supervisor.launch(agent.fake.spec(), prompt("[swarm message #4] go", [4]));
    for (const [spawns, backoffMs] of [
      [1, STARTUP_RETRY_BASE_BACKOFF_MS],
      [2, STARTUP_RETRY_BASE_BACKOFF_MS * 2],
    ]) {
      await waitFor(() => spawnCount(agent.fake.log()) === spawns, `spawn ${spawns}`);
      clock.advance(FAST.startupTimeoutMs);
      await waitFor(() => clock.nextDelay() === backoffMs, "retry scheduled after the stalled child exited");
      clock.advance(backoffMs - 1);
      assert.equal(spawnCount(agent.fake.log()), spawns, "backoff not over yet");
      clock.advance(1);
    }
    assert.deepEqual(await launched, { accepted: true });
    await agent.waitStatus("idle");
    assert.deepEqual(agent.recorded.statuses, ["starting", "working", "idle"]);
    assert.equal(spawnCount(agent.fake.log()), 3);
    assert.deepEqual(agent.recorded.reads, [[4]]);
  } finally {
    await agent.cleanup();
  }
});

test("startup timeouts beyond the retries crash with startup_timeout", async () => {
  const clock = new FakeClock();
  const agent = superviseFake(SCENARIOS.startupStall, { clock, watchdog: { ...FAST, startupRetries: 1 } });
  try {
    const launched = agent.supervisor.launch(agent.fake.spec(), prompt("go"));
    await waitFor(() => spawnCount(agent.fake.log()) === 1, "first spawn");
    clock.advance(FAST.startupTimeoutMs);
    await waitFor(() => clock.nextDelay() === STARTUP_RETRY_BASE_BACKOFF_MS, "retry scheduled");
    clock.advance(STARTUP_RETRY_BASE_BACKOFF_MS);
    await waitFor(() => spawnCount(agent.fake.log()) === 2, "second spawn");
    clock.advance(FAST.startupTimeoutMs);
    assert.equal((await launched).accepted, false);
    assert.deepEqual(agent.recorded.statuses, ["starting", "crashed"]);
    assert.equal(agent.recorded.crashes[0].reason, "startup_timeout");
  } finally {
    await agent.cleanup();
  }
});

test("an extension load failure is fatal and never retried", async () => {
  const agent = superviseFake(SCENARIOS.extensionLoadFailure, { watchdog: { ...FAST, startupRetries: 2 } });
  try {
    const outcome = await agent.supervisor.launch(agent.fake.spec(), prompt("go"));
    assert.equal(outcome.accepted, false);
    const [crash] = agent.recorded.crashes;
    assert.equal(crash.reason, "extension_load_failed");
    assert.equal(crash.fatal, true);
    assert.equal(crash.exitCode, 1);
    assert.match(crash.message, /^Error: Failed to load extension "\/x\/index.ts"/);
    assert.match(crash.stderrTail, /Hint: Start without extensions/);
    assert.equal(spawnCount(agent.fake.log()), 1);
  } finally {
    await agent.cleanup();
  }
});

test("a rejected launch prompt is a fatal crash", async () => {
  const agent = superviseFake(SCENARIOS.settleGap);
  try {
    const outcome = await agent.supervisor.launch(agent.fake.spec(), prompt("REJECT"));
    const message = "The launch prompt was rejected: Rejected by fake pi.";
    assert.deepEqual(outcome, { accepted: false, error: message });
    assert.deepEqual(agent.recorded.statuses, ["starting", "crashed"]);
    assert.equal(agent.recorded.crashes[0].reason, "prompt_rejected");
    assert.equal(agent.recorded.crashes[0].fatal, true);
  } finally {
    await agent.cleanup();
  }
});

test("a missing pi command is a spawn_error crash", async () => {
  const agent = superviseFake(SCENARIOS.settle);
  const command = process.env[PI_COMMAND_ENV];
  const prefix = process.env[PI_ARGS_PREFIX_ENV];
  process.env[PI_COMMAND_ENV] = "/nonexistent/pi-free-swarm-test-pi";
  try {
    const outcome = await agent.supervisor.launch(agent.fake.spec(), prompt("go"));
    assert.equal(outcome.accepted, false);
    assert.equal(agent.recorded.crashes[0].reason, "spawn_error");
    assert.match(agent.recorded.crashes[0].message, /ENOENT/);

    process.env[PI_ARGS_PREFIX_ENV] = "not json";
    const again = await agent.supervisor.launch(agent.fake.spec(), prompt("go"));
    assert.equal(again.accepted, false);
    assert.equal(agent.recorded.crashes[1].reason, "spawn_error");
  } finally {
    process.env[PI_COMMAND_ENV] = command;
    process.env[PI_ARGS_PREFIX_ENV] = prefix;
    await agent.cleanup();
  }
});

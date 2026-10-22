import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { heartbeatRunLock } from "../../src/store/locks.js";
import { createTempDb, seedSwarm } from "../helpers/temp-db.js";

const temp = createTempDb();
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  temp.cleanup();
});
const { db } = temp;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const writer = fileURLToPath(new URL("./fixtures/concurrent-writer.ts", import.meta.url));
const LOCKSTEP = 60;
const BURST = 60;
const PER_WRITER = LOCKSTEP + BURST;
const swarmId = seedSwarm(db, { now: Date.now() }).id;

function runWriter(author: string, peer: string): Promise<{ code: number | null; stderr: string }> {
  const args = [db.path, String(swarmId), author, peer, String(LOCKSTEP), String(BURST)];
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", "tsx/esm", writer, ...args],
    {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stderr })));
}

function count(sql: string): number {
  return Number(db.sql.prepare(sql).get()?.n);
}

describe("two processes writing one swarm.db", () => {
  it("interleave without lost rows or busy errors", { timeout: 120_000 }, async () => {
    const results = Promise.all([runWriter("Maria", "John"), runWriter("John", "Maria")]);
    // This process writes too, like a runner heartbeating while its agents post.
    const heartbeat = setInterval(() => heartbeatRunLock(db, swarmId, process.pid, Date.now()), 5);
    const [maria, john] = await results.finally(() => clearInterval(heartbeat));
    assert.deepEqual([maria.code, maria.stderr], [0, ""]);
    assert.deepEqual([john.code, john.stderr], [0, ""]);

    const posts = PER_WRITER; // half of each writer's writes, two writers
    const messages = PER_WRITER;
    assert.equal(count("SELECT COUNT(*) AS n FROM posts"), posts);
    assert.equal(count("SELECT COUNT(*) AS n FROM messages"), messages);
    assert.equal(count("SELECT COUNT(*) AS n FROM message_recipients"), 2 * messages);
    assert.equal(count("SELECT COUNT(*) AS n FROM message_recipients WHERE name = 'User'"), messages);
    assert.equal(count("SELECT COUNT(*) AS n FROM events WHERE type = 'post.created'"), posts);
    assert.equal(count("SELECT COUNT(*) AS n FROM events WHERE type = 'message.created'"), messages);

    // Lockstep lets no writer get more than one write ahead, so in commit order its runs are at most two
    // long. The first 2 × LOCKSTEP - 1 writes are all lockstep writes (one writer may start its burst while
    // the other still owes its last one), hence at least LOCKSTEP - 1 author switches, whatever the scheduler.
    const writers = db.sql
      .prepare(
        `SELECT COALESCE(json_extract(payload, '$.post.author'), json_extract(payload, '$.message.sender')) AS who
         FROM events WHERE type IN ('post.created', 'message.created') ORDER BY id`,
      )
      .all()
      .map((row) => String(row.who));
    const lockstepWrites = writers.slice(0, 2 * LOCKSTEP - 1);
    const switches = lockstepWrites.filter((who, i) => i > 0 && who !== lockstepWrites[i - 1]).length;
    assert.ok(switches >= LOCKSTEP - 1, `writers did not interleave (${switches} switches)`);
  });
});

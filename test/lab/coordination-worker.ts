import { Coordination } from "../../src/lab/coordination.js";
import { openSwarmDb } from "../../src/store/db.js";

const [dbPath, agentId, mode] = process.argv.slice(2);
if (!dbPath || !agentId) throw new Error("Database path and agent ID required");
const db = openSwarmDb(dbPath, { create: false });
const lab = new Coordination(db, { now: () => 1_000, agentTtlMs: 100 });
lab.registerAgent(agentId);

process.on("message", (message: unknown) => {
  if (message !== "go") return;
  let fileToken: string | null = null;
  let taskToken: string | null = null;
  try {
    fileToken = lab.claimFile(agentId, "src/core.ts").token;
  } catch (error) {
    if (!(error instanceof Error) || !/already claimed/.test(error.message)) throw error;
  }
  try {
    taskToken = lab.claimTask(agentId, "core").token;
  } catch (error) {
    if (!(error instanceof Error) || !/not open/.test(error.message)) throw error;
  }
  lab.postMessage(agentId, "Contention probe finished");
  if (mode === "crash") {
    db.sql.exec("BEGIN IMMEDIATE");
    db.sql
      .prepare("INSERT INTO lab_messages (agent_id, body, created_at) VALUES (?, ?, ?)")
      .run(agentId, "Uncommitted crash message", 1_000);
    process.send?.({ type: "uncommitted", fileToken, taskToken });
  } else {
    process.send?.({ type: "result", fileToken, taskToken });
  }
});
process.send?.({ type: "ready" });

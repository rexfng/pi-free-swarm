import { once } from "node:events";
import { BudgetLedger } from "../../src/lab/budget.js";
import { openSwarmDb } from "../../src/store/db.js";

const [dbPath, id, amount, hold] = process.argv.slice(2);
const db = openSwarmDb(dbPath, { create: false });
const ledger = new BudgetLedger(db);
const started = once(process, "message");
process.send?.({ ready: true });
await started;
try {
  ledger.reserve({
    id,
    agentId: "worker",
    taskId: "task",
    provider: "fixture",
    model: "bounded",
    maxCostMicroUsd: Number(amount),
  });
  process.send?.({ reserved: true });
} catch (error) {
  process.send?.({ reserved: false, error: String(error) });
}
if (hold) await once(process, "message");
db.close();
process.disconnect?.();

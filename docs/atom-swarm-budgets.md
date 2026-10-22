# Atom Swarm Lab budgets

`BudgetLedger` stores limits, model policies, request reservations and usage in the same local SQLite database as the lab. One database represents one experiment. Amounts are integer microUSD: **1 USD = 1,000,000 microUSD**. No currency conversion or model pricing is assumed.

## What is enforced

- A request needs configured `swarm`, `agent:<id>` and `task:<id>` limits, plus a matching agent model policy. Missing configuration, invalid amounts and unknown models fail before the gateway invokes its callback.
- A SQLite `BEGIN IMMEDIATE` transaction checks all three scopes and reserves the request's entire maximum cost. Concurrent processes see existing in-flight reservations. Settlement replaces the reservation with recorded spending.
- A limit cannot be lowered below its spent plus reserved amount. Zero limits permit only requests with a verified zero maximum cost.
- Request IDs cannot be reused, including for retries. Repeating the same settlement is idempotent; changing an existing settlement is rejected.
- A failed call with complete usage can be settled with `failed: true`. A thrown callback or invalid usage charges the full reservation and records unknown token counts. A valid reported cost above the reservation is retained even if token metadata is invalid.
- Costs above the reserved maximum freeze all subsequent requests. Raising a limit does not clear that freeze. Already-started external requests cannot be cancelled or made free by the ledger.
- Process death never releases reservations automatically. The request may have reached the provider. Pending reservations survive reopening the database and continue consuming all three allowances indefinitely.

These are **conditional spending guarantees**, not an independent cap on arbitrary provider accounts. Every paid request must pass through this gateway, and its adapter/provider must enforce the exact per-request bound before sending it. Other applications using the same credentials bypass this ledger. The database and configuration are trusted; this is not an authorization boundary against a local process that can edit them.

`providerEnforcesBound: true` is an explicit assertion supplied by the adapter's operator. It does not verify a provider or infer pricing. `maxRequestCostMicroUsd` limits which request ceilings the policy permits; it does not calculate a request's ceiling. The adapter must derive and enforce `request.maxCostMicroUsd` from all billable inputs, output limits, caching, reasoning tokens, tools and provider-specific charges. If it cannot establish an upper bound, it must refuse the request.

## Configuration and boundary example

This executable example uses a deterministic local fixture. Its token and cost values are synthetic accounting inputs; it makes no model requests and incurs no API spending. Save it at the repository root and run it with `node --import tsx/esm example.ts`.

```ts
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSwarmDb } from "./src/store/db.js";
import { BudgetLedger } from "./src/lab/budget.js";
import { BoundedGateway } from "./src/lab/budget-gateway.js";

const directory = mkdtempSync(join(tmpdir(), "atom-budget-"));
const db = openSwarmDb(join(directory, "lab.db"), { create: true });
try {
  const ledger = new BudgetLedger(db);
  for (const scope of ["swarm", "agent:worker", "task:demo"]) {
    ledger.setLimit(scope, 100);
  }
  ledger.setAgentModel("worker", {
    provider: "fixture",
    model: "bounded-demo",
    maxRequestCostMicroUsd: 20,
    providerEnforcesBound: true,
  });
  const result = await new BoundedGateway(ledger).execute(
    {
      id: randomUUID(),
      agentId: "worker",
      taskId: "demo",
      provider: "fixture",
      model: "bounded-demo",
      maxCostMicroUsd: 20,
    },
    async (reservation) => {
      const fixtureCost = 12;
      if (fixtureCost > reservation.maxCostMicroUsd) throw new Error("Fixture exceeds bound");
      return {
        value: "fixture completed",
        usage: { inputTokens: 8, outputTokens: 2, costMicroUsd: fixtureCost },
      };
    },
  );
  console.log(result, ledger.status("worker", "demo"));
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
```

Only replace the fixture callback after implementing and verifying a provider adapter. A timeout, transport failure or cancellation after dispatch is ambiguous; do not refund it. To record such a request manually, use `ledger.markUncertain(id, { failed: true })`. There is no automatic refund or reconciliation API. A retry is a new reservation ID; pass `{ retry: true }` as the third argument to `execute`.

The CLI exposes limit configuration and inspection, not paid execution:

```sh
npm run lab -- limit swarm 0 --db /absolute/path/lab.db
npm run lab -- limit agent:worker 0 --db /absolute/path/lab.db
npm run lab -- limit task:demo 0 --db /absolute/path/lab.db
npm run lab -- status --db /absolute/path/lab.db
```

`get_budget` exposes the connection agent's accounting through MCP. Budget configuration and provider execution are deliberately programmatic operator operations. Stock Pi, Codex and Copilot model requests are not intercepted by this lab MCP server.

## Accounting and remaining work

`status()` exposes limits, spent/reserved/remaining microUSD, individual requests, model/provider names, timestamps, token totals, failure/retry counts and the freeze flag. Agent/task filters select relevant request records. Scope spending includes both successful and failed attempts. Unknown token counts remain `null` on reservations and contribute to `unknownUsage`; aggregate token totals include only known values. Optional cache read/write token fields default to zero when omitted, so zero is not evidence that the provider reported caching statistics.

The adapter supplies usage and cost. The ledger does not independently verify billing, fetch prices, normalize provider token conventions or distinguish estimates from invoices. No current model/pricing selection, paid provider adapter, account-wide enforcement, authenticated remote service, escalation policy or automatic crash reconciliation is implemented. Configure and verify those before a paid experiment; keep bounded fixture runs separate from real spending results.

Run the focused checks with:

```sh
node --import tsx/esm --test test/lab/budget.test.ts
```

They cover competing subprocesses, in-flight affordability, process death, failed and malformed responses, retry/settlement idempotency, scope limits, and provider-bound breaches. They demonstrate the local ledger and fixture boundary; they are not provider compatibility tests.

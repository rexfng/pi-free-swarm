# Atom Swarm Lab

This fork adds a reusable local coordination service alongside the existing Pi extension. The Lab CLI, MCP server and `/lab` view use one SQLite WAL database per experiment. The original Pi runner and board remain available; its agents do not automatically gain Lab workspaces or budget enforcement.

## Hosted demonstration

Open the [dashboard](https://atom-swarm-lab.vercel.app/lab) and [interactive ray tracer](https://atom-swarm-lab.vercel.app/raytracer/). The dashboard contains the recorded three-agent experiment, with agent activity, tasks and messages. It explicitly labels the recording and does not poll or control agents. The ray tracer runs interactively in the browser.

This Vercel deployment serves static files. It does not host the SQLite service or run background agents. Use the local board below for live experiments. A shared remote service would additionally need persistent compute/storage and authenticated clients.

To export a new recording from a local run:

```sh
npm run build:ui
node --import tsx/esm src/lab/cli.ts status --db /absolute/disposable/lab.db > /tmp/lab-snapshot.json
node scripts/export-preview.mjs /tmp/lab-snapshot.json /tmp/atom-swarm-preview
```

Choose a new output directory. The exporter includes Vercel routing, strips absolute local paths and credential-like fields, and refuses common credential patterns. Review exported messages before publication; automated filtering cannot identify every kind of private content. Deploy only the generated static directory. The deployed project is `atom-swarm-lab` in the Origineer Consulting team.

## Run from the checkout

Requires Node 22.13 or newer on macOS/Linux, Git and npm.

```sh
npm ci
npm run build:ui
npm run check
npm run lab -- --help
npm run lab -- call register_agent --agent peer1 --db /absolute/disposable/lab.db
npm run lab -- call create_task '{"id":"render","title":"Build renderer"}' --db /absolute/disposable/lab.db
npm run lab -- call claim_task '{"taskId":"render"}' --agent peer1 --db /absolute/disposable/lab.db
npm run lab -- board --db /absolute/disposable/lab.db --port 3011
```

Open `http://127.0.0.1:3011/lab`. The existing React application displays live agent states, task evidence, leases/conflicts, activity intervals, throughput, retries, tool failures and gateway budget/usage. It polls once per second. The dashboard is read only and binds to loopback. It has no authentication and must not be forwarded or exposed to other users.

Each connection uses a fixed `--agent` identity. IDs use lowercase letters, digits, underscores and hyphens, up to 64 characters. Register once; heartbeat before the agent TTL (default 60 seconds). Task/file leases default to 30 seconds and require their own renewals. Keep returned tokens: renewal, release, completion and controlled writes reject stale tokens. An active ID cannot be registered again. After a crash, expiry permits recovery. Use a **new identity for each restarted process**: identities are trusted and are not authenticated session generations; a stale process could act under a reused identity, although its old resource tokens stay invalid.

## Workspaces and writes

Start with a **disposable, clean Git repository with an initial commit**. Supply `--repo /path/to/repo --workspaces /path/outside/repo/worktrees` to CLI/MCP. `create_workspace` creates a branch/worktree for the fixed agent. `write_file` requires a lease for its project-relative path. `--input /path/to/arguments.json` accepts larger tool arguments without shell escaping.

The write tool holds the SQLite writer transaction through lease validation and atomic file replacement. It rejects traversal, symlinks, Git internals and ambiguous portable paths. Logical lease keys are NFC-normalized and case-folded, deliberately over-conflicting on case-sensitive filesystems. A released/expired token can never become valid again.

`WorkspaceManager.integrate(workspace, commitSha)` integrates one committed change at a time. It requires clean attached source/target branches, validates lineage, serializes integration and aborts conflicts. It rejects overwriting ignored local data. Review and run independent tests after integration; task completion alone does not prove correctness.

Worktrees isolate source changes, **not host access**. Shells, editors and other tools can bypass the controlled write API; agents share OS permissions and Git metadata. Run untrusted agents in containers or OS sandboxes with narrowly mounted worktrees, restricted network and broker access, and no host credentials. Containers are not implemented here. Never aim the first experiment at Atom Files production code.

Git metadata mutations are serialized through the shared database and a filesystem operation lock. Interrupted Git operations/locks require inspection and manual recovery. An interrupted atomic write may leave a harmless temporary file. Hooks are disabled for managed Git commands; external Git filters/configuration and unrestricted shells are outside the boundary.

## MCP

The implementation uses the official TypeScript MCP SDK and standard stdio transport. Invoke Node directly: npm's script banner must not enter MCP stdout.

```json
{
  "mcpServers": {
    "atom-swarm-lab": {
      "command": "/absolute/path/to/node",
      "args": [
        "--import", "/absolute/path/to/pi-free-swarm/node_modules/tsx/dist/esm/index.mjs",
        "/absolute/path/to/pi-free-swarm/src/lab/cli.ts", "mcp",
        "--db", "/absolute/disposable/lab.db", "--agent", "peer1",
        "--repo", "/absolute/disposable/repo",
        "--workspaces", "/absolute/disposable/worktrees"
      ]
    }
  }
}
```

Translate this server entry to the client's configuration format. Give each participating client a different identity but the same absolute database/repository paths. Tools include registration/heartbeat/stop, board/direct messages, task discovery/dependencies/claim/renew/release/complete, file claim/renew/release, activity reporting/correction, budget/status, workspace creation and controlled writes. No shell or API-key tool is exposed.

Verified: independent official-SDK MCP clients initialize the server, discover schemas, execute tools and coordinate across processes. This is an actual client outside Pi. Interactive Codex, Copilot and Pi MCP integration has **not** been exercised; do not equate protocol tests with those product integrations. Their model requests occur outside this server and are neither metered nor limited by it.

## Telemetry and budgets

Tool invocations through Lab are timed and durably recorded. Deterministic tool-name classification records source/confidence and non-overlapping time intervals. `report_activity` sets explicit state; `correct_activity` changes a previous interval with an audit trail. Lifecycle expiry closes activity at the agent deadline, not at the later recovery sweep. Activity between events is an estimate; unsupported external tools, token usage, compaction and duplicate investigations are not automatically visible.

`BudgetLedger` stores integer micro-USD limits, atomic reservations, tokens/cache usage, provider/model, failures and retries at swarm/agent/task levels. `BoundedGateway` reserves **before** executing its callback. Unknown bounds or missing limits fail closed. Crashed in-flight reservations do not expire or refund; uncertain requests consume their full reservation. Exceeding a declared bound freezes further calls. See [budget guarantees](atom-swarm-budgets.md).

There is no real provider adapter yet. Hard spending guarantees require an adapter that enforces a known per-request upper bound and exclusive routing through the gateway. Merely configuring an assertion is not provider verification. Existing Pi/Codex/Copilot requests bypass it. No paid model experiment or model/pricing comparison is claimed. Model selection, current prices and provider-specific bound verification are prerequisites for a future approved paid run.

## Completion and scaling

A lab run is peer-complete when it has at least one task, all tasks are marked done and no live file claims remain. Dependencies must be done before a task can be claimed. Expired agents reopen unfinished claimed tasks and release files; durable messages remain. Completion evidence is self-reported and must be checked separately against integrated code/tests.

SQLite transactions provide local process coordination; this is not a distributed broker. Database files belong on a local filesystem. The current status API reads complete history, so large runs need pagination, retention and query tuning. Three-peer tests are provided; throughput at 10–30 live model agents is not established.

## Next implementation steps

1. Add and verify one paid provider adapter with a conservative request bound, request timeout, maximum steps and escalation budget.
2. Connect actual Pi/Codex/Copilot events and verify each client, including compaction and failed-call usage.
3. Add container/OS isolation and restrict all writes and outbound model requests to controlled boundaries.
4. Run the approved three-inexpensive-agent experiment and a matched single-agent baseline, reporting cost per independently verified completion.

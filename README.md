# pi-free-swarm

This fork includes **Atom Swarm Lab**, a local SQLite coordination service with file leases, isolated Git worktrees, a budget gateway, activity telemetry, MCP tools and a dashboard. Start with the [Lab run guide and verified limitations](docs/atom-swarm-lab.md). The original Pi runner described below remains separate from these safeguards.

Try the [recorded swarm dashboard](https://atom-swarm-lab.vercel.app/lab) and [interactive ray tracer](https://atom-swarm-lab.vercel.app/raytracer/) built by three coding peers. The public demonstration serves a saved run; use the local service for live coordination.

A pi extension that runs a leaderless group of agents on one task, in one shared working tree. Agents coordinate through a wall and messages; you follow their work on a local web board. The main agent reviews the actual changes when they finish.

## Requirements and installation

- **Node.js ≥22.13**, for built-in SQLite. Bun is not supported.
- **pi ≥0.87**, with a configured model and credentials.
- **Linux or macOS**: process-tree cleanup currently uses POSIX process groups; Windows is not supported.

```sh
pi install npm:oira666_pi-free-swarm
```

The extension is **off by default**, even when the project already has swarm data. Enable it for a pi invocation:

```sh
pi --swarm
# or
PI_SWARM_ENABLED=1 pi
```

Only the exact environment values `1` and `true` enable it; `0`, `false`, unset and other values do not. `--swarm` enables it regardless of the environment value. Disabled main sessions register no swarm tools and start no board, database or cleanup handlers. Internal children with `PI_SWARM_ROLE=agent` automatically get agent communication tools without either opt-in.

Start enabled pi in the project you want to work on. Write requirements to a file, then ask the main agent to launch a swarm and include that file's path in its task prompt. Agents inherit the main session's current model, thinking level, project-trust decision and explicit extension arguments.

## Tools and workflow

The main agent gets:

- `swarm(swarm_name, task_prompt, agent_amount?)`: start a swarm; default **5 agents**, launched **30 seconds apart**. Use a short name (≤60 characters) and a concise task prompt pointing to requirements files.
- `resume_swarm(swarm_id, message)`: resume with feedback (up to 4,000 characters), reusing each agent's session. Agents restart **5 seconds apart**. A fresh run lock prevents another process from resuming the same swarm concurrently.

Both tools block and stream agent counts, activity, elapsed time, cost and a board URL. Completion requires all agents to have launched, every agent to be idle or permanently crashed, and no outstanding deliverable agent messages, continuously for **15 seconds**. Finished means the agents stopped working—not that their work is correct. The result includes a wall digest (at most 150 posts) and asks the main agent to review files, diffs and tests.

**Esc aborts the run** and stops its agents (SIGTERM, then SIGKILL after 5 seconds if needed). Finished, stopped and interrupted swarms can be resumed by any enabled main pi session in the same project.

Every peer gets the same coordination tools, not `swarm` or `resume_swarm`:

| Tool | Purpose |
| --- | --- |
| `swarm_read_posts` | Read history or use the returned `after` cursor for incremental posts and comments |
| `swarm_read_post` | Read a post and its comments |
| `swarm_post` | Post a plan or status |
| `swarm_comment` | Comment on a post |
| `swarm_message` | Start a direct or group thread |
| `swarm_reply_to` | Reply to other members of a thread |
| `swarm_read_thread` | Read a thread's history |
| `swarm_acceptance` | Inspect, self-claim, record or challenge the whole task's acceptance judgment |

Posts, comments and messages are told to stay within `bodyMaxChars` (default 200 characters) and to put longer material in files. Up to twice that is stored as-is to absorb miscounting; anything longer is not rejected: the full text is saved under `.pi/swarm/attachments/<swarm>/` and the stored body ends with its path. Titles allow 60 characters. Wall lists show stored bodies whole; complete posts remain readable. Messages wake idle agents; wall posts do not. Agents may message `User`, with terminal notifications when UI is available.

Acceptance is separate from execution status. Any peer can volunteer to check the original task and record evidence, gaps and an accepted, incomplete or blocked verdict. Revision checks prevent conflicting updates; no roles or reviewer quorum are imposed. At quiescence, an unchecked task triggers at most one targeted checkpoint notice per run. Unresolved work may still finish execution; it is not reported as task success.

**Accepted means peer-attested, not independently verified.** Later artifact changes are not detected automatically. Peers may challenge the judgment; resuming resets it. Main results are bounded, with full oversized output saved to a readable file.

## Board

Open the URL in the tool box, normally `http://127.0.0.1:3010/s/1`. Pick a swarm and switch between:

- **Agents**: status, User inbox first, direct/group threads and delivery/read state.
- **Wall**: plans, updates and comments.
- **Work**: agent session activity, thinking and tool calls/results.
- **Stats**: token usage, cost, active time and wall time.

Messages can be sent through the board only while the swarm is live. The wall remains writable after it ends, while the board is hosted. Undeliverable messages are not replayed on resume.

One enabled main pi process hosts the project's board; other enabled sessions can take over, polling every 5 seconds and normally retaining the port. The server exists only while an enabled main pi process is running in that project. Opening an empty project creates no swarm data or server; an existing database starts hosting automatically only in enabled sessions.

Port selection: `settings.port`, then the process environment's `PI_SWARM_PORT`, otherwise **3010–3030**, trying the previous host's port first. An explicit port has **no fallback**: a bind failure is reported, though agent work can continue without the board.

## Settings

Optional, hand-written `.pi/swarm/settings.json`:

```json
{
  "minAgents": 1,
  "maxAgents": 10,
  "defaultAgents": 5,
  "staggerSeconds": 30,
  "bodyMaxChars": 200,
  "idleReminderDelay": 60000,
  "idleReminderMax": 5,
  "idleReminderDigestSize": 10,
  "env": {
    "NODE_ENV": "development"
  }
}
```

These are the agent-count and stagger defaults; `env` defaults to `{}` and `port` is unset. To pin a port, add e.g. `"port": 3010` (integer 1–65535).

- `minAgents` is an integer ≥1; `maxAgents` must be ≥`minAgents`. If only `minAgents` exceeds 10, the implicit maximum rises to match it.
- `defaultAgents` is clamped into the allowed range. An explicit `agent_amount` outside it is rejected, never silently clamped.
- `staggerSeconds` is the nonnegative interval between worker launches on a fresh swarm, default 30 seconds. The first worker starts immediately; every other worker starts at its scheduled interval regardless of agent activity. Resume uses a fixed 5-second interval.
- `bodyMaxChars` is an integer from 100 to 16,000: the limit stated to agents and shown in board counters. Main's resume feedback keeps its own 4,000-character limit.
- `idleReminderDelay` (milliseconds, integer ≥0) is how long an agent may stay idle before it is reminded that the task is not accepted yet; the reminder includes the newest `idleReminderDigestSize` wall posts (integer ≥1). `idleReminderMax` (integer ≥0) caps reminders per agent in a row; a real message or the agent's own wall post resets the count, and `0` disables reminders. No reminders are sent once the acceptance verdict is accepted or blocked.
- Settings are re-read on each launch/resume; the run keeps that snapshot for revives. Port settings apply when hosting starts.
- Invalid settings fail the tool. Unknown keys produce warnings.
- `env` values must be strings. They override inherited environment values. Keys starting with **`PI_SWARM_` are reserved** and ignored with a warning in `env`; the extension sets agent identity itself.

The extension does not store configured env values in its database or expose them in settings diagnostics or the board. This is not secret isolation: children inherit them, can read project files, and their commands/output may reveal secrets in sessions. Protect credentials accordingly.

## Runtime data and git

```text
.pi/swarm/
  settings.json
  swarm.db                 # SQLite; WAL/SHM sidecars while open
  sessions/<swarm-id>/<agent-name>/
    session.jsonl          # same file for launch, revive and resume
    system-prompt.md
```

Session files appear after the first persisted message. The board's static assets live in the extension, not your project.

Suggested `.gitignore` entries (the extension does not write them):

```gitignore
.pi/swarm/*
!.pi/swarm/settings.json
```

If settings contain secrets, omit the exception and ignore `settings.json` too.

## Recovery and limits

- Startup watchdog: **120 seconds** without output before the first model turn, with **2 startup retries**. Inactivity watchdog: **20 minutes** without output after it. Any record the agent process writes counts, including other extensions' notifications and statuses, so an extension that waits long keeps its agent alive by reporting periodically; a silent process still times out. Idle agents and active tool executions are not timed out; a hung tool can still block progress.
- Nonfatal crashes allow **3 revives per agent per run**, delayed 5, 30 and 120 seconds. Fatal startup failures are not revived. Exhausted agents are reported on the wall; the remaining swarm can finish.
- Process-level overrides: `PI_SWARM_STARTUP_TIMEOUT` and `PI_SWARM_IDLE_TIMEOUT` (milliseconds), `PI_SWARM_STARTUP_RETRIES` (count). Set them in pi's environment, not settings `env`.
- Agents check their runner's PID every 5 seconds. A dead runner leads to shutdown; another enabled main session can clean up the stale run and resume it.
- Run locks expire after **20 seconds** without a heartbeat. Local sweeps protect runs this process still owns, but another process cannot distinguish a paused/blocked runner from a dead one. **Do not pause a runner while another main process is sweeping the same project**: it may mark the run interrupted before the old runner notices ownership loss.

This is a **localhost PoC with no authentication**, not a sandbox or multi-user service. Do not expose its port. Agents share filesystem permissions and one working tree, with no worktree isolation or enforced file locks. Peers receive the same short interface description, without assigned roles or a coordination playbook. Duplicate edits and overwrites remain possible. Review diffs and tests yourself.

Model-dependent acknowledgment/completion loops have occurred, especially after group feedback on resume, with the earlier prompt guards. They can prevent completion and keep spending; watch the board and abort if needed. There is no hard message or cost budget. A five-agent run, real TUI Esc and host takeover were observed; provider rate limiting prevented several further recovery checks. See the [PoC evidence and gaps](https://github.com/gee666/pi-free-swarm/blob/main/docs/poc-run.md).

## Development and packaging

From a checkout:

```sh
npm ci
pi -e . --swarm          # try this checkout without installing it
npm run check            # types, formatting, size, backend/UI tests, package contents
npm run build:ui
npm run check:package
```

For another working project, use `pi -e /absolute/path/to/pi-free-swarm --swarm`. Backend TypeScript loads directly through pi; no backend build is needed.

**`ui_dist/` is committed and shipped.** After UI changes, run `npm run build:ui` and include the rebuilt assets with the source changes. Users do not run Vite to use the board.

The `pi.extensions` manifest points to `index.ts`. The npm file allowlist ships the entry point, `src/` (including `store/schema.sql`), prebuilt board/fonts, README and license. Pi supplies the declared peer packages. `npm run check:package` checks `npm pack --dry-run --json` for required files and excludes scratch data, runtime data and implementation plans. It checks package contents, not whether the prebuilt UI is up to date.

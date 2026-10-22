# Implementation log

- Verified upstream `gee666/pi-free-swarm` at `c2f66e5` (0.3.2), default branch `master`, latest push 2026-10-14. Created `rexfng/pi-free-swarm` preserving history and MIT attribution; work is on `feat/atom-swarm-lab`.
- YouTube oEmbed identified `S2sjyokoxeE` as IndyDevDan's “Are Agent Swarms USEFUL? OpenAI’s GPT-6 Astra SWARM Takeaways”. Metadata confirms the linked author/video, not every implementation detail in the demonstration.
- Inspected upstream: SQLite operational store/outbox, Pi process supervisor, shared working directory, wall/messages/acceptance, session usage parsing and React board. No exclusive file leases, per-agent worktrees, reusable MCP service or hard request-budget boundary existed.
- Clean upstream `npm run check`: 375/377 backend tests passed. One failure assumed experimental SQLite warnings were absent from child stderr; one used a real 300 ms startup deadline under load. The latter passed in isolation. Updated the subprocess warning flag and used the existing fake clock for watchdog behavior tests.
- Added provider-independent Lab coordination, resource recovery, activity/timing, workspaces/integration, budget gateway, MCP/CLI and a dashboard route. Dedicated tests cover concurrent claims, stale fencing, process crash, request oversubscription, lifecycle and path escapes.
- Updated vulnerable compatible transitive dependencies, React Router and Vitest; validation results and any remaining audit findings are recorded in the experiment report.
- Paid provider calls were not run. Runtime artifacts live in disposable repositories, separate from all Atom production repositories.

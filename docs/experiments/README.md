# Initial experiments — 2026-10-21 (Vancouver)

## Three coding peers: interactive ray tracer

Three actual agents from the development session received the same brief, registered in Lab, discovered three open tasks and claimed different work. They used separate Git worktrees and controlled file writes with exclusive leases. Board discussion resolved camera-angle units and shared the actual math module for renderer verification. Root supplied the task seeds/module contract and performed final integration/review; this is not a wholly leaderless end-to-end execution engine.

| Peer | Discovered task | Claim to completion | Classified active time | Lab tool calls |
|---|---|---:|---:|---:|
| peer-a | Math/intersections | 97.1 s | 88.9 s | 18 |
| peer-b | Renderer/shadows | 158.9 s | 158.8 s | 18 |
| peer-c | Interface/controls | 175.1 s | 175.2 s | 25 |

The interval from first registration to last peer stop was **186.2 seconds**. Integration and browser review took additional operator time and are not included in that interval. The peers exchanged **9 board messages**, with **0 exclusive file conflicts**, **0 task retries**, and **0 failed recorded Lab calls**. One wrong-working-directory CLI invocation failed before it reached Lab; the peer corrected and disclosed it. All three commits integrated without conflict. The combined project passes **19 tests**, including vector/intersection cases, deterministic rendered pixels, changing light/reflection/camera options, and UI control/error handling.

The browser rendered the scene and accepted reflection/camera changes. Screenshots are generated during verification in `output/playwright/`. The app source is in `examples/raytracer/`; run `npm --prefix examples/raytracer test`, then `python3 -m http.server 3012 --bind 127.0.0.1 --directory examples/raytracer` and open port 3012.

**Measurement limits:** the session does not expose per-peer model token/cost totals, so they are `null`, not zero. No additional paid model API request was launched by Lab. The workers were the current session's agents, not three independently selected inexpensive models. Activity largely uses explicit state reports with tool spans; coordination-tool execution is only a lower bound on coordination effort. Duplicate investigations are not measured. A matched one-agent AI baseline was not run, so this exercise does not establish a speed or cost advantage.

Machine-readable evidence: [raytracer-run.json](raytracer-run.json). Completion includes peer attestations and the separate integrated tests; code inspection and browser verification were performed by root.

## Reproducible protocol benchmark

This separate benchmark uses **scripted subprocesses, no LLM**, over actual MCP stdio connections. It verifies concurrent registration/discovery/claiming, messages, controlled worktree writes, integration and independent assertions using fixed fixtures. It is not an AI coding benchmark.

| Workers | Wall time including startup/integration/checks | Messages | Tool calls | Task claim conflicts | Final tests |
|---|---:|---:|---:|---:|---:|
| 3 | 3.531 s | 9 | 34 | 1 | 3 passed |
| 1 | 1.736 s | 5 | 23 | 0 | 3 passed |

One concurrent task-claim loser was expected and discovered other work. Source writes had no conflicts; all tasks completed. Token usage is inapplicable/null and extra API spending is $0. Process/coordination startup dominates these tiny fixture tasks, so adding workers increased elapsed time. These are single observations on a busy development machine, not statistically reliable throughput estimates. Later telemetry fixes also count successful `stop_agent` calls; the archived reports retain the counts originally observed.

An earlier repeated smoke run exposed concurrent `git worktree add` metadata interference. The service now serializes creation through the database, and the workspace manager shares one filesystem lock for creation/integration. The verified runs above follow that fix; the failure is not hidden from the implementation record.

Reproduce from a checkout, choosing new output directories:

```sh
npm run lab -- benchmark --output /tmp/atom-protocol-three --agents 3
npm run lab -- benchmark --output /tmp/atom-protocol-one --agents 1
```

Each run writes `report.json`, `lab.db`, a disposable Git repository and worktrees. Reports include per-agent activity, messages, usage availability, failures, commits, and test output. Existing directories are refused. Workers and requests have bounded timeouts and failed children are terminated. Evidence: [three workers](protocol-three.json), [one worker](protocol-one.json).

## Remaining dependency issue

Initial audit reported 8 vulnerable packages. Compatible updates plus React Router 7.18.4 and Vitest 5.0.5 reduced this to one high-severity `brace-expansion` dependency pinned by Pi 0.87.1's published npm shrinkwrap. The attempted root override did not replace that nested pin and was removed. Updating the Pi runtime to its newer major version needs a separate compatibility migration; it has not been silently changed. The local Lab does not expose a globbing API, but the inherited dependency remains and is not described as fixed.

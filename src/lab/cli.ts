import path from "node:path";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { openLab } from "./service.js";
import { startMcp } from "./mcp.js";
import { startLabBoard } from "./server.js";
import { runBenchmark } from "./benchmark.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    agent: { type: "string", default: "operator" },
    repo: { type: "string" },
    workspaces: { type: "string" },
    port: { type: "string", default: "3011" },
    ttl: { type: "string", default: "60000" },
    input: { type: "string" },
    help: { type: "boolean" },
    output: { type: "string" },
    agents: { type: "string", default: "3" },
  },
});

if (values.help || !positionals[0]) {
  console.log(`Atom Swarm Lab
  npm run lab -- status --db /absolute/path/lab.db
  npm run lab -- call register_agent --agent peer1 --db /absolute/path/lab.db
  npm run lab -- call create_task '{"id":"task1","title":"Build a thing"}' --db /absolute/path/lab.db
  npm run lab -- board --db /absolute/path/lab.db --port 3011
  node --import tsx/esm src/lab/cli.ts mcp --db /absolute/path/lab.db --agent peer1
  npm run lab -- limit swarm 0 --db /absolute/path/lab.db
  npm run lab -- benchmark --output /absolute/new/run --agents 3
  call accepts --input /path/to/arguments.json instead of inline JSON.
  Add --repo /disposable/repo --workspaces /disposable/worktrees for controlled write tools.
  One database represents one lab run. No model calls are made by this CLI.`);
} else if (positionals[0] === "benchmark") {
  if (!values.output) throw new Error("benchmark requires --output pointing to a new directory");
  console.log(JSON.stringify(await runBenchmark(path.resolve(values.output), Number(values.agents)), null, 2));
} else {
  const lab = openLab({
    dbPath: path.resolve(values.db ?? ".pi/swarm/lab.db"),
    agentId: values.agent,
    repoPath: values.repo,
    workspaceRoot: values.workspaces,
    agentTtlMs: Number(values.ttl),
  });
  let persistent = false;
  try {
    switch (positionals[0]) {
      case "status":
        console.log(JSON.stringify(lab.snapshot(), null, 2));
        break;
      case "call": {
        const input = values.input ? readFileSync(values.input, "utf8") : (positionals[2] ?? "{}");
        console.log(JSON.stringify(lab.call(positionals[1], JSON.parse(input)), null, 2));
        break;
      }
      case "limit":
        lab.budget.setLimit(positionals[1], Number(positionals[2]));
        console.log(JSON.stringify(lab.budget.status(), null, 2));
        break;
      case "board": {
        const port = Number(values.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
        const board = await startLabBoard(lab, port);
        console.error(`Atom Swarm Lab: http://127.0.0.1:${board.port}/lab`);
        const close = async () => {
          await board.close();
          lab.close();
        };
        process.once("SIGINT", () => void close());
        process.once("SIGTERM", () => void close());
        persistent = true;
        break;
      }
      case "mcp": {
        const mcp = await startMcp(lab);
        mcp.onclose = () => lab.close();
        persistent = true;
        break;
      }
      default:
        throw new Error(`Unknown command: ${positionals[0]}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (!persistent) lab.close();
  }
}

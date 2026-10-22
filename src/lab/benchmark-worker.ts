import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const BENCHMARK_FIXTURES = [
  {
    id: "vector",
    path: "vector.mjs",
    title: "Write the fixed vector dot-product fixture",
    content: "export function dot(a, b) { return a.reduce((sum, x, i) => sum + x * b[i], 0); }\n",
  },
  {
    id: "sphere",
    path: "sphere.mjs",
    title: "Write the fixed sphere-intersection fixture",
    content:
      "export function hitSphere(origin, direction, radius = 1) {\n  const a = direction.reduce((s, x) => s + x*x, 0);\n  const b = 2 * origin.reduce((s, x, i) => s + x*direction[i], 0);\n  const c = origin.reduce((s, x) => s + x*x, 0) - radius*radius;\n  const discriminant = b*b - 4*a*c;\n  if (a === 0 || discriminant < 0) return null;\n  const roots = [(-b-Math.sqrt(discriminant))/(2*a), (-b+Math.sqrt(discriminant))/(2*a)].filter(t => t >= 0);\n  return roots.length ? Math.min(...roots) : null;\n}\n",
  },
  {
    id: "shade",
    path: "shade.mjs",
    title: "Write the fixed Lambert shading fixture",
    content:
      "export function lambert(normal, light) { return Math.max(0, normal.reduce((sum, x, i) => sum + x * light[i], 0)); }\n",
  },
];

const optionsSchema = z.object({
  dbPath: z.string(),
  repoPath: z.string(),
  workspaceRoot: z.string(),
  agentId: z.string(),
  maxTasks: z.number().int().min(1).max(3),
});
const tasksSchema = z.array(z.object({ id: z.string(), status: z.string() }));
const claimSchema = z.object({ token: z.string() });

async function worker(raw: unknown): Promise<void> {
  const options = optionsSchema.parse(raw);
  const client = new Client({ name: "atom-lab-scripted-benchmark", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx/esm",
      fileURLToPath(new URL("./cli.ts", import.meta.url)),
      "mcp",
      "--db",
      options.dbPath,
      "--repo",
      options.repoPath,
      "--workspaces",
      options.workspaceRoot,
      "--agent",
      options.agentId,
      "--ttl",
      "60000",
    ],
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stderr: "pipe",
  });
  let serverErrors = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    serverErrors = (serverErrors + chunk.toString()).slice(-4000);
  });
  async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
    const parsed = z
      .object({
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
        isError: z.boolean().optional(),
      })
      .parse(result);
    const text = parsed.content.find((item) => item.type === "text")?.text;
    if (parsed.isError) throw new Error(text ?? `${name} failed`);
    if (!text) throw new Error(`Missing MCP result for ${name}`);
    const value: unknown = JSON.parse(text);
    return value;
  }
  let completed = 0;
  let claimConflicts = 0;
  try {
    await client.connect(transport);
    await call("register_agent");
    await call("post_message", { body: "Scripted fixture worker ready; no model is running." });
    await call("create_workspace");
    const start = new Promise<void>((resolveStart) => {
      process.once("message", (message: unknown) => {
        if (message === "start") resolveStart();
        else throw new Error("Unexpected benchmark start signal");
      });
    });
    process.send?.({ type: "ready", agentId: options.agentId });
    await start;
    // Each pass tries each discovered task at most once; there is no unbounded retry loop.
    const tasks = tasksSchema.parse(await call("list_tasks"));
    for (const task of tasks) {
      if (completed >= options.maxTasks || task.status !== "open") continue;
      const fixture = BENCHMARK_FIXTURES.find((entry) => entry.id === task.id);
      if (!fixture) throw new Error(`Unknown fixture task: ${task.id}`);
      let taskToken: string;
      try {
        taskToken = claimSchema.parse(await call("claim_task", { taskId: task.id })).token;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Task is not open:")) throw error;
        claimConflicts += 1;
        continue;
      }
      await call("post_message", { body: `Claimed ${task.id}; writing predetermined fixture ${fixture.path}.` });
      const lease = claimSchema.parse(await call("claim_file", { path: fixture.path }));
      await call("write_file", { path: fixture.path, token: lease.token, content: fixture.content });
      await call("release_file", { path: fixture.path, token: lease.token });
      await call("complete_task", {
        taskId: task.id,
        token: taskToken,
        evidence: "Fixed fixture written; integration runner will execute independent assertions.",
      });
      completed += 1;
    }
    if (completed !== options.maxTasks) throw new Error(`Expected ${options.maxTasks} tasks, completed ${completed}`);
    await call("post_message", { body: `Completed ${completed} scripted fixture task(s).` });
    await call("stop_agent");
    process.send?.({ type: "done", agentId: options.agentId, completed, claimConflicts });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${serverErrors ? `\nMCP stderr: ${serverErrors}` : ""}`,
    );
  } finally {
    await client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await worker(JSON.parse(process.argv[2]));
  } catch (error) {
    process.send?.({ type: "failure", error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
}

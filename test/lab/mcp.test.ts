import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { openLab } from "../../src/lab/service.js";
import { startLabBoard } from "../../src/lab/server.js";

test("external SDK MCP client initializes, discovers schemas, calls tools and preserves fixed identity", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "atom-lab-mcp-"));
  const client = new Client({ name: "independent-mcp-test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx/esm", "src/lab/cli.ts", "mcp", "--db", path.join(dir, "lab.db"), "--agent", "mcp-peer"],
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const name of [
      "register_agent",
      "post_message",
      "claim_task",
      "claim_file",
      "report_activity",
      "get_budget",
    ]) {
      assert.ok(
        tools.some((tool) => tool.name === name && tool.inputSchema.type === "object"),
        name,
      );
    }
    const bad = await client.callTool({ name: "register_agent", arguments: { agentId: "impersonated" } });
    assert.equal(bad.isError, true);
    const registered = await client.callTool({ name: "register_agent", arguments: {} });
    assert.notEqual(registered.isError, true);
    const result = await client.callTool({ name: "post_message", arguments: { body: "SDK client verified" } });
    assert.notEqual(result.isError, true);
    const status = await client.callTool({ name: "get_swarm_status", arguments: {} });
    const content = z.array(z.object({ type: z.literal("text"), text: z.string() })).parse(status.content);
    const data = z
      .object({
        coordination: z.object({
          agents: z.array(z.object({ id: z.string() })),
          messages: z.array(z.object({ agentId: z.string() })),
        }),
      })
      .parse(JSON.parse(content[0].text));
    assert.deepEqual(
      data.coordination.agents.map((agent) => agent.id),
      ["mcp-peer"],
    );
    assert.equal(data.coordination.messages[0].agentId, "mcp-peer");
    const blocked = await client.callTool({
      name: "write_file",
      arguments: { path: "x.ts", token: "bad", content: "x" },
    });
    assert.equal(blocked.isError, true);
    await client.callTool({ name: "stop_agent", arguments: {} });
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboard uses the same persisted state, rejects foreign browser origins and is read only", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "atom-lab-http-"));
  const lab = openLab({ dbPath: path.join(dir, "lab.db"), agentId: "peer" });
  const board = await startLabBoard(lab, 0);
  const url = `http://127.0.0.1:${board.port}/api/lab/status`;
  try {
    lab.call("register_agent", {});
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const data = z
      .object({ coordination: z.object({ agents: z.array(z.object({ id: z.string() })) }) })
      .parse(await response.json());
    assert.equal(data.coordination.agents[0].id, "peer");
    assert.equal((await fetch(url, { headers: { Origin: "https://foreign.example" } })).status, 403);
    assert.equal((await fetch(url, { method: "POST" })).status, 405);
  } finally {
    await board.close();
    lab.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Lab } from "./service.js";

export async function startMcp(lab: Lab) {
  const server = new Server({ name: "atom-swarm-lab", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: lab.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { ...z.toJSONSchema(tool.schema), type: "object" as const },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(lab.call(params.name, params.arguments ?? {})) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });
  await server.connect(new StdioServerTransport());
  return server;
}

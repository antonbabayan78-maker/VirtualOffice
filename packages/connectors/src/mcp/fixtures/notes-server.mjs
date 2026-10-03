/**
 * A real MCP server, for the transport tests.
 *
 * Built with the official SDK on purpose: it is the oracle this office's
 * hand-written client is checked against, so a test failure means our wire is
 * wrong rather than that two halves of one library agree with each other.
 *
 * Plain JavaScript because `notes-stdio.mjs` spawns it as a process, and the
 * SDK is a devDependency of this package, so nothing here reaches a deploy
 * image.
 *
 * It offers one tool of each kind the gate cares about: one that only reads,
 * one that acts, and one that fails on purpose.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** The same two tools wherever this server is mounted, stdio or HTTP. */
export function notesServer() {
  const server = new McpServer({ name: "notes", version: "1.0.0" });

  server.registerTool(
    "read_notes",
    {
      description: "Read the notes on a topic.",
      inputSchema: { topic: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    (input) => ({
      content: [{ type: "text", text: `notes about ${input?.topic ?? "everything"}` }],
    }),
  );

  server.registerTool(
    "send_email",
    {
      description: "Send an email to somebody outside the office.",
      inputSchema: { to: z.string(), body: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (input) => ({ content: [{ type: "text", text: `sent to ${input.to}` }] }),
  );

  server.registerTool(
    "drop_table",
    {
      description: "Delete everything, which nobody should grant.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    () => ({ content: [{ type: "text", text: "refused" }], isError: true }),
  );

  return server;
}

/**
 * A headless office meeting a tool that acts.
 *
 * End to end and deliberately so: a real child process speaking MCP over its
 * stdin, the real broker, the real run loop, the real gate, the real workflow
 * engine. The only fake is the model, which is the one thing a test may not
 * call. Everything that could quietly not be wired together is wired together
 * here — this is the test that would have caught a gate nobody called.
 *
 * The server is written to a temp file rather than imported: `vo run` spawns a
 * command named in an office file, and the point is that this is what it does.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlmProvider, toolCall, type CompletionRequest } from "@vo/llm";
import { createTask, importOfficeYaml, unwrap, type Task, type TaskId } from "@vo/core";
import { runOffice, type GateDecision } from "./office-run.js";

/**
 * An MCP server in twenty lines: one tool that sends something, one that only
 * reads. Hand-written JSON-RPC, because a fixture that needed a dependency
 * would not be a fixture a deployed office could run.
 */
const SERVER = `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at = buffer.indexOf("\\n");
  while (at >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    at = buffer.indexOf("\\n");
    if (line.trim().length === 0) continue;
    const message = JSON.parse(line);
    const answer = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    if (message.method === "initialize") {
      answer({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "post-room", version: "1.0.0" },
      });
    } else if (message.method === "tools/list") {
      answer({
        tools: [
          {
            name: "send_email",
            description: "Send an email outside the office.",
            inputSchema: { type: "object", properties: { to: { type: "string" } } },
          },
          {
            name: "read_log",
            description: "Read the post room log.",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
        ],
      });
    } else if (message.method === "tools/call") {
      const name = message.params.name;
      answer({
        content: [
          {
            type: "text",
            text: name === "send_email" ? "sent to " + message.params.arguments.to : "log is empty",
          },
        ],
      });
    } else if (message.id !== undefined) {
      answer({});
    }
  }
});
`;

const deps = { id: () => "generated", now: () => new Date("2026-10-03T09:00:00.000Z") };

const officeYaml = (command: string, script: string) => `
version: 1
office:
  id: office-acme
  name: Acme
departments:
  - id: dept-post
    name: Post room
    color: "#3366ff"
    position: { x: 0, y: 0 }
    reviewPolicy: { kind: direct }
    tools:
      - { connector: conn-post, tool: "*" }
employees:
  - id: emp-ada
    department: dept-post
    name: Ada
    role: Clerk
    color: "#00aa66"
    llm: { provider: anthropic, model: claude-sonnet-5 }
connectors:
  - id: conn-post
    kind: mcp
    name: post
    tools: [send_email, read_log]
    config:
      command: ${command}
      args: [${script}]
`;

let dir: string | null = null;

async function office() {
  dir ??= await mkdtemp(join(tmpdir(), "vo-mcp-"));
  const script = join(dir, "post-room.mjs");
  await writeFile(script, SERVER, "utf8");
  return unwrap(importOfficeYaml(officeYaml(process.execPath, script), deps));
}

function brief(config: Awaited<ReturnType<typeof office>>): Task {
  return unwrap(
    createTask(
      {
        officeId: config.office.id,
        departmentId: "dept-post" as never,
        title: "Tell the customer their order shipped",
        assigneeId: "emp-ada" as never,
      },
      { id: () => "task-1" as TaskId, now: () => new Date("2026-10-03T09:00:00.000Z") },
    ),
  );
}

/** Finds the tool it is told about, calls it once, then submits. */
const clerk = (tool: string) => {
  let found = false;
  let used = false;
  return new FakeLlmProvider({
    id: "anthropic",
    handler: (request: CompletionRequest) => {
      const names = (request.tools ?? []).map((one) => one.name);
      if (!found && names.includes("find_tool")) {
        found = true;
        return toolCall("find_tool", { query: tool });
      }
      if (!used && names.includes(`post__${tool}`)) {
        used = true;
        return toolCall(`post__${tool}`, { to: "customer@acme.test" });
      }
      return toolCall("submit_work", { summary: "done what I could" });
    },
  });
};

describe("a headless office asked to do something that leaves the building", () => {
  it("stops before it sends, and says what it is waiting for", async () => {
    const config = await office();

    const result = await runOffice({
      config,
      tasks: [brief(config)],
      provider: clerk("send_email"),
    });

    const task = result.tasks[0];
    expect(task?.status).toBe("blocked");
    // The reason is what the gate said, which is what a person needs to read.
    expect(task?.history.at(-1)?.reason).toContain("send_email");
    expect(task?.history.at(-1)?.reason).toContain("external_send");
    // Nobody is at the desk, so the run ends rather than spinning.
    expect(result.done).toBe(0);
  });

  it("puts it in the owner's inbox, the same effect a review gate raises", async () => {
    const config = await office();

    const result = await runOffice({
      config,
      tasks: [brief(config)],
      provider: clerk("send_email"),
    });

    expect(result.effects.filter((effect) => effect.type === "request_approval")).toHaveLength(1);
  });

  it("sends it once a person says yes, and finishes the work", async () => {
    const config = await office();
    const approve = (): GateDecision => ({ decision: "approved", decidedBy: "owner-1" });
    const provider = clerk("send_email");

    const result = await runOffice({
      config,
      tasks: [brief(config)],
      provider,
      decide: approve,
    });

    const task = result.tasks[0];
    expect(task?.status).toBe("done");
    expect(task?.history.map((one) => one.to)).toContain("blocked");
    // The call actually happened, and the model was told what came back: this
    // is the sentence the server wrote, which only a real send produces.
    expect(JSON.stringify(provider.calls.at(-1)?.messages ?? [])).toContain(
      "sent to customer@acme.test",
    );
  });

  it("tells the model when the person says no, and the work still finishes", async () => {
    const config = await office();
    const refuse = (): GateDecision => ({
      decision: "rejected",
      decidedBy: "owner-1",
      reason: "not to that address",
    });

    const result = await runOffice({
      config,
      tasks: [brief(config)],
      provider: clerk("send_email"),
      decide: refuse,
    });

    const task = result.tasks[0];
    expect(task?.status).toBe("done");
    expect(JSON.stringify(task?.history)).toContain("not to that address");
  });

  it("does not stop for a tool the office said was harmless", async () => {
    // The same server, the same run, one line of configuration different.
    const config = await office();
    const quiet = {
      ...config,
      connectors: config.connectors.map((connector) => ({
        ...connector,
        config: { ...connector.config, gates: { read_log: [] } },
      })),
    };

    const result = await runOffice({
      config: quiet,
      tasks: [brief(quiet)],
      provider: clerk("read_log"),
    });

    expect(result.tasks[0]?.status).toBe("done");
    expect(result.tasks[0]?.history.map((one) => one.to)).not.toContain("blocked");
  });
});

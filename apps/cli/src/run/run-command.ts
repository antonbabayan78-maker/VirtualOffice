/**
 * `vo run office.yaml --task "..."` — the office running headless.
 *
 * Reads an office file, gives the brief to an employee of the department that
 * owns it, and runs until the office goes quiet. Everything it needs from the
 * outside — reading files, writing output, the model provider — is injected, so
 * the command is testable without touching a disk or a network.
 */
import {
  createTask,
  importOfficeYaml,
  isErr,
  type OfficeConfig,
  type Task,
  type TaskId,
} from "@vo/core";
import type { LlmProvider } from "@vo/llm";
import { runOffice, type OfficeRunResult } from "./office-run.js";

export interface RunCommandDeps {
  readFile(path: string): Promise<string>;
  write(line: string): void;
  readonly provider: LlmProvider;
  readonly now?: () => Date;
}

export const USAGE =
  'usage: vo run <office.yaml> --task "what to do" [--department <id>] [--max-ticks <n>]';

interface Args {
  readonly file: string;
  readonly task: string;
  readonly department?: string;
  readonly maxTicks?: number;
}

function parseArgs(argv: readonly string[]): Args | string {
  let file: string | undefined;
  let task: string | undefined;
  let department: string | undefined;
  let maxTicks: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--task") task = argv[++i];
    else if (arg === "--department") department = argv[++i];
    else if (arg === "--max-ticks") maxTicks = Number(argv[++i]);
    else if (arg === "--dry-run") continue;
    else if (!arg.startsWith("-")) file ??= arg;
    else return `unknown option "${arg}"\n${USAGE}`;
  }

  if (file === undefined) return USAGE;
  if (task === undefined || task.trim().length === 0)
    return `a brief is required: --task "..."\n${USAGE}`;
  return {
    file,
    task,
    ...(department === undefined ? {} : { department }),
    ...(maxTicks === undefined || Number.isNaN(maxTicks) ? {} : { maxTicks }),
  };
}

function money(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function report(
  config: OfficeConfig,
  result: OfficeRunResult,
  write: (line: string) => void,
): void {
  const names = new Map(config.employees.map((e) => [e.id as string, e.name]));
  write("");
  for (const task of result.tasks) {
    write(`  ${task.title} — ${task.status}`);
    for (const event of task.history) {
      const who = event.actorId === null ? "system" : (names.get(event.actorId) ?? event.actorId);
      const reason = event.reason === null ? "" : ` (${event.reason})`;
      write(`    ${event.to.padEnd(18)} ${who}${reason}`);
    }
  }

  const perEmployee = new Map<string, { calls: number; usd: number; tokens: number }>();
  for (const event of result.usage) {
    const id = event.attribution.employeeId ?? "unattributed";
    const entry = perEmployee.get(id) ?? { calls: 0, usd: 0, tokens: 0 };
    entry.calls += 1;
    if (event.kind === "llm_call") {
      entry.usd += event.cost?.totalUsd ?? 0;
      entry.tokens += event.usage.inputTokens + event.usage.outputTokens;
    }
    perEmployee.set(id, entry);
  }

  write("");
  write("  usage");
  let total = 0;
  for (const [id, entry] of [...perEmployee].sort(([a], [b]) => (a < b ? -1 : 1))) {
    total += entry.usd;
    write(
      `    ${(names.get(id) ?? id).padEnd(10)} ${String(entry.calls).padStart(2)} calls  ` +
        `${String(entry.tokens).padStart(6)} tokens  ${money(entry.usd)}  [${id}]`,
    );
  }
  write(`    ${"total".padEnd(10)} ${money(total)} over ${String(result.ticks)} ticks`);
}

export async function runCommand(argv: readonly string[], deps: RunCommandDeps): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    deps.write(args);
    return 2;
  }

  let source: string;
  try {
    source = await deps.readFile(args.file);
  } catch (error) {
    deps.write(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const now = deps.now ?? (() => new Date());
  const imported = importOfficeYaml(source, { id: () => randomId(), now });
  if (isErr(imported)) {
    // Every problem at once, each with where it is, rather than the first only.
    for (const problem of imported.error) {
      const where = problem.line === undefined ? "" : ` (line ${String(problem.line)})`;
      deps.write(`${args.file}: ${problem.path}: ${problem.message}${where}`);
    }
    return 1;
  }
  const config = imported.value;

  const department =
    args.department === undefined
      ? config.departments[0]
      : config.departments.find((d) => d.id === args.department);
  if (department === undefined) {
    deps.write(`no such department: ${args.department ?? "(none in file)"}`);
    return 1;
  }

  // Whoever is at work in that department, with a manager preferred as reviewer
  // rather than as the author, so a two-person office does the obvious thing.
  const inDepartment = config.employees.filter(
    (e) => e.departmentId === department.id && e.status === "active",
  );
  const assignee = inDepartment.find((e) => e.supervisorId !== null) ?? inDepartment[0];
  if (assignee === undefined) {
    deps.write(`no active employee in ${department.name} to do the work`);
    return 1;
  }

  const brief: Task = unwrapTask(
    createTask(
      {
        officeId: config.office.id,
        departmentId: department.id,
        title: args.task,
        assigneeId: assignee.id,
      },
      { id: () => randomId() as TaskId, now },
    ),
  );

  deps.write(`${config.office.name}: ${department.name} — ${assignee.name} takes "${args.task}"`);

  const result = await runOffice({
    config,
    tasks: [brief],
    provider: deps.provider,
    now,
    ...(args.maxTicks === undefined ? {} : { maxTicks: args.maxTicks }),
  });

  // Before the report, because it changes how the report should be read: a
  // service that could not be built means somebody's work ran on another model.
  for (const problem of result.serviceProblems) deps.write(`! ${problem}`);

  report(config, result, (line) => {
    deps.write(line);
  });
  return result.done === result.tasks.length ? 0 : 1;
}

function randomId(): string {
  return `id-${Math.random().toString(36).slice(2, 10)}`;
}

function unwrapTask(result: ReturnType<typeof createTask>): Task {
  if (isErr(result)) throw new Error(result.error.map((e) => `${e.path}: ${e.message}`).join("; "));
  return result.value;
}

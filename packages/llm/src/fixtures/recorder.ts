/**
 * Fixture recorder/replayer. Wraps any provider: in record mode it calls the
 * inner provider and stores the response under a content hash of the request;
 * in replay mode it serves stored responses and never touches the network. CI
 * runs in replay mode, so a missing fixture fails loudly instead of calling a
 * real model.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  streamFromResponse,
  type CompletionRequest,
  type CompletionResponse,
  type LlmProvider,
  type StreamEvent,
} from "../provider/types.js";

export type FixtureMode = "record" | "replay" | "auto";

export interface Fixture {
  readonly key: string;
  readonly request: CompletionRequest;
  readonly response: CompletionResponse;
  readonly recordedAt: string;
}

export interface FixtureStore {
  get(key: string): Promise<Fixture | null>;
  put(fixture: Fixture): Promise<void>;
}

/** Canonical JSON: sorted keys, no metadata, so equal requests hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fixtureKey(request: CompletionRequest): string {
  const { metadata: _metadata, ...rest } = request;
  return createHash("sha1").update(canonical(rest)).digest("hex");
}

export function resolveFixtureMode(env: NodeJS.ProcessEnv = process.env): FixtureMode {
  const explicit = env["VO_LLM_FIXTURES"];
  if (explicit !== undefined && explicit.length > 0) {
    if (explicit === "record" || explicit === "replay" || explicit === "auto") return explicit;
    throw new Error(`VO_LLM_FIXTURES must be "record", "replay" or "auto" (got "${explicit}")`);
  }
  return env["CI"] !== undefined && env["CI"] !== "" && env["CI"] !== "false" ? "replay" : "auto";
}

export class MissingFixtureError extends Error {
  constructor(
    readonly key: string,
    request: CompletionRequest,
  ) {
    super(
      `no recorded LLM fixture ${key} for model "${request.model}" (${String(request.messages.length)} message(s)). ` +
        "Tests never call a real model in replay mode. Re-run locally with VO_LLM_FIXTURES=record to record it, then commit the fixture.",
    );
    this.name = "MissingFixtureError";
  }
}

export class InMemoryFixtureStore implements FixtureStore {
  private readonly fixtures = new Map<string, Fixture>();

  get(key: string): Promise<Fixture | null> {
    const f = this.fixtures.get(key);
    return Promise.resolve(f ? structuredClone(f) : null);
  }

  put(fixture: Fixture): Promise<void> {
    this.fixtures.set(fixture.key, structuredClone(fixture));
    return Promise.resolve();
  }
}

export class FileFixtureStore implements FixtureStore {
  constructor(private readonly directory: string) {}

  private path(key: string): string {
    return join(this.directory, `${key}.json`);
  }

  get(key: string): Promise<Fixture | null> {
    let text: string;
    try {
      text = readFileSync(this.path(key), "utf8");
    } catch {
      return Promise.resolve(null);
    }
    try {
      return Promise.resolve(JSON.parse(text) as Fixture);
    } catch {
      return Promise.reject(new Error(`corrupt fixture ${this.path(key)}: not valid JSON`));
    }
  }

  put(fixture: Fixture): Promise<void> {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.path(fixture.key), `${JSON.stringify(fixture, null, 2)}\n`);
    return Promise.resolve();
  }
}

export interface RecordingProviderOptions {
  readonly mode?: FixtureMode;
  readonly streamChunkSize?: number;
  readonly now?: () => Date;
}

export class RecordingProvider implements LlmProvider {
  readonly id: string;
  readonly mode: FixtureMode;
  readonly stats = { hits: 0, misses: 0 };
  private readonly chunkSize: number;
  private readonly now: () => Date;

  constructor(
    private readonly inner: LlmProvider,
    private readonly store: FixtureStore,
    options: RecordingProviderOptions = {},
  ) {
    this.mode = options.mode ?? resolveFixtureMode();
    this.id = `${inner.id}+fixtures(${this.mode})`;
    this.chunkSize = options.streamChunkSize ?? 16;
    this.now = options.now ?? (() => new Date());
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const key = fixtureKey(request);
    if (this.mode !== "record") {
      const existing = await this.store.get(key);
      if (existing) {
        this.stats.hits += 1;
        return existing.response;
      }
      if (this.mode === "replay") throw new MissingFixtureError(key, request);
    }
    this.stats.misses += 1;
    const response = await this.inner.complete(request);
    await this.store.put({ key, request, response, recordedAt: this.now().toISOString() });
    return response;
  }

  async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
    const response = await this.complete(request);
    yield* streamFromResponse(response, this.chunkSize);
  }
}

/**
 * Putting a server together from its configuration and starting it.
 *
 * Apart from `main` so that starting one is testable: a test can take a
 * configuration, get a real server on a real port, call it over HTTP and stop
 * it again, without a process, a signal handler or an environment.
 *
 * This is also the first place anything passes `notify`. Every piece below it —
 * the channels, the adapters, the crossing detection — was written and tested
 * while no process existed to hand them to each other, so a budget warning was
 * delivered precisely nowhere. That is what an entry point is for.
 *
 * It is where the connectors live too, for the same reason: this process can
 * ask a connector what it offers, and the code that spawns a command or posts
 * to a url is handed in here rather than imported by the routes — so no test
 * of the routes can reach outside the machine it runs on.
 */
import { BlobSecretRecordStore, envKeySource, officeBroker, Vault } from "@vo/connectors";
import type { OfficeId } from "@vo/core";
import { createAnthropicProvider, openAiCompatibleProvider, providersFor } from "@vo/llm";
import { studyPrompt } from "@vo/orchestrator";
import { openStorage, type Storage } from "@vo/storage";
import type { ServerConfig } from "./config.js";
import { buildServer } from "./server.js";
import { officeNotifier } from "./office-notifier.js";
import { tokenVerifier } from "./auth.js";

/**
 * What a study is asked of, when the office's own service does not name one.
 *
 * A study is one call over a handful of documents, so the cheaper model is the
 * right default; an office that wants another points a service at it.
 */
const STUDY_MODEL = "claude-sonnet-5";

export interface StartedServer {
  /** Where it is actually listening; the port may have been chosen for it. */
  readonly url: string;
  storageClosed(): boolean;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Told about anything dropped on purpose: a channel that could not be reached. */
  readonly onProblem?: (message: string) => void;
}

export async function startServer(
  config: ServerConfig,
  options: StartOptions = {},
): Promise<StartedServer> {
  // Opened before the server is built: a server listening on half an office
  // would answer requests it cannot serve, and the adapter's own error names
  // the scheme that is missing.
  const storage: Storage = await openStorage({
    relational: config.storage.relational.href,
    vector: config.storage.vector.href,
    events: config.storage.events.href,
    coordination: config.storage.coordination.href,
    blobs: config.storage.blobs.href,
  });

  let storageClosed = false;

  /**
   * The office's vault, where a pasted key is kept.
   *
   * Opened lazily and once: a deployment that never pastes a key never writes
   * a vault file, and one that does pays for opening it on the first key
   * rather than on every start. The key itself comes from the environment —
   * `envKeySource` reads it — and the encrypted records live beside the blobs,
   * never in the records database.
   *
   * Without `VO_VAULT_KEY` there is no keeper at all, and the office refuses to
   * keep a pasted key instead of storing one it cannot protect.
   */
  const keeper = (() => {
    if (config.vaultKey === null) return undefined;
    let opening: Promise<Vault> | null = null;
    const vault = (): Promise<Vault> => {
      opening ??= Vault.open(
        new BlobSecretRecordStore(storage.blobs),
        // From the configuration rather than straight out of the process, so
        // the key travels the same path as everything else this is told.
        envKeySource("VO_VAULT_KEY", { VO_VAULT_KEY: config.vaultKey ?? undefined }),
      );
      return opening;
    };
    return {
      put: async (name: string, value: string) => (await vault()).put(name, value),
      update: async (ref: string, value: string) => (await vault()).update(ref, value),
      get: async (ref: string) => {
        try {
          return await (await vault()).get(ref);
        } catch {
          // A reference the office no longer holds is an answer, not a crash:
          // somebody may have rotated the vault or removed the secret by hand.
          return null;
        }
      },
      delete: async (ref: string) => (await vault()).delete(ref),
    };
  })();

  const app = buildServer({
    store: storage.relational,
    blobs: storage.blobs,
    verifyToken: tokenVerifier({ [config.token]: { ownerId: config.ownerId } }),
    notify: officeNotifier(storage.relational, undefined, options.onProblem),
    // Asked of the connector itself, with the same broker the worker performs
    // calls through — so what the office writes down is what a run can use.
    // For a command, this spawns it; the owner configured it, this route is
    // authenticated, and the alternative is tool names typed by hand.
    discoverTools: async (connector) => {
      // A broker is deliberately forgiving about a connector it cannot reach,
      // because one dead server must not empty a catalogue mid-run. Here the
      // opposite is wanted: somebody pressed a button and the reason is the
      // answer, so the problem is caught and raised.
      const problems: string[] = [];
      const broker = officeBroker([connector], {
        onProblem: (message) => problems.push(message),
      });
      const described = await broker.describe();
      const first = problems[0];
      if (described.length === 0 && first !== undefined) throw new Error(first);
      return described.map((tool) => tool.name);
    },
    ...(keeper === undefined ? {} : { secrets: keeper }),
    /**
     * Asked of the service itself, with the same adapter a turn calls it
     * through — so what the office writes down is what a run can use.
     *
     * The key is resolved by the route and handed over here: a service will not
     * list its models without one, and a local server will not want one at all.
     */
    discoverModels: async (service, apiKey) => {
      if (service.baseUrl === null) {
        throw new Error(`${service.name} has no address to ask`);
      }
      return openAiCompatibleProvider({
        id: service.name,
        baseUrl: service.baseUrl,
        ...(apiKey === null ? {} : { apiKey }),
        // Somebody is holding a button down, not a run waiting on a model.
        timeoutMs: 15_000,
      }).models();
    },
    /**
     * Reading somebody's writing once and answering with a style card.
     *
     * On the office's own services where it has them, so an office pointed at a
     * model in its own network studies on that model and the writing never
     * leaves the building; otherwise on `ANTHROPIC_API_KEY`, which is what most
     * deployments run on. With neither there is nothing to ask, and the route
     * says so rather than inventing a card.
     *
     * The words are the orchestrator's, beside every other prompt this office
     * sends. This is only the provider and the wire.
     */
    studyVoice: async ({ officeId, person, samples, corrections, llm }) => {
      const { system, message } = studyPrompt(person, samples, corrections);
      const services = await storage.relational.services.list({
        where: { officeId: officeId as OfficeId },
      });
      const providers = await providersFor(services.items, {
        env: process.env,
        ...(keeper === undefined
          ? {}
          : {
              secret: async (ref) => {
                try {
                  return await keeper.get(ref);
                } catch {
                  return null;
                }
              },
            }),
      });
      // The employee's own service, so a study runs where their work runs — an
      // office pointed at a model in its own network studies on that model and
      // the writing never leaves the building.
      const named = providers.get(llm.provider) ?? null;
      const key = process.env["ANTHROPIC_API_KEY"];
      const provider =
        named ?? (key === undefined ? null : createAnthropicProvider({ apiKey: key }));
      if (provider === null) {
        throw new Error(
          "this office has no model to study with: add a service, or set ANTHROPIC_API_KEY",
        );
      }

      const answer = await provider.complete({
        // Their own model where it is their own service; the fallback knows
        // nothing of a model named for somebody else's.
        model: named === null ? STUDY_MODEL : llm.model,
        system,
        messages: [{ role: "user", content: [{ type: "text", text: message }] }],
        maxOutputTokens: 1_500,
      });
      return answer.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    },
    allowedOrigins: config.allowedOrigins,
    // Served from the office's own origin when a deployment has one, which is
    // what lets the browser hold no credential at all.
    ...(config.webRoot === null ? {} : { webRoot: config.webRoot }),
    // Cut connections off rather than waiting for them to go idle: a refused
    // upgrade leaves a keep-alive socket nobody will use again.
    forceCloseConnections: true,
    logger: false,
  });

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    await storage.close();
    throw error;
  }

  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;

  return {
    url: `http://${config.host}:${String(port)}`,
    storageClosed: () => storageClosed,
    close: async () => {
      // Sockets first, then the store: a request in flight that outlived its
      // storage would fail in a way nobody could read.
      await app.close();
      await storage.close();
      storageClosed = true;
    },
  };
}

/**
 * An AI service this office can reach.
 *
 * An employee's `llm` already names a provider and a model; until now the
 * provider was decoration, because the process that made the call was built
 * with one adapter and one key out of its environment. A service is the office
 * saying which providers exist — including one running on somebody's own
 * machine, which is the case the whole shape has to serve.
 *
 * **Most of the world is one kind.** OpenAI, Grok, DeepSeek, Qwen, Mistral,
 * Together, OpenRouter and Groq speak the same chat-completions shape, and so
 * do Ollama, vLLM, llama.cpp and LM Studio. They differ by address, not by
 * protocol, which is why `openai-compatible` plus a `baseUrl` is the whole list.
 *
 * **A key is never here.** The service names a variable that holds one, or
 * refers to one the office is keeping in its vault. A row in a database that
 * holds somebody's API key is a row in every backup of that database.
 */
import type { OfficeId } from "../office/office.js";
import { err, ok, type Result, type ValidationError } from "../shared/result.js";

declare const llmServiceIdBrand: unique symbol;
export type LlmServiceId = string & { readonly [llmServiceIdBrand]: true };

export const LLM_SERVICE_KINDS = ["openai-compatible", "anthropic"] as const;
export type LlmServiceKind = (typeof LLM_SERVICE_KINDS)[number];

/** What a model costs, in USD per million tokens, as the owner was billed for it. */
export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  /** What a cached read costs, where the service has such a thing. */
  readonly cacheReadPerMTok?: number;
}

export interface ModelOffer {
  /** What the service calls it, which is what goes on the wire. */
  readonly id: string;
  readonly displayName?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  /**
   * Absent means nobody has priced it. A call on an unpriced model is reported
   * as not priced rather than counted as free, which is the honest half of
   * letting somebody add any model they like.
   */
  readonly pricing?: ModelPrice;
}

export interface LlmService {
  readonly id: LlmServiceId;
  readonly officeId: OfficeId;
  readonly kind: LlmServiceKind;
  /** Unique per office, kebab-case; this is what an employee's `llm.provider` names. */
  readonly name: string;
  /** Where it is. Null for the office's own built-in provider. */
  readonly baseUrl: string | null;
  /** The variable that holds its key, by name; the value is never here. */
  readonly tokenEnv: string | null;
  /** A key the office is keeping, by reference; the key itself is never here. */
  readonly secretRef: string | null;
  readonly models: readonly ModelOffer[];
  readonly enabled: boolean;
  readonly createdAt: Date;
}

export interface CreateLlmServiceInput {
  readonly officeId: OfficeId;
  readonly kind: LlmServiceKind;
  readonly name: string;
  readonly baseUrl?: string;
  readonly tokenEnv?: string;
  readonly secretRef?: string;
  readonly models?: readonly ModelOffer[];
  readonly enabled?: boolean;
}

export interface UpdateLlmServiceInput {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly models?: readonly ModelOffer[];
  readonly enabled?: boolean;
  /** Null gives a named variable back; a name takes the place of a kept key. */
  readonly tokenEnv?: string | null;
  /** Null gives a kept key back; a reference takes the place of a named variable. */
  readonly secretRef?: string | null;
}

export interface LlmServiceDeps {
  readonly id: () => LlmServiceId;
  readonly now: () => Date;
}

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_REF = /^vault:\/\/.+/;

/** Kinds that are somewhere else, and so need an address to be reached at. */
const NEEDS_ADDRESS: readonly LlmServiceKind[] = ["openai-compatible"];

function isKind(value: unknown): value is LlmServiceKind {
  return typeof value === "string" && (LLM_SERVICE_KINDS as readonly string[]).includes(value);
}

/**
 * Whether plain http to this host stays inside the building.
 *
 * A model on somebody's own machine, or on a box in the company network, is the
 * case this whole feature exists for, and insisting on a certificate for
 * `10.0.0.12` would be insisting nobody runs their own. Anywhere else, a key
 * sent in the open is a key in somebody's proxy log.
 */
export function isLocalAddress(host: string): boolean {
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return true;
  if (/\.(local|internal|localhost|test|home|lan)$/i.test(host)) return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (octets === null) return false;
  const [first, second] = [Number(octets[1]), Number(octets[2])];
  // The private ranges: a company network, as RFC 1918 defines one.
  if (first === 10) return true;
  if (first === 192 && second === 168) return true;
  return first === 172 && second >= 16 && second <= 31;
}

function validateAddress(kind: LlmServiceKind, baseUrl: string | null): ValidationError[] {
  if (baseUrl === null) {
    return NEEDS_ADDRESS.includes(kind)
      ? [{ path: "baseUrl", message: "a service reached over the wire needs an address" }]
      : [];
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return [{ path: "baseUrl", message: `"${baseUrl}" is not an address` }];
  }
  if (parsed.protocol === "https:") return [];
  if (parsed.protocol === "http:" && isLocalAddress(parsed.hostname)) return [];
  return [
    {
      path: "baseUrl",
      message:
        "must be https, unless it is a server on this machine or in your own network, where" +
        " plain http stays inside the building",
    },
  ];
}

function validatePrice(price: ModelPrice | undefined, path: string): ValidationError[] {
  if (price === undefined) return [];
  const errors: ValidationError[] = [];
  const amounts: readonly (readonly [string, unknown])[] = [
    ["inputPerMTok", price.inputPerMTok],
    ["outputPerMTok", price.outputPerMTok],
    ...(price.cacheReadPerMTok === undefined
      ? []
      : [["cacheReadPerMTok", price.cacheReadPerMTok] as const]),
  ];
  for (const [field, amount] of amounts) {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      errors.push({ path: `${path}.${field}`, message: "must be an amount per million tokens" });
    }
  }
  // Half a price prices nothing: a total built from one would be a figure
  // nobody could trust, and quietly too low.
  if (typeof price.inputPerMTok !== "number" || typeof price.outputPerMTok !== "number") {
    errors.push({ path, message: "needs both what goes in and what comes out" });
  }
  return errors;
}

function validateModels(models: readonly ModelOffer[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Set<string>();
  models.forEach((model, index) => {
    const path = `models[${String(index)}]`;
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (id.length === 0) {
      errors.push({ path: `${path}.id`, message: "must be what the service calls the model" });
    } else if (seen.has(id)) {
      errors.push({ path: `${path}.id`, message: `duplicate model "${id}"` });
    }
    seen.add(id);

    for (const [field, value] of [
      ["contextWindow", model.contextWindow],
      ["maxOutputTokens", model.maxOutputTokens],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        errors.push({ path: `${path}.${field}`, message: "must be a positive number of tokens" });
      }
    }
    errors.push(...validatePrice(model.pricing, `${path}.pricing`));
  });
  return errors;
}

/** One way to be paid for or the other, and never both at once. */
function validateCredential(tokenEnv: string | null, secretRef: string | null): ValidationError[] {
  const errors: ValidationError[] = [];
  if (tokenEnv !== null && !ENV_NAME.test(tokenEnv)) {
    errors.push({ path: "tokenEnv", message: "must be the name of an environment variable" });
  }
  if (secretRef !== null && !SECRET_REF.test(secretRef)) {
    // Said sharply because the mistake it catches is pasting the key itself.
    errors.push({
      path: "secretRef",
      message: 'must be a reference the office gave you, such as "vault://…", not the key itself',
    });
  }
  if (tokenEnv !== null && secretRef !== null) {
    errors.push({
      path: "tokenEnv",
      message: "name a variable or keep a key, not both: nothing says which would be used",
    });
  }
  return errors;
}

function validateName(
  name: string,
  existing: readonly { readonly name: string }[],
): ValidationError[] {
  if (!NAME.test(name)) {
    return [{ path: "name", message: "must be a kebab-case identifier of 1-64 characters" }];
  }
  return existing.some((other) => other.name.toLowerCase() === name.toLowerCase())
    ? [{ path: "name", message: `a service named "${name}" already exists in this office` }]
    : [];
}

/** Keeps only what belongs on a model offer, so nothing unasked-for is stored. */
function keptModel(model: ModelOffer): ModelOffer {
  return {
    id: model.id.trim(),
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
    ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
  };
}

export function createLlmService(
  input: CreateLlmServiceInput,
  existing: readonly { readonly name: string }[],
  deps: LlmServiceDeps,
): Result<LlmService> {
  const errors: ValidationError[] = [];

  if (!isKind(input.kind)) {
    errors.push({ path: "kind", message: `must be one of ${LLM_SERVICE_KINDS.join(", ")}` });
  }

  const name = input.name.trim();
  errors.push(...validateName(name, existing));

  const baseUrl = input.baseUrl === undefined ? null : input.baseUrl.trim();
  if (isKind(input.kind)) errors.push(...validateAddress(input.kind, baseUrl));

  const tokenEnv = input.tokenEnv ?? null;
  const secretRef = input.secretRef ?? null;
  errors.push(...validateCredential(tokenEnv, secretRef));

  const models = input.models ?? [];
  errors.push(...validateModels(models));

  if (errors.length > 0 || !isKind(input.kind)) return err(errors);
  return ok({
    id: deps.id(),
    officeId: input.officeId,
    kind: input.kind,
    name,
    baseUrl,
    tokenEnv,
    secretRef,
    models: models.map(keptModel),
    enabled: input.enabled ?? true,
    createdAt: deps.now(),
  });
}

/**
 * Changes a service, keeping it the same service.
 *
 * Switching one off is why this exists rather than deleting: employees name a
 * service, and an afternoon's outage should not cost every one of those
 * settings. `existing` is the office's other services, for the name check.
 */
export function updateLlmService(
  service: LlmService,
  changes: UpdateLlmServiceInput,
  existing: readonly { readonly name: string }[],
): Result<LlmService> {
  const errors: ValidationError[] = [];

  const name = (changes.name ?? service.name).trim();
  errors.push(
    ...validateName(
      name,
      existing.filter((other) => other.name !== service.name),
    ),
  );

  const baseUrl = changes.baseUrl === undefined ? service.baseUrl : changes.baseUrl.trim();
  errors.push(...validateAddress(service.kind, baseUrl));

  // One credential takes the place of the other: an office that set both would
  // have nothing to say about which was used.
  const asked = {
    tokenEnv: changes.tokenEnv !== undefined,
    secretRef: changes.secretRef !== undefined,
  };
  const tokenEnv = asked.tokenEnv
    ? (changes.tokenEnv ?? null)
    : asked.secretRef && changes.secretRef !== null
      ? null
      : service.tokenEnv;
  const secretRef = asked.secretRef
    ? (changes.secretRef ?? null)
    : asked.tokenEnv && changes.tokenEnv !== null
      ? null
      : service.secretRef;
  errors.push(...validateCredential(tokenEnv, secretRef));

  const models = changes.models ?? service.models;
  errors.push(...validateModels(models));

  const enabled = changes.enabled ?? service.enabled;
  if (typeof enabled !== "boolean") {
    errors.push({ path: "enabled", message: "must be true or false" });
  }

  if (errors.length > 0 || typeof enabled !== "boolean") return err(errors);
  return ok({
    ...service,
    name,
    baseUrl,
    tokenEnv,
    secretRef,
    models: models.map(keptModel),
    enabled,
  });
}

/** What this service calls the model, or null when it does not offer it. */
export function offeredModel(service: LlmService, model: string): ModelOffer | null {
  return service.models.find((offer) => offer.id === model) ?? null;
}

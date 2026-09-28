/**
 * The model registry on its own.
 *
 * Exported as a subpath so a browser can list the models an office may use
 * without pulling in the provider adapters, which carry vendor SDKs meant for a
 * server. The canvas needs to know what models exist; it has no business
 * calling one.
 */
export * from "./model-registry.js";
export * from "./anthropic-models.js";

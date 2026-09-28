/**
 * @vo/api-client
 *
 * One way of talking to the office API, shared by the canvas and the worker.
 * A second client would drift: the two would disagree about what a 409 means,
 * or one would forget to turn a date back into a date.
 */
export const PACKAGE_NAME = "@vo/api-client" as const;

export * from "./client.js";

/**
 * The fixture server, declared as narrowly as the tests use it.
 *
 * Deliberately not typed as the SDK's `McpServer`: its transport interface
 * declares optional callbacks as required-or-undefined, which this repo's
 * `exactOptionalPropertyTypes` rejects at the call site. A test only ever
 * connects this server to a transport, so that is all this says.
 */
export function notesServer(): { connect(transport: unknown): Promise<void> };

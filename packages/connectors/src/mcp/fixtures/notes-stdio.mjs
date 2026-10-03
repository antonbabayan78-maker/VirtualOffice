/**
 * The fixture server as a process, which is what a stdio connector spawns.
 *
 * Its own file so `notes-server.mjs` stays a module a test can also mount over
 * HTTP, and so neither file has to ask whether it is the one being run.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { notesServer } from "./notes-server.mjs";

await notesServer().connect(new StdioServerTransport());

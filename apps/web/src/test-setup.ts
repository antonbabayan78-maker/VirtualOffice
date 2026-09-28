import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { installCanvasTestEnv } from "./canvas/canvas-test-env.js";

// Setup files run for every test file, including the few that ask for a node
// environment because what they test has no DOM in it. Guard rather than split
// the setup in two: one list of what a web test needs is easier to follow.
const hasDom = typeof globalThis.window !== "undefined";

if (hasDom) {
  // The canvas is on the app's first screen, so anything that renders the shell
  // needs the layout shims React Flow expects. jsdom has no layout of its own.
  installCanvasTestEnv();

  // This repo runs vitest without globals, so testing-library's own auto-cleanup
  // never registers itself. Without this, one test's DOM leaks into the next.
  afterEach(cleanup);
}

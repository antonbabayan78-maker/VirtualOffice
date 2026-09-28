import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { installCanvasTestEnv } from "./canvas/canvas-test-env.js";

// The canvas is on the app's first screen, so anything that renders the shell
// needs the layout shims React Flow expects. jsdom has no layout of its own.
installCanvasTestEnv();

// This repo runs vitest without globals, so testing-library's own auto-cleanup
// never registers itself. Without this, one test's DOM leaks into the next.
afterEach(cleanup);

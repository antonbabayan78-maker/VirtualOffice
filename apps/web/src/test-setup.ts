import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// This repo runs vitest without globals, so testing-library's own auto-cleanup
// never registers itself. Without this, one test's DOM leaks into the next.
afterEach(cleanup);

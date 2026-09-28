/**
 * The office the canvas opens with, until there is an API to load a real one.
 *
 * It is a genuine office file parsed by the genuine importer rather than a
 * hand-built object, so the canvas is exercised against the same shape a real
 * office has — and a mistake in the file fails a test rather than the page.
 */
import { importOfficeYaml, type OfficeConfig, type Result } from "@vo/core";
import yaml from "./sample-office.yaml?raw";

export function loadSampleOffice(): Result<OfficeConfig> {
  return importOfficeYaml(yaml, {
    id: () => `generated-${Math.random().toString(36).slice(2, 10)}`,
    now: () => new Date(),
  });
}

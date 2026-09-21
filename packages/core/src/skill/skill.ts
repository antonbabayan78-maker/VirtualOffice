/**
 * Skill: a versioned instruction package in SKILL.md form: YAML frontmatter
 * (name, version, description, tools, tags, examples, tests) followed by a
 * markdown body with the instructions. Only the index line (name + description)
 * goes into an employee's context; the body is loaded when the skill is invoked.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { err, ok, type Result, type ValidationError } from "../shared/result.js";
import { parseSemver } from "./semver.js";

declare const skillIdBrand: unique symbol;
export type SkillId = string & { readonly [skillIdBrand]: true };

export interface ToolRef {
  readonly connectorId: string;
  readonly tool: string;
}

export interface SkillExample {
  readonly prompt: string;
  readonly expectedOutcome: string;
}

export interface SkillTest {
  readonly name: string;
  readonly prompt: string;
  readonly expect: string;
}

export interface Skill {
  /** Equal to `name`; skills are addressed by name, versions by `version`. */
  readonly id: SkillId;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly requiredTools: readonly ToolRef[];
  readonly tags: readonly string[];
  readonly examples: readonly SkillExample[];
  readonly tests: readonly SkillTest[];
  /** Markdown instructions. */
  readonly body: string;
}

export interface ParseSkillContext {
  /** Tool ids as "connectorId.tool" that exist in the office. */
  readonly knownTools: ReadonlySet<string>;
}

export const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const SKILL_NAME_MIN_LENGTH = 2;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(
  fm: Record<string, unknown>,
  key: string,
  errors: ValidationError[],
): string | null {
  const v = fm[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    errors.push({ path: key, message: "is required and must be a non-empty string" });
    return null;
  }
  return v.trim();
}

function stringList(fm: Record<string, unknown>, key: string, errors: ValidationError[]): string[] {
  const v = fm[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push({ path: key, message: "must be a list" });
    return [];
  }
  const out: string[] = [];
  v.forEach((item: unknown, i) => {
    if (typeof item === "string" && item.length > 0) out.push(item);
    else errors.push({ path: `${key}[${String(i)}]`, message: "must be a non-empty string" });
  });
  return out;
}

function objectList<T>(
  fm: Record<string, unknown>,
  key: string,
  fields: readonly (keyof T & string)[],
  errors: ValidationError[],
): T[] {
  const v = fm[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push({ path: key, message: "must be a list" });
    return [];
  }
  const out: T[] = [];
  v.forEach((item: unknown, i) => {
    const path = `${key}[${String(i)}]`;
    if (!isRecord(item)) {
      errors.push({ path, message: `must be an object with ${fields.join(", ")}` });
      return;
    }
    const picked: Record<string, string> = {};
    let valid = true;
    for (const f of fields) {
      const value = item[f];
      if (typeof value !== "string" || value.length === 0) {
        errors.push({
          path: `${path}.${f}`,
          message: "is required and must be a non-empty string",
        });
        valid = false;
      } else {
        picked[f] = value;
      }
    }
    if (valid) out.push(picked as T);
  });
  return out;
}

function parseTools(
  fm: Record<string, unknown>,
  ctx: ParseSkillContext,
  errors: ValidationError[],
): ToolRef[] {
  const ids = stringList(fm, "tools", errors);
  const refs: ToolRef[] = [];
  ids.forEach((id, i) => {
    const dot = id.indexOf(".");
    if (dot <= 0 || dot === id.length - 1) {
      errors.push({ path: `tools[${String(i)}]`, message: `"${id}" must be "connectorId.tool"` });
      return;
    }
    if (!ctx.knownTools.has(id)) {
      errors.push({ path: `tools[${String(i)}]`, message: `unknown tool "${id}"` });
      return;
    }
    refs.push({ connectorId: id.slice(0, dot), tool: id.slice(dot + 1) });
  });
  return refs;
}

export function parseSkill(source: string, ctx: ParseSkillContext): Result<Skill> {
  const match = FRONTMATTER.exec(source);
  if (!match)
    return err([
      { path: "frontmatter", message: "skill file must start with a --- YAML frontmatter block" },
    ]);
  const [, rawFrontmatter = "", body = ""] = match;

  let fm: unknown;
  try {
    fm = parseYaml(rawFrontmatter);
  } catch (e) {
    return err([
      {
        path: "frontmatter",
        message: `invalid YAML: ${e instanceof Error ? e.message : String(e)}`,
      },
    ]);
  }
  if (!isRecord(fm)) return err([{ path: "frontmatter", message: "must be a YAML mapping" }]);

  const errors: ValidationError[] = [];
  const name = requireString(fm, "name", errors);
  const version = requireString(fm, "version", errors);
  const description = requireString(fm, "description", errors);

  if (name !== null && (name.length < SKILL_NAME_MIN_LENGTH || !SKILL_NAME.test(name))) {
    errors.push({ path: "name", message: "must be a kebab-case identifier of 2-64 characters" });
  }
  if (version !== null && parseSemver(version) === null) {
    errors.push({ path: "version", message: 'must be a semantic version like "1.2.0"' });
  }

  const requiredTools = parseTools(fm, ctx, errors);
  const tags = stringList(fm, "tags", errors);
  const examples = objectList<SkillExample>(fm, "examples", ["prompt", "expectedOutcome"], errors);
  const tests = objectList<SkillTest>(fm, "tests", ["name", "prompt", "expect"], errors);

  const trimmedBody = body.trim();
  if (trimmedBody.length === 0)
    errors.push({ path: "body", message: "instructions body must not be empty" });

  if (errors.length > 0 || name === null || version === null || description === null)
    return err(errors);

  return ok({
    id: name as SkillId,
    name,
    version,
    description,
    requiredTools,
    tags,
    examples,
    tests,
    body: trimmedBody,
  });
}

/** Writes a Skill back to SKILL.md form. `parseSkill(serializeSkill(s))` equals `s`. */
export function serializeSkill(skill: Skill): string {
  const fm: Record<string, unknown> = {
    name: skill.name,
    version: skill.version,
    description: skill.description,
  };
  if (skill.requiredTools.length > 0)
    fm["tools"] = skill.requiredTools.map((t) => `${t.connectorId}.${t.tool}`);
  if (skill.tags.length > 0) fm["tags"] = [...skill.tags];
  if (skill.examples.length > 0) fm["examples"] = skill.examples.map((e) => ({ ...e }));
  if (skill.tests.length > 0) fm["tests"] = skill.tests.map((t) => ({ ...t }));
  return `---\n${stringifyYaml(fm).trimEnd()}\n---\n${skill.body}\n`;
}

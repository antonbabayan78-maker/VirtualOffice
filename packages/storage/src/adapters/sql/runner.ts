/**
 * Migration runner for SQL adapters. Renders portable steps for the dialect,
 * executes them through a SqlExecutor, runs data steps against the repository
 * layer, and keeps the applied-ids bookkeeping in `_vo_migrations`.
 */
import { MIGRATIONS_TABLE } from "../../schema/canonical.js";
import { validateMigrations, type Migration, type MigrationStep } from "../../schema/types.js";
import type { RelationalCollections } from "../../relational/types.js";
import { renderStep, type Dialect } from "./dialect.js";

/** The minimal surface an adapter exposes to the runner. */
export interface SqlExecutor {
  exec(sql: string): Promise<void>;
  listApplied(): Promise<string[]>;
  markApplied(id: string, at: Date): Promise<void>;
  unmarkApplied(id: string): Promise<void>;
}

export interface MigrationRunnerOptions {
  readonly dialect: Dialect;
  readonly executor: SqlExecutor;
  readonly migrations: readonly Migration[];
  readonly now: () => Date;
  /** Required when any migration contains data steps. */
  readonly store?: RelationalCollections;
}

export interface MigrationStatus {
  readonly applied: string[];
  readonly pending: string[];
}

export class MigrationRunner {
  private readonly migrations: readonly Migration[];
  private readonly byId: ReadonlyMap<string, Migration>;

  constructor(private readonly options: MigrationRunnerOptions) {
    const errors = validateMigrations(options.migrations);
    if (errors.length > 0) {
      throw new Error(
        `invalid migrations: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
      );
    }
    this.migrations = options.migrations;
    this.byId = new Map(options.migrations.map((m) => [m.id, m]));
  }

  private migration(id: string): Migration {
    const found = this.byId.get(id);
    if (!found) throw new Error(`unknown migration "${id}"`);
    return found;
  }

  /** DDL that creates the bookkeeping table; adapters run it once on open. */
  bootstrapSql(): string[] {
    return renderStep(this.options.dialect, { op: "createTable", table: MIGRATIONS_TABLE });
  }

  async status(): Promise<MigrationStatus> {
    const applied = await this.options.executor.listApplied();
    const known = new Set(this.migrations.map((m) => m.id));
    const unknown = applied.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `database has applied migrations this build does not know: ${unknown.join(", ")}`,
      );
    }
    const appliedSet = new Set(applied);
    return {
      applied: this.migrations.filter((m) => appliedSet.has(m.id)).map((m) => m.id),
      pending: this.migrations.filter((m) => !appliedSet.has(m.id)).map((m) => m.id),
    };
  }

  async up(options: { readonly to?: string } = {}): Promise<{ applied: string[] }> {
    const { pending } = await this.status();
    const applied: string[] = [];
    for (const id of pending) {
      const migration = this.migration(id);
      await this.runSteps(migration.up, "up");
      await this.options.executor.markApplied(id, this.options.now());
      applied.push(id);
      if (options.to === id) break;
    }
    return { applied };
  }

  async down(options: { readonly steps?: number } = {}): Promise<{ reverted: string[] }> {
    const { applied } = await this.status();
    const toRevert = [...applied].reverse().slice(0, options.steps ?? applied.length);
    const reverted: string[] = [];
    for (const id of toRevert) {
      const migration = this.migration(id);
      await this.runSteps(migration.down, "down");
      await this.runSteps(
        [...migration.up].reverse().filter((s) => s.op === "data"),
        "revert",
      );
      await this.options.executor.unmarkApplied(id);
      reverted.push(id);
    }
    return { reverted };
  }

  private async runSteps(
    steps: readonly MigrationStep[],
    mode: "up" | "down" | "revert",
  ): Promise<void> {
    for (const step of steps) {
      if (step.op === "data") {
        const store = this.options.store;
        if (!store) throw new Error(`data migration "${step.name}" needs a relational store`);
        if (mode === "revert") await step.revert?.({ store });
        else await step.run({ store });
        continue;
      }
      for (const sql of renderStep(this.options.dialect, step))
        await this.options.executor.exec(sql);
    }
  }
}

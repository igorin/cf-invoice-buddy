import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { InvoiceBuddyAgent } from "../../src/agent";
import { MIGRATIONS, runMigrations } from "../../src/db/schema";

describe("app schema migrations (NFR-D6)", () => {
  it("applies every migration once and is safe to run again", async () => {
    const stub = await getAgentByName(env.InvoiceBuddyAgent, "schema-rerun");
    const applied = await runInDurableObject(
      stub,
      (agent: InvoiceBuddyAgent, state) => {
        runMigrations(state.storage.sql);
        runMigrations(state.storage.sql);
        return agent.sql<{
          id: number;
        }>`SELECT id FROM schema_migrations ORDER BY id`;
      }
    );
    expect(applied.map((row) => row.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it("keeps existing rows when a later migration is applied", async () => {
    const stub = await getAgentByName(env.InvoiceBuddyAgent, "schema-keep");
    const count = await runInDurableObject(
      stub,
      (agent: InvoiceBuddyAgent, state) => {
        agent.sql`
        INSERT INTO self_usage (at, model, steps, metered)
        VALUES (${new Date().toISOString()}, 'm', 1, 0)`;
        // Simulate an older deployment: forget the newest migration, then re-run.
        agent.sql`DELETE FROM schema_migrations WHERE id = ${MIGRATIONS.at(-1)?.id ?? 0}`;
        runMigrations(state.storage.sql);
        return agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM self_usage`;
      }
    );
    expect(count[0]?.n).toBe(1);
  });

  it("has only additive statements", () => {
    const statements = MIGRATIONS.flatMap((migration) => migration.statements);
    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(DROP|RENAME|DELETE)\b/i);
    }
  });
});

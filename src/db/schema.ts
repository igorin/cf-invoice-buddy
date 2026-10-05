/**
 * App schema for the agent's SQLite. Migrations are numbered, additive and
 * applied in order; an applied migration is never edited (NFR-D6).
 */

type SqlRunner = {
  exec(
    query: string,
    ...bindings: unknown[]
  ): Iterable<Record<string, unknown>>;
};

export const MIGRATIONS: ReadonlyArray<{
  id: number;
  statements: ReadonlyArray<string>;
}> = [
  {
    id: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS self_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        model TEXT NOT NULL,
        steps INTEGER NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        neurons REAL,
        cost_micros INTEGER,
        metered INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS self_usage_at ON self_usage (at)`,
      `CREATE TABLE IF NOT EXISTS self_activity_daily (
        day TEXT PRIMARY KEY,
        chat_turns INTEGER NOT NULL DEFAULT 0,
        refused_turns INTEGER NOT NULL DEFAULT 0
      )`
    ]
  }
];

/** Applies every migration not yet recorded. Safe to call on every start. */
export function runMigrations(sql: SqlRunner): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`
  );
  const applied = new Set(
    [...sql.exec("SELECT id FROM schema_migrations")].map((row) =>
      Number(row.id)
    )
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    for (const statement of migration.statements) sql.exec(statement);
    sql.exec(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
      migration.id,
      new Date().toISOString()
    );
  }
}

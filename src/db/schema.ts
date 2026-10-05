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
  },
  {
    // Append-only record of approvals, drafts and mode changes (NFR-S5).
    id: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        subject_id TEXT,
        dataset TEXT NOT NULL DEFAULT 'live',
        detail_json TEXT
      )`
    ]
  },
  {
    // Usage, per-product source status and billing status, per dataset.
    id: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS usage_records (
        dataset TEXT NOT NULL,
        date TEXT NOT NULL,
        service TEXT NOT NULL,
        metric TEXT NOT NULL,
        zone TEXT NOT NULL DEFAULT '',
        quantity REAL NOT NULL,
        unit TEXT NOT NULL,
        billable_quantity REAL,
        cost_micros INTEGER,
        PRIMARY KEY (dataset, date, service, metric, zone)
      )`,
      `CREATE TABLE IF NOT EXISTS usage_source_status (
        dataset TEXT NOT NULL,
        service TEXT NOT NULL,
        available INTEGER NOT NULL,
        reason TEXT,
        checked_at TEXT NOT NULL,
        PRIMARY KEY (dataset, service)
      )`,
      `CREATE TABLE IF NOT EXISTS account_billing (
        dataset TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        reason TEXT,
        plan TEXT NOT NULL,
        synced_at TEXT NOT NULL
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

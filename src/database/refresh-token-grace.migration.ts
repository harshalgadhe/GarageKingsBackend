import pg from 'pg';

const { Client } = pg;
const MIGRATION_NAME = '20260811_001_refresh_token_rotation_grace.sql';
const MIGRATION_LOCK_KEY = 746_251_911;

export async function applyRefreshTokenGraceMigration() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to apply the refresh-token migration.');
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true'
      ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : false,
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  });

  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1);', [MIGRATION_LOCK_KEY]);
    await client.query('BEGIN');
    try {
      await client.query(`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS refresh_token_previous_hash VARCHAR(64),
          ADD COLUMN IF NOT EXISTS refresh_token_rotated_at TIMESTAMPTZ;

        CREATE TABLE IF NOT EXISTS schema_migrations (
          name VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO schema_migrations (name)
        VALUES ('${MIGRATION_NAME}')
        ON CONFLICT (name) DO NOTHING;
      `);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    const verification = await client.query<{ column_count: string }>(`
      SELECT COUNT(*)::text AS column_count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name IN ('refresh_token_previous_hash', 'refresh_token_rotated_at');
    `);

    const columnCount = Number(verification.rows[0]?.column_count || 0);
    if (columnCount !== 2) {
      throw new Error(`Refresh-token migration verification failed: found ${columnCount} of 2 columns.`);
    }

    return { migration: MIGRATION_NAME, columnCount };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1);', [MIGRATION_LOCK_KEY]);
    } catch {
      // PostgreSQL releases session locks when the connection closes.
    }
    await client.end();
  }
}

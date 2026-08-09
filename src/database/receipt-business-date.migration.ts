import pg from 'pg';

const { Client } = pg;
const RECEIPT_MIGRATION_NAME = '20260809_004_receipt_business_date.sql';
const RECEIPT_MIGRATION_LOCK_KEY = 746_251_904;

export async function applyReceiptBusinessDateMigration() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to apply the receipt migration.');
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
    await client.query('SELECT pg_advisory_lock($1);', [RECEIPT_MIGRATION_LOCK_KEY]);
    await client.query('BEGIN');
    try {
      await client.query(`
        ALTER TABLE receipts
          ADD COLUMN IF NOT EXISTS receipt_date TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS date_string VARCHAR(150);

        UPDATE receipts
        SET receipt_date = created_at
        WHERE receipt_date IS NULL;

        ALTER TABLE receipts
          ALTER COLUMN receipt_date SET DEFAULT CURRENT_TIMESTAMP,
          ALTER COLUMN receipt_date SET NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_receipts_status_receipt_date
          ON receipts (status, receipt_date DESC);

        CREATE TABLE IF NOT EXISTS schema_migrations (
          name VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO schema_migrations (name)
        VALUES ('${RECEIPT_MIGRATION_NAME}')
        ON CONFLICT (name) DO NOTHING;
      `);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    const verification = await client.query<{
      receipt_count: string;
      missing_business_dates: string;
    }>(`
      SELECT COUNT(*)::text AS receipt_count,
             COUNT(*) FILTER (WHERE receipt_date IS NULL)::text AS missing_business_dates
      FROM receipts;
    `);

    return {
      migration: RECEIPT_MIGRATION_NAME,
      receiptCount: Number(verification.rows[0]?.receipt_count || 0),
      missingBusinessDates: Number(verification.rows[0]?.missing_business_dates || 0),
    };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1);', [RECEIPT_MIGRATION_LOCK_KEY]);
    } catch {
      // PostgreSQL releases session locks when the connection closes.
    }
    await client.end();
  }
}

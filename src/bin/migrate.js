import pkg from 'pg';
const { Client } = pkg;
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

// Load environment configurations
dotenv.config();

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');

async function runDatabaseMigration() {
  console.log("==================================================");
  console.log("GARAGEKINGS TRANSACTION-SAFE DATABASE MIGRATOR");
  console.log("==================================================");

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });

  await client.connect();
  console.log("✔ Connected to PostgreSQL database successfully.");

  // 1. Core Bootstrapper: Check/Create migration_runs table
  console.log("Bootstrapping migration metadata trackers...");
  const bootstrapQuery = `
    CREATE TABLE IF NOT EXISTS migration_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP WITH TIME ZONE,
      status VARCHAR(50) DEFAULT 'Started',
      records_processed INT DEFAULT 0,
      records_failed INT DEFAULT 0,
      report_s3_url VARCHAR(512),
      executed_by VARCHAR(100),
      error_summary TEXT
    );
  `;
  await client.query(bootstrapQuery);
  console.log("✔ Migration metadata tracking initialized.");

  // 2. Initialize Migration Run Logging Record
  const logInsert = `
    INSERT INTO migration_runs (status, executed_by)
    VALUES ('Started', 'Monolith Migrator v1')
    RETURNING id;
  `;
  const logRes = await client.query(logInsert);
  const runId = logRes.rows[0].id;

  // 3. Read DDL Schema SQL file
  if (!fs.existsSync(schemaPath)) {
    const errorMsg = `DDL Schema file not found at: ${schemaPath}`;
    console.error(`❌ ${errorMsg}`);
    await client.query(
      "UPDATE migration_runs SET status = 'Failed', error_summary = $1, completed_at = NOW() WHERE id = $2",
      [errorMsg, runId]
    );
    await client.end();
    process.exit(1);
  }

  const ddlSql = fs.readFileSync(schemaPath, 'utf8');
  console.log(`Successfully loaded schema DDL (Length: ${ddlSql.length} characters).`);

  // 4. Execute the Schema DDL inside a safe SQL Transaction
  console.log("Executing schema queries inside transaction block...");
  await client.query('BEGIN');

  try {
    // Execute DDL SQL commands
    await client.query(ddlSql);

    // Update logging metrics
    const updateLogQuery = `
      UPDATE migration_runs 
      SET status = 'Completed', completed_at = NOW() 
      WHERE id = $1;
    `;
    await client.query(updateLogQuery, [runId]);

    // Commit Transaction
    await client.query('COMMIT');
    console.log("==================================================");
    console.log("✔ DATABASE MIGRATION COMPLETED SUCCESSFULLY!");
    console.log(`Migration Run Log ID: ${runId}`);
    console.log("==================================================");

  } catch (error) {
    // ROLLBACK ON EXCEPTION TO SAFEGUARD INTEGRITY
    await client.query('ROLLBACK');
    console.error("❌ Migration failed! SQL Transaction rolled back successfully.", error);

    // Update logging metrics with failure state
    const updateLogFailQuery = `
      UPDATE migration_runs 
      SET status = 'Failed', error_summary = $1, completed_at = NOW() 
      WHERE id = $2;
    `;
    await client.query(updateLogFailQuery, [error.message, runId]);
  } finally {
    await client.end();
  }
}

runDatabaseMigration().catch(err => {
  console.error("Uncaught migration wrapper error:", err);
  process.exit(1);
});

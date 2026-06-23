import pkg from 'pg';
const { Client } = pkg;
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sqlPath = path.join(__dirname, '..', 'database', 'migration-v2.sql');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

async function runMigration() {
  console.log("Starting GarageKings V2 Schema Migration...");
  
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });

  await client.connect();
  console.log("✔ Connected to database.");

  if (!fs.existsSync(sqlPath)) {
    console.error("❌ SQL migration file not found at: " + sqlPath);
    await client.end();
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');
  
  await client.query('BEGIN');
  try {
    console.log("Executing SQL migration queries...");
    await client.query(sql);
    console.log("✔ SQL schema alteration finished.");

    // Seed default owner account if it doesn't exist
    const ownerEmail = 'admin@garagekings.com';
    const ownerPassword = 'admin123';
    
    const userRes = await client.query("SELECT id FROM users WHERE email = $1", [ownerEmail]);
    if (userRes.rows.length === 0) {
      console.log(`Seeding default Owner account: ${ownerEmail}`);
      const passHash = hashPassword(ownerPassword);
      await client.query(
        "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'Owner')",
        [ownerEmail, passHash]
      );
      console.log("✔ Default Owner account created successfully.");
    } else {
      console.log("✔ Owner account already exists, skipping seed.");
    }

    await client.query('COMMIT');
    console.log("✔ V2 migration successfully committed!");
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("❌ Migration failed, transaction rolled back:", err);
  } finally {
    await client.end();
  }
}

runMigration().catch(err => {
  console.error("Uncaught migration wrapper error:", err);
});

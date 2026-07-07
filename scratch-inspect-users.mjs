import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';

dotenv.config();

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });
  await client.connect();

  console.log("--- USERS ---");
  const users = await client.query("SELECT id, email, role, cognito_sub FROM users;");
  console.log(JSON.stringify(users.rows, null, 2));

  console.log("--- CASH ACCOUNTS ---");
  const accounts = await client.query("SELECT id, name, type, opening_balance, is_active FROM cash_accounts;");
  console.log(JSON.stringify(accounts.rows, null, 2));

  await client.end();
}

run().catch(console.error);

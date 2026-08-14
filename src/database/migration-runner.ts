import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

export async function runPendingMigrations(dataSource: DataSource, migrationsDir: string) {
  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const file of files) {
    const existing = await dataSource.query('SELECT 1 FROM schema_migrations WHERE name = $1;', [file]);
    if (existing.length > 0) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(sql);
      await runner.query('INSERT INTO schema_migrations (name) VALUES ($1);', [file]);
      await runner.commitTransaction();
      applied.push(file);
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  return applied;
}

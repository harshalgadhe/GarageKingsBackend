import type { Handler } from 'aws-lambda';
import { join } from 'node:path';
import { createMigrationDataSource } from './database/migration-data-source.js';
import { runPendingMigrations } from './database/migration-runner.js';

export const handler: Handler = async (event: any) => {
  if (event?.task !== 'run-migrations') throw new Error('Unsupported migration task.');

  const dataSource = await createMigrationDataSource();
  try {
    const applied = await runPendingMigrations(dataSource, join(process.cwd(), 'migrations'));
    return { success: true, applied };
  } finally {
    await dataSource.destroy();
  }
};

import type { Handler } from 'aws-lambda';
import { join } from 'node:path';
import { createMigrationDataSource } from './database/migration-data-source.js';
import { runPendingMigrations } from './database/migration-runner.js';

export const handler: Handler = async (event: any) => {
  if (event?.task !== 'run-migrations') throw new Error('Unsupported migration task.');

  const dataSource = await createMigrationDataSource();
  try {
    const applied = await runPendingMigrations(dataSource, join(process.cwd(), 'migrations'));
    const [variantSkuUniqueness, productSkuUniqueness, visibilityColumn] = await Promise.all([
      dataSource.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'product_variants'
          AND indexdef ILIKE '%UNIQUE%'
          AND indexdef ILIKE '%sku%'
      `),
      dataSource.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'products'
          AND indexdef ILIKE '%UNIQUE%'
          AND indexdef ILIKE '%sku%'
      `),
      dataSource.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'products'
          AND column_name = 'is_public'
      `),
    ]);

    return {
      success: true,
      applied,
      verification: {
        variantSkuUniqueIndexes: variantSkuUniqueness.map((row: any) => row.indexname),
        productSkuUniqueIndexes: productSkuUniqueness.map((row: any) => row.indexname),
        productVisibilityReady: visibilityColumn.length === 1,
      },
    };
  } finally {
    await dataSource.destroy();
  }
};

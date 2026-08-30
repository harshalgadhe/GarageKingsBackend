import type { Handler } from 'aws-lambda';
import { join } from 'node:path';
import { createMigrationDataSource } from './database/migration-data-source.js';
import { runPendingMigrations } from './database/migration-runner.js';
import { migratePostgresToDynamo } from './database/dynamodb-migration.js';

export const handler: Handler = async (event: any) => {
  if (event?.task === 'migrate-postgres-to-dynamodb') {
    const dataSource = await createMigrationDataSource();
    try {
      return { success: true, task: event.task, ...(await migratePostgresToDynamo(dataSource)) };
    } finally {
      await dataSource.destroy();
    }
  }

  if (event?.task === 'apply-brand-cover-image') {
    const dataSource = await createMigrationDataSource();
    try {
      await dataSource.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await dataSource.query(`
        ALTER TABLE public.brands
          ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
      `);

      await dataSource.query(`
        INSERT INTO public.schema_migrations (name)
        VALUES ('20260815_001_brand_cover_image.sql')
        ON CONFLICT (name) DO NOTHING;
      `);

      const columns = await dataSource.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'brands'
          AND column_name = 'cover_image_url';
      `);

      const migrationRecord = await dataSource.query(`
        SELECT name, applied_at
        FROM public.schema_migrations
        WHERE name = '20260815_001_brand_cover_image.sql';
      `);

      return {
        success: true,
        task: 'apply-brand-cover-image',
        columns,
        migrationRecord,
      };
    } finally {
      await dataSource.destroy();
    }
  }

  if (event?.task === 'grant-admin-harshalgadhe') {
    const dataSource = await createMigrationDataSource();
    try {
      const result = await dataSource.query(`
        INSERT INTO users (email, role, cognito_sub)
        VALUES ('harshalgadhe123@gmail.com', 'Admin', 'admin-harshalgadhe123')
        ON CONFLICT (email) DO UPDATE SET role = 'Admin', updated_at = NOW()
        RETURNING id, email, role;
      `);
      return {
        success: true,
        task: 'grant-admin-harshalgadhe',
        user: result[0],
      };
    } finally {
      await dataSource.destroy();
    }
  }

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

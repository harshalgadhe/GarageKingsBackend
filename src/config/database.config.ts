import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import dotenv from 'dotenv';

dotenv.config();

const isServerless = Boolean(
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT ||
  process.env.LAMBDA_RUNTIME_DIR ||
  process.env.IS_OFFLINE
);

const configuredPoolMax = Number(process.env.DATABASE_POOL_MAX);
const poolMax = Number.isFinite(configuredPoolMax) && configuredPoolMax > 0
  ? Math.min(Math.floor(configuredPoolMax), 10)
  : (isServerless ? 2 : 10);

export const databaseConfig = (): TypeOrmModuleOptions => ({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  synchronize: false, // Enforce migrations in production!
  logging: process.env.NODE_ENV === 'development',
  entities: [
    'dist/**/*.entity{.ts,.js}'
  ],
  ssl: process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : false,
  extra: {
    // Two sockets let a business transaction coexist with low-priority audit or
    // telemetry work. A pool of one can self-deadlock when a transaction invokes
    // a helper that acquires another connection.
    max: poolMax,
    min: 0, // Allow connection pool to completely drain when idle
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    maxUses: 7500 // Recycle connections after 7,500 queries to prevent memory leaks
  }
});

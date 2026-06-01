import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import dotenv from 'dotenv';

dotenv.config();

export const databaseConfig = (): TypeOrmModuleOptions => ({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  synchronize: false, // Enforce migrations in production!
  logging: process.env.NODE_ENV === 'development',
  entities: [
    'dist/**/*.entity{.ts,.js}'
  ],
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  extra: {
    // CRITICAL: Serverless connection pool mitigations
    max: 1, // Enforce exactly 1 active socket per Lambda execution container
    min: 0, // Allow connection pool to completely drain when idle
    idleTimeoutMillis: 1000, // Instantly close idle connections
    connectionTimeoutMillis: 1500, // Timeout queries quickly to free up connection pools
    maxUses: 7500 // Recycle connections after 7,500 queries to prevent memory leaks
  }
});

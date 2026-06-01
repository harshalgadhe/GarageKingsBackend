import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { databaseConfig } from './config/database.config.js';
import { ReceiptsModule } from './modules/receipts/receipts.module.js';
import { JwtStrategy } from './auth/jwt.strategy.js';

@Module({
  imports: [
    // 1. Dynamic Serverless-optimized database connections
    TypeOrmModule.forRoot(databaseConfig()),

    // 2. Application-Level Rate Limiter (NestJS Throttler)
    // CRITICAL: Protects the API against sudden single-user bursts
    ThrottlerModule.forRoot([{
      ttl: 60000, // Time-to-Live window of 1 minute (60 seconds)
      limit: 60,  // Max 60 requests per IP address in this window
    }]),

    // 3. Domain Modules
    ReceiptsModule
  ],
  providers: [
    JwtStrategy,
    
    // Bind ThrottlerGuard globally across all REST API controllers
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard
    }
  ]
})
export class AppModule {}
export default AppModule;

import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { databaseConfig } from './config/database.config.js';
import { ReceiptsModule } from './modules/receipts/receipts.module.js';
import { ApiModule } from './modules/api/api.module.js';
import { JwtStrategy } from './auth/jwt.strategy.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { ObservabilityModule } from './modules/observability/observability.module.js';
import { TraceMiddleware } from './common/middleware/trace.middleware.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';

@Module({
  imports: [
    // 1. Dynamic Serverless-optimized database connections
    TypeOrmModule.forRoot(databaseConfig()),

    // 2. Application-Level Rate Limiter (NestJS Throttler)
    ThrottlerModule.forRoot([{
      ttl: 60000, // Time-to-Live window of 1 minute (60 seconds)
      limit: 60,  // Max 60 requests per IP address in this window
    }]),

    // 3. Domain Modules
    ReceiptsModule,
    ApiModule,
    ObservabilityModule
  ],
  providers: [
    JwtStrategy,
    
    // Bind ThrottlerGuard globally across all REST API controllers
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard
    },
    // Bind AllExceptionsFilter globally to handle all uncaught errors
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter
    },
    // Bind LoggingInterceptor globally to collect request performance metrics
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor
    }
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TraceMiddleware)
      .forRoutes('*');
  }
}
export default AppModule;


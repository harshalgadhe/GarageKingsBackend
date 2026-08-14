import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { databaseConfig } from './config/database.config.js';
import { ReceiptsModule } from './modules/receipts/receipts.module.js';
import { ApiModule } from './modules/api/api.module.js';
import { JwtStrategy } from './auth/jwt.strategy.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { ObservabilityModule } from './modules/observability/observability.module.js';
import { TraceMiddleware } from './common/middleware/trace.middleware.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import { MulterModule } from '@nestjs/platform-express';

// New Feature Modules
import { ProductsModule } from './modules/products/products.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { SuppliersModule } from './modules/suppliers/suppliers.module.js';
import { FinanceModule } from './modules/finance/finance.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { ProxyAwareThrottlerGuard } from './common/guards/proxy-aware-throttler.guard.js';
import { getClientIp, getRequestRateLimit } from './config/rate-limit.config.js';

@Module({
  imports: [
    // 1. Dynamic Serverless-optimized database connections
    TypeOrmModule.forRoot(databaseConfig()),

    // 2. Application-Level Rate Limiter (NestJS Throttler)
    ThrottlerModule.forRoot({
      throttlers: [{
        ttl: 60000,
        limit: getRequestRateLimit,
      }],
      getTracker: async (req) => getClientIp(req),
    }),
    MulterModule.register({
      limits: {
        fileSize: 10 * 1024 * 1024,
        files: 1,
        fields: 20,
        fieldSize: 64 * 1024
      }
    }),

    // 3. Domain Modules
    ReceiptsModule,
    ApiModule,
    ObservabilityModule,
    ProductsModule,
    OrdersModule,
    SuppliersModule,
    FinanceModule,
    AnalyticsModule,
    SettingsModule,
    NotificationsModule
  ],
  providers: [
    JwtStrategy,
    
    // Bind ThrottlerGuard globally across all REST API controllers
    {
      provide: APP_GUARD,
      useClass: ProxyAwareThrottlerGuard
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


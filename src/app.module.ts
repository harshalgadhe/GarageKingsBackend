import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { JwtStrategy } from './auth/jwt.strategy.js';
import { TraceMiddleware } from './common/middleware/trace.middleware.js';
import { MulterModule } from '@nestjs/platform-express';
import { ProxyAwareThrottlerGuard } from './common/guards/proxy-aware-throttler.guard.js';
import { getClientIp, getRequestRateLimit } from './config/rate-limit.config.js';
import { DynamoCatalogModule } from './modules/dynamo-catalog/dynamo-catalog.module.js';

@Module({
  imports: [
    DynamoCatalogModule,

    // Application-Level Rate Limiter (NestJS Throttler)
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
    })
  ],
  providers: [
    JwtStrategy,
    
    // Bind ThrottlerGuard globally across all REST API controllers
    {
      provide: APP_GUARD,
      useClass: ProxyAwareThrottlerGuard
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


import * as Sentry from '@sentry/nestjs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ApiService } from './modules/api/api.service.js';
import { configure as serverlessExpress } from '@vendia/serverless-express';
import { Handler, Context, Callback } from 'aws-lambda';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 1.0,
  });
  console.log('✔ Sentry initialized on backend.');
}

let server: any;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: true,
    credentials: true,
  });
  await app.init();
  const expressApp = app.getHttpAdapter().getInstance();
  return serverlessExpress({ app: expressApp });
}

let nestApp: any;

export const handler: Handler = async (event: any, context: Context, callback: Callback) => {
  if (event && event.task === 'cleanup-expired-orders') {
    console.log('[Lambda] Intercepted direct EventBridge cleanup task invocation.');
    if (!nestApp) {
      nestApp = await NestFactory.createApplicationContext(AppModule);
    }
    const apiService = nestApp.get(ApiService);
    await apiService.expireActiveOrders();
    console.log('[Lambda] Expiration cleanup execution completed.');
    return { success: true, message: 'Expired reservations cleaned successfully.' };
  }

  server = server || await bootstrap();
  return server(event, context, callback);
};

// Local development bootstrap
if (process.env.NODE_ENV !== 'production' && !process.env.AWS_EXECUTION_ENV) {
  const startLocal = async () => {
    const app = await NestFactory.create(AppModule);
    app.enableCors({
      origin: true,
      credentials: true,
    });
    const port = process.env.PORT || 5001;
    await app.listen(port);
    console.log(`GarageKings NestJS server running locally on http://localhost:${port}`);
  };
  startLocal().catch(err => {
    console.error('Failed to start local NestJS app:', err);
  });
}

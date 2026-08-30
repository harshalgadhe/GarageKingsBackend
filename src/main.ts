import * as Sentry from '@sentry/nestjs';
import { NestFactory } from '@nestjs/core';
import { configure as serverlessExpress } from '@vendia/serverless-express';
import { Handler, Context, Callback } from 'aws-lambda';
import { getJwtSecret, isAllowedOrigin } from './config/security.config.js';
import { AppModule } from './app.module.js';

getJwtSecret();

const corsOptions = {
  origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS policy.'));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id', 'X-CSRF-Token'],
  exposedHeaders: ['X-Correlation-Id']
};

function applySecurityHeaders(app: any) {
  app.use((req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
    next();
  });
}

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
  });
  console.log('✔ Sentry initialized on backend.');
}

let server: any;
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  applySecurityHeaders(app);
  app.enableCors(corsOptions);
  await app.init();
  const expressApp = app.getHttpAdapter().getInstance();
  return serverlessExpress({ app: expressApp });
}

export const handler: Handler = async (event: any, context: Context, callback: Callback) => {
  if (event && event.task === 'cleanup-expired-orders') {
    return { success: true, skipped: true, message: 'Reservation cleanup is not used by the enquiry-only DynamoDB platform.' };
  }

  server = server || await bootstrap();
  return server(event, context, callback);
};

// Local development bootstrap
if (process.env.NODE_ENV !== 'production' && !process.env.AWS_EXECUTION_ENV) {
  const startLocal = async () => {
    const app = await NestFactory.create(AppModule);
    applySecurityHeaders(app);
    app.enableCors(corsOptions);
    const port = process.env.PORT || 5001;
    await app.listen(port);
    console.log(`GarageKings NestJS server running locally on http://localhost:${port}`);
  };
  startLocal().catch(err => {
    console.error('Failed to start local NestJS app:', err);
  });
}

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configure as serverlessExpress } from '@vendia/serverless-express';
import { Handler, Context, Callback } from 'aws-lambda';

let server: any;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  await app.init();
  const expressApp = app.getHttpAdapter().getInstance();
  return serverlessExpress({ app: expressApp });
}

export const handler: Handler = async (event: any, context: Context, callback: Callback) => {
  server = server || await bootstrap();
  return server(event, context, callback);
};

// Local development bootstrap
if (process.env.NODE_ENV !== 'production' && !process.env.AWS_EXECUTION_ENV) {
  const startLocal = async () => {
    const app = await NestFactory.create(AppModule);
    app.enableCors();
    const port = process.env.PORT || 5001;
    await app.listen(port);
    console.log(`GarageKings NestJS server running locally on http://localhost:${port}`);
  };
  startLocal().catch(err => {
    console.error('Failed to start local NestJS app:', err);
  });
}

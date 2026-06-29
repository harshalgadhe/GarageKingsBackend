import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { traceStorage } from './trace-context.js';

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    let correlationId = req.headers['x-correlation-id'] as string;
    if (!correlationId) {
      // GK-TR-YYYYMMDD-RandomHex
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const rand = Math.random().toString(36).substring(2, 10).toUpperCase();
      correlationId = `GK-TR-${today}-${rand}`;
    }

    req['correlationId'] = correlationId;
    res.setHeader('x-correlation-id', correlationId);

    traceStorage.run(correlationId, () => {
      next();
    });
  }
}

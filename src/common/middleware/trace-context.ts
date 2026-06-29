import { AsyncLocalStorage } from 'async_hooks';

export const traceStorage = new AsyncLocalStorage<string>();

export function getCorrelationId(): string {
  return traceStorage.getStore() || 'GK-TR-SYSTEM-UNKNOWN';
}

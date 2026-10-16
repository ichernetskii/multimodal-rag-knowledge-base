import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
export interface RequestContext {
  tenant: string;
  user: string;
  transaction?: PoolClient;
}
export const requestContext = new AsyncLocalStorage<RequestContext>();

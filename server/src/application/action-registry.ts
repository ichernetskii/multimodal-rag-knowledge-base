import type { ActionName, ActionResults } from '../contracts/public.js';
import type { Principal } from '../domain/entities.js';
import { requireValue } from '../shared/errors.js';
import type { Input } from '../shared/input.js';
type ActionHandler<T = unknown> = (input: Input, user?: Principal) => T;
export type ActionMap = Partial<{
  [A in ActionName]: ActionHandler<ActionResults[A] | Promise<ActionResults[A]>>;
}>;
export const authorized =
  <T>(handler: (user: Principal, input: Input) => T): ActionHandler<T> =>
  (input, user) => {
    requireValue(user, 'UNAUTHENTICATED', 'Войдите в систему.', 401);
    return handler(user, input);
  };

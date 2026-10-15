export * from '../contracts/public.js';
import type { User as PublicUser } from '../contracts/public.js';
/** Password hashes are private persistence data and never part of public contracts. */
export interface User extends PublicUser {
  password: string;
}

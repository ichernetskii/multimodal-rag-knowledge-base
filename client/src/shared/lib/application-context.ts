import { createContext, useContext } from 'react';
import type { ApplicationStore } from '../../app/application-store';

export const ApplicationContext = createContext<ApplicationStore | null>(null);
export function useApplication() {
  const value = useContext(ApplicationContext);
  if (!value) throw new Error('ApplicationProvider is missing');
  return value;
}

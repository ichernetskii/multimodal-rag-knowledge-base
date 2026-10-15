import type { ReactNode } from 'react';
import { ApplicationContext } from '../shared/lib/application-context';
import type { ApplicationStore } from './application-store';
export function ApplicationProvider({
  application,
  children,
}: {
  application: ApplicationStore;
  children: ReactNode;
}) {
  return <ApplicationContext.Provider value={application}>{children}</ApplicationContext.Provider>;
}

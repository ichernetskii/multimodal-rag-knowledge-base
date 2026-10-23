import type { Principal } from '../../shared/api/contracts.generated';
import type { IconName } from '../../shared/ui/Icon';

/** Navigation describes the scope of an operation, independently from the selected tenant. */
export const adminSections = {
  models: {
    name: 'AI & models',
    scope: 'company',
    icon: 'connections',
    description: 'Task assignments and connected models for this company.',
    tabs: { assignments: 'Model assignments', connections: 'Connected models' },
  },
  users: {
    name: 'Team & access',
    scope: 'company',
    icon: 'users',
    description: 'Members, invitations, and access groups for this company.',
    tabs: {},
  },
  usage: {
    name: 'Usage & limits',
    scope: 'company',
    icon: 'usage',
    description: 'AI usage, budget, and resources for this company.',
    tabs: {},
  },
  maintenance: {
    name: 'Maintenance',
    scope: 'company',
    icon: 'operations',
    description: 'Jobs, backups, activity, processing, and retention.',
    tabs: {
      jobs: 'Jobs',
      backups: 'Backups',
      audit: 'Activity log',
      processing: 'Processing & retention',
    },
  },
  credentials: {
    name: 'API keys',
    scope: 'platform',
    icon: 'shield',
    description: 'Shared provider credentials for all companies.',
    tabs: {},
  },
  system: {
    name: 'System health',
    scope: 'platform',
    icon: 'settings',
    description: 'Installation dependencies and company access management.',
    tabs: { health: 'System health', companies: 'Companies' },
  },
} as const satisfies Record<
  string,
  {
    name: string;
    scope: 'company' | 'platform';
    icon: IconName;
    description: string;
    tabs: Record<string, string>;
  }
>;
export type AdminSection = keyof typeof adminSections;
export const adminNames = Object.fromEntries(
  Object.entries(adminSections).map(([key, value]) => [key, value.name]),
) as Record<AdminSection, string>;
export const roleNames = {
  admin: 'Company administrator',
  editor: 'Editor',
  user: 'Member',
} as const;
export function canAccessAdmin(section: AdminSection, user: Pick<Principal, 'role' | 'operator'>) {
  return adminSections[section].scope === 'platform' ? user.operator : user.role === 'admin';
}
export function canAccessAdminTab(
  section: AdminSection,
  tab: string,
  user: Pick<Principal, 'role' | 'operator'>,
) {
  return (
    canAccessAdmin(section, user) &&
    (section !== 'models' || tab !== 'connections' || user.operator)
  );
}
export function adminGroups(user: Pick<Principal, 'role' | 'operator'>) {
  return (['company', 'platform'] as const)
    .map((scope) => ({
      scope,
      name: scope === 'company' ? 'Company' : 'Platform · all companies',
      sections: (Object.keys(adminSections) as AdminSection[]).filter(
        (section) => adminSections[section].scope === scope && canAccessAdmin(section, user),
      ),
    }))
    .filter((group) => group.sections.length);
}
export function defaultAdminTab(section: AdminSection) {
  return Object.keys(adminSections[section].tabs)[0] ?? '';
}

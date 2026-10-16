import type { Principal } from '../../shared/api/contracts.generated';
import type { IconName } from '../../shared/ui/Icon';

/** Navigation describes the scope of an operation, independently from the selected tenant. */
export const adminSections = {
  models: {
    name: 'AI и модели',
    scope: 'company',
    icon: 'connections',
    description: 'Назначения задач и подключённые модели этой компании.',
    tabs: { assignments: 'Назначение моделей', connections: 'Подключённые модели' },
  },
  users: {
    name: 'Команда и доступ',
    scope: 'company',
    icon: 'users',
    description: 'Участники, приглашения и группы доступа этой компании.',
    tabs: {},
  },
  usage: {
    name: 'Расходы и лимиты',
    scope: 'company',
    icon: 'usage',
    description: 'Использование AI, бюджет и ресурсы этой компании.',
    tabs: {},
  },
  maintenance: {
    name: 'Обслуживание',
    scope: 'company',
    icon: 'operations',
    description: 'Задания, резервные копии, журнал, обработка и хранение.',
    tabs: {
      jobs: 'Задания',
      backups: 'Резервные копии',
      audit: 'Журнал действий',
      processing: 'Обработка и хранение',
    },
  },
  credentials: {
    name: 'API-ключи',
    scope: 'platform',
    icon: 'shield',
    description: 'Общий реестр ключей поставщиков для всех компаний.',
    tabs: {},
  },
  system: {
    name: 'Состояние системы',
    scope: 'platform',
    icon: 'settings',
    description: 'Зависимости установки и управление доступом компаний.',
    tabs: { health: 'Состояние системы', companies: 'Компании' },
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
  admin: 'Администратор компании',
  editor: 'Редактор',
  user: 'Пользователь',
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
      name: scope === 'company' ? 'Компания' : 'Платформа · все компании',
      sections: (Object.keys(adminSections) as AdminSection[]).filter(
        (section) => adminSections[section].scope === scope && canAccessAdmin(section, user),
      ),
    }))
    .filter((group) => group.sections.length);
}
export function defaultAdminTab(section: AdminSection) {
  return Object.keys(adminSections[section].tabs)[0] ?? '';
}

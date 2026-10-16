import type { Principal } from '../../shared/api/contracts.generated';
import type { IconName } from '../../shared/ui/Icon';
export const adminSections = {
  overview: {
    name: 'Обзор управления',
    group: 'Начало',
    scope: 'company',
    icon: 'overview',
    description: 'Состояние компании и быстрый доступ к основным задачам.',
  },
  assistant: {
    name: 'Помощник и модели',
    group: 'Компания',
    scope: 'company',
    icon: 'chat',
    description: 'Выбор модели ответа, распознавание речи и поведение помощника.',
  },
  collections: {
    name: 'Базы знаний и доступ',
    group: 'Компания',
    scope: 'company',
    icon: 'collections',
    description: 'Базы знаний и разрешения на их материалы.',
  },
  users: {
    name: 'Команда и роли',
    group: 'Компания',
    scope: 'company',
    icon: 'users',
    description: 'Сотрудники, приглашения и группы доступа.',
  },
  usage: {
    name: 'Расходы и лимиты',
    group: 'Компания',
    scope: 'company',
    icon: 'usage',
    description: 'Расходы AI, бюджет и доступные ресурсы компании.',
  },
  indexes: {
    name: 'Поисковый индекс',
    group: 'База знаний',
    scope: 'company',
    icon: 'search',
    description: 'Модель поиска и безопасное переключение нового индекса.',
  },
  sync: {
    name: 'Синхронизация',
    group: 'База знаний',
    scope: 'company',
    icon: 'sync',
    description: 'Подключённые папки и изменения материалов.',
  },
  quality: {
    name: 'Качество ответов',
    group: 'База знаний',
    scope: 'company',
    icon: 'quality',
    description: 'Отзывы и контрольные вопросы для проверки ответов.',
  },
  operations: {
    name: 'Задания и очереди',
    group: 'Обслуживание',
    scope: 'company',
    icon: 'operations',
    description: 'Обработка материалов, ответы и ошибки заданий.',
  },
  backups: {
    name: 'Резервные копии',
    group: 'Обслуживание',
    scope: 'company',
    icon: 'backups',
    description: 'Создание, проверка и восстановление копии компании.',
  },
  audit: {
    name: 'Журнал действий',
    group: 'Обслуживание',
    scope: 'company',
    icon: 'audit',
    description: 'История изменений и действий в выбранной компании.',
  },
  settings: {
    name: 'Параметры обработки',
    group: 'Обслуживание',
    scope: 'company',
    icon: 'settings',
    description: 'Файлы, мультимедиа, хранение и управление приёмом запросов.',
  },
  tenants: {
    name: 'Компании клиентов',
    group: 'Платформа · только владелец',
    scope: 'platform',
    icon: 'tenants',
    description: 'Создание и состояние компаний в общей установке.',
  },
  connections: {
    name: 'AI-подключения и ключи',
    group: 'Платформа · только владелец',
    scope: 'platform',
    icon: 'connections',
    description: 'Каталог разрешённых моделей и настройка серверных ключей.',
  },
  system: {
    name: 'Состояние сервера',
    group: 'Платформа · только владелец',
    scope: 'platform',
    icon: 'operations',
    description: 'PostgreSQL, Redis, S3, обработчики и ресурсы сервера.',
  },
} as const satisfies Record<
  string,
  {
    name: string;
    group: string;
    scope: 'company' | 'platform';
    icon: IconName;
    description: string;
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
  return user.role === 'admin' && (adminSections[section].scope === 'company' || user.operator);
}
export function adminGroups(user: Pick<Principal, 'role' | 'operator'>) {
  const groups = new Map<string, AdminSection[]>();
  for (const section of Object.keys(adminSections) as AdminSection[])
    if (canAccessAdmin(section, user)) {
      const group = adminSections[section].group;
      groups.set(group, [...(groups.get(group) ?? []), section]);
    }
  return [...groups].map(([name, sections]) => ({ name, sections }));
}

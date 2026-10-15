export const adminNames = {
  operations: 'Эксплуатация',
  users: 'Пользователи',
  collections: 'Базы и доступ',
  quality: 'Качество',
  sync: 'Синхронизация',
  backups: 'Резервные копии',
  settings: 'Настройки',
};
export type AdminSection = keyof typeof adminNames;

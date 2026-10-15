export function bytes(value: number) {
  if (value < 1024) return value + ' Б';
  const units = ['КиБ', 'МиБ', 'ГиБ', 'ТиБ'];
  let index = -1;
  do {
    value /= 1024;
    index++;
  } while (value >= 1024 && index < units.length - 1);
  return (
    new Intl.NumberFormat('ru', { maximumFractionDigits: value >= 10 ? 0 : 1 }).format(value) +
    ' ' +
    units[index]
  );
}
export const date = (value: number) =>
  new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' }).format(value);
export const duration = (value: number) =>
  value < 1000
    ? Math.round(value) + ' мс'
    : value < 60000
      ? (value / 1000).toFixed(1) + ' с'
      : Math.floor(value / 60000) + ' мин ' + Math.round((value % 60000) / 1000) + ' с';

const plurals = new Intl.PluralRules('ru');
export function quantity(value: number, one: string, few: string, many: string) {
  const form = plurals.select(value);
  return `${value} ${form === 'one' ? one : form === 'few' ? few : many}`;
}

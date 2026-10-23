export function bytes(value: number) {
  if (value < 1024) return value + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let index = -1;
  do {
    value /= 1024;
    index++;
  } while (value >= 1024 && index < units.length - 1);
  return (
    new Intl.NumberFormat('en-US', { maximumFractionDigits: value >= 10 ? 0 : 1 }).format(value) +
    ' ' +
    units[index]
  );
}
export const date = (value: number) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(value);
export const duration = (value: number) =>
  value < 1000
    ? Math.round(value) + ' ms'
    : value < 60000
      ? (value / 1000).toFixed(1) + ' s'
      : Math.floor(value / 60000) + ' min ' + Math.round((value % 60000) / 1000) + ' s';

export function quantity(value: number, one: string, many: string) {
  return `${value} ${value === 1 ? one : many}`;
}

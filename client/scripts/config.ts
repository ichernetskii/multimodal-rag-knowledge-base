export function httpOrigin(value: string, name: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      name + ' must be an HTTP(S) origin without credentials, path, query or fragment.',
    );
  return url.origin;
}
export function port(value: string | undefined, fallback: number) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535)
    throw new Error('Port must be an integer between 1 and 65535.');
  return number;
}

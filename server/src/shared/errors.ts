import { randomUUID } from 'node:crypto';
export class AppError extends Error {
  readonly diagnostic: string;
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    diagnostic?: string,
  ) {
    super(message);
    this.diagnostic = diagnostic ?? randomUUID();
  }
}
export function requireValue(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
export function errorResponse(error: unknown) {
  if (error instanceof AppError)
    return {
      status: error.status,
      error: { code: error.code, message: error.message, diagnostic: error.diagnostic },
    };
  const disk = error instanceof Error && /ENOSPC|disk.*full/iu.test(error.message);
  return {
    status: disk ? 507 : 500,
    error: {
      code: disk ? 'DISK_FULL' : 'INTERNAL',
      message: disk ? 'Not enough disk space.' : 'Technical error. Use the ID for diagnostics.',
      diagnostic: randomUUID(),
    },
  };
}

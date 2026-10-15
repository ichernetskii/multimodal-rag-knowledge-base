import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
/** Own and terminate exactly the processes started by this command. */
export function supervise(
  commands: { entry: string; args?: string[]; cwd?: string; nodeArgs?: string[] }[],
) {
  const children: ChildProcess[] = [],
    timers: ReturnType<typeof setTimeout>[] = [];
  let closing = false;
  const close = (code = 0) => {
    if (closing) return;
    closing = true;
    process.exitCode = code;
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 30_000);
      timer.unref();
      timers.push(timer);
    }
  };
  for (const command of commands) {
    const child = spawn(
      process.execPath,
      [...(command.nodeArgs ?? []), command.entry, ...(command.args ?? [])],
      { cwd: command.cwd ?? root, stdio: 'inherit', env: process.env },
    );
    children.push(child);
    child.once('error', (error) => {
      console.error(error.message);
      close(1);
    });
    child.once('exit', (code, signal) => {
      if (!closing) close(code ?? (signal ? 1 : 0));
      if (children.every((value) => value.exitCode !== null || value.signalCode !== null))
        for (const timer of timers) clearTimeout(timer);
    });
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => close());
  return { close, children };
}

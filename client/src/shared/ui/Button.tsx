import { useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useApplication } from '../lib/application-context';
export function Button({
  children,
  onClick,
  className = '',
  disabled = false,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  children?: ReactNode;
  onClick: () => unknown;
}) {
  const app = useApplication(),
    [busy, setBusy] = useState(false),
    running = useRef(false);
  return (
    <button
      {...props}
      type="button"
      className={className}
      disabled={disabled}
      aria-disabled={disabled || busy || undefined}
      aria-busy={busy || undefined}
      onClick={() => {
        if (running.current || disabled) return;
        running.current = true;
        setBusy(true);
        void app
          .execute(async () => {
            await onClick();
          })
          .finally(() => {
            running.current = false;
            setBusy(false);
          });
      }}
    >
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

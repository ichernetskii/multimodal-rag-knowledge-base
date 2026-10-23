import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type HTMLInputTypeAttribute,
  type InputHTMLAttributes,
} from 'react';
import { ApiError } from '../api/client';
import { useApplication } from '../lib/application-context';
export function Form({
  children,
  submit,
  label = 'Save',
  busyLabel = 'Working…',
  disabled = false,
  className = '',
  autoComplete,
  protectChanges = false,
}: {
  children: ReactNode;
  submit: (data: FormData) => Promise<unknown>;
  label?: string;
  busyLabel?: string;
  disabled?: boolean;
  className?: string;
  autoComplete?: string;
  protectChanges?: boolean;
}) {
  const app = useApplication(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    errorId = useId(),
    form = useRef<HTMLFormElement>(null),
    errorSummary = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error !== undefined) errorSummary.current?.focus();
  }, [error]);
  useEffect(() => () => app.unsaved.clear(errorId), [app, errorId]);
  return (
    <form
      ref={form}
      className={className}
      autoComplete={autoComplete}
      aria-busy={busy || undefined}
      aria-describedby={error ? errorId : undefined}
      onChange={() => {
        if (protectChanges)
          app.unsaved.mark(errorId, form.current?.closest('dialog') ? 'dialog' : 'page');
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const data = new FormData(event.currentTarget);
        // Values are submitted now; failed saves restore the leave-page protection.
        app.unsaved.clear(errorId);
        setBusy(true);
        setError(undefined);
        void submit(data)
          .then(() => app.unsaved.clear(errorId))
          .catch((e: unknown) => {
            setError(e);
            if (protectChanges && form.current?.isConnected)
              app.unsaved.mark(errorId, form.current.closest('dialog') ? 'dialog' : 'page');
            app.handleError(e, !form.current?.isConnected);
          })
          .finally(() => setBusy(false));
      }}
    >
      <fieldset disabled={busy} className="form-fields">
        {children}
      </fieldset>
      {error !== undefined && (
        <div className="inline-error" id={errorId} role="alert" ref={errorSummary} tabIndex={-1}>
          <strong>{error instanceof Error ? error.message : 'Could not save changes.'}</strong>
          {error instanceof ApiError && error.code === 'REVISION_CONFLICT' && (
            <p>
              Data changed in another tab or by another user. Refresh the list and reopen the form.
            </p>
          )}
          {error instanceof ApiError && error.diagnostic && (
            <small>
              Code: {error.code} · ID: {error.diagnostic}
            </small>
          )}
        </div>
      )}
      <div className="form-footer">
        <button className="primary" disabled={busy || disabled} type="submit">
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? busyLabel : label}
        </button>
      </div>
    </form>
  );
}
export function Field({
  label,
  name,
  value = '',
  type = 'text',
  required = false,
  hint,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'defaultValue' | 'name'> & {
  label: string;
  name: string;
  value?: string | number;
  type?: HTMLInputTypeAttribute | 'textarea';
  hint?: string;
}) {
  const id = useId(),
    hintId = id + '-hint';
  return (
    <label className="field" htmlFor={id}>
      <span>
        {label}
        {required && (
          <span className="required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </span>
      {type === 'textarea' ? (
        <textarea
          id={id}
          name={name}
          aria-label={label}
          defaultValue={value}
          required={required}
          rows={5}
          placeholder={props.placeholder}
          maxLength={props.maxLength}
          readOnly={props.readOnly}
          disabled={props.disabled}
          aria-describedby={hint ? hintId : undefined}
        />
      ) : (
        <input
          {...props}
          id={id}
          name={name}
          aria-label={label}
          type={type}
          defaultValue={value}
          required={required}
          minLength={props.minLength ?? (type === 'password' ? 12 : undefined)}
          autoComplete={props.autoComplete ?? (type === 'password' ? 'new-password' : undefined)}
          aria-describedby={hint ? hintId : undefined}
        />
      )}
      {hint && (
        <small className="field-hint" id={hintId}>
          {hint}
        </small>
      )}
    </label>
  );
}
export function Check({
  label,
  name,
  checked = false,
  value,
  hint,
}: {
  label: string;
  name: string;
  checked?: boolean;
  value?: string;
  hint?: string;
}) {
  const hintId = useId();
  return (
    <label className="check">
      <input
        type="checkbox"
        name={name}
        defaultChecked={checked}
        value={value}
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
      />
      <span>
        {label}
        {hint && (
          <small className="field-hint" id={hintId}>
            {hint}
          </small>
        )}
      </span>
    </label>
  );
}
export function Select({
  label,
  name,
  options,
  value = '',
  multiple = false,
  onChange,
  hint,
}: {
  label: string;
  name: string;
  options: [string, string][];
  value?: string | string[];
  multiple?: boolean;
  onChange?: (value: string) => void;
  hint?: string;
}) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <select
        id={id}
        name={name}
        aria-label={label}
        aria-describedby={hint ? id + '-hint' : undefined}
        multiple={multiple}
        defaultValue={value}
        onChange={(event) => onChange?.(event.target.value)}
      >
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
      {hint && (
        <small className="field-hint" id={id + '-hint'}>
          {hint}
        </small>
      )}
    </label>
  );
}

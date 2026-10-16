import { useId, type KeyboardEvent, type ReactNode } from 'react';

/** Manual activation keeps keyboard exploration from starting network requests. */
export function Tabs({
  label,
  tabs,
  selected,
  onChange,
  children,
}: {
  label: string;
  tabs: Record<string, string>;
  selected: string;
  onChange: (id: string) => void;
  children: ReactNode;
}) {
  const id = useId();
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const at = controls.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? controls.length - 1
          : event.key === 'ArrowRight'
            ? (at + 1) % controls.length
            : event.key === 'ArrowLeft'
              ? (at + controls.length - 1) % controls.length
              : -1;
    if (next >= 0) {
      event.preventDefault();
      controls[next]?.focus();
    }
  };
  return (
    <>
      <div className="tabs" role="tablist" aria-label={label} onKeyDown={moveFocus}>
        {Object.entries(tabs).map(([key, name]) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={id + '-tab-' + key}
            aria-controls={id + '-panel'}
            aria-selected={selected === key}
            tabIndex={selected === key ? 0 : -1}
            onClick={() => onChange(key)}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={id + '-panel'}
        aria-labelledby={id + '-tab-' + selected}
        tabIndex={0}
      >
        {children}
      </div>
    </>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ModalContext } from '../lib/hooks';
import { observer } from 'mobx-react-lite';
import { useApplication } from '../lib/application-context';
export const ModalProvider = observer(function ModalProvider({
  children,
}: {
  children: ReactNode;
}) {
  const app = useApplication();
  const [content, setContent] = useState<ReactNode>(null),
    dialog = useRef<HTMLDialogElement>(null),
    previous = useRef<HTMLElement | null>(null),
    opened = useRef(false);
  useEffect(() => setContent(null), [app.session.permissionsVersion, app.session.epoch]);
  useEffect(() => {
    if (content) {
      if (!dialog.current?.open) {
        previous.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        opened.current = true;
        dialog.current?.showModal();
      }
    } else if (opened.current) {
      opened.current = false;
      dialog.current?.close();
      const target = previous.current?.isConnected
        ? previous.current
        : document.getElementById('main');
      target?.focus();
    }
  }, [content]);
  return (
    <ModalContext.Provider value={setContent}>
      {children}
      <dialog
        id="dialog"
        ref={dialog}
        aria-label="Диалоговое окно"
        onCancel={() => setContent(null)}
        onClose={() => setContent(null)}
        onClick={(event) => {
          if (event.target === dialog.current) {
            const rect = dialog.current.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              setContent(null);
          }
        }}
      >
        <button
          id="close-dialog"
          className="icon-button modal-close"
          onClick={() => setContent(null)}
          aria-label="Закрыть окно"
        >
          ×
        </button>
        <div id="dialog-content">{content}</div>
      </dialog>
    </ModalContext.Provider>
  );
});

import { useApplication } from './application-context';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from 'react';
export const ModalContext = createContext<(content: ReactNode) => void>(() => undefined);
export const useModal = () => useContext(ModalContext);
export function useLoad<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[] = [],
) {
  const app = useApplication();
  const accessVersion = app.session.permissionsVersion,
    sessionEpoch = app.session.epoch,
    previousAccess = useRef(accessVersion);
  const [data, setData] = useState<T>(),
    [loading, setLoading] = useState(true),
    [epoch, setEpoch] = useState(0),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    if (previousAccess.current !== accessVersion) {
      setData(undefined);
      previousAccess.current = accessVersion;
    }
    void load(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : 'Loading failed');
          app.handleError(e, false);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [...deps, epoch, accessVersion, sessionEpoch]);
  return { data, loading, error, reload: useCallback(() => setEpoch((e) => e + 1), []) };
}
export function useDebouncedValue<T>(value: T, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
export function usePolling(reload: () => void, interval = 5000, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
        if (!document.hidden) reload();
      },
      timer = setInterval(refresh, interval);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reload, interval, enabled]);
}
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query),
      update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

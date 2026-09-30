import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

type ToastKind = "success" | "error" | "info";
type ToastLink = { to: string; label: string };
type ToastItem = { id: number; kind: ToastKind; message: string; link?: ToastLink };

type Toasts = {
  success: (message: string, link?: ToastLink) => void;
  info: (message: string, link?: ToastLink) => void;
  error: (message: string) => void;
};

const noop = () => {};
const ToastContext = createContext<Toasts>({ success: noop, info: noop, error: noop });

/** Feedback for mutations: `const toast = useToast(); toast.success("Job disabled")`. */
export function useToast(): Toasts {
  return useContext(ToastContext);
}

const LIFETIME_MS: Record<ToastKind, number> = { success: 6_000, info: 6_000, error: 12_000 };
const MAX_VISIBLE = 4;

const KIND_CLASS: Record<ToastKind, string> = {
  success: "bg-ok-bg text-ok-fg border-ok-fg/40",
  info: "bg-info-bg text-info-fg border-info-fg/40",
  error: "bg-bad-bg text-bad-fg border-bad-fg/40",
};

/**
 * A small, library-free toast area. Success and info messages go into a
 * polite live region and errors into an assertive one, so a screen reader
 * announces the outcome of an action without the user having to look for it.
 * The regions always exist; only their contents change.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, link?: ToastLink) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-(MAX_VISIBLE - 1)), { id, kind, message, link }]);
    },
    [],
  );

  const api = useMemo<Toasts>(
    () => ({
      success: (m, l) => push("success", m, l),
      info: (m, l) => push("info", m, l),
      error: (m) => push("error", m),
    }),
    [push],
  );

  const polite = items.filter((t) => t.kind !== "error");
  const assertive = items.filter((t) => t.kind === "error");

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 pointer-events-none sm:left-auto sm:w-96">
        <div role="status" aria-live="polite" className="flex w-full flex-col gap-2">
          {polite.map((t) => (
            <ToastCard key={t.id} item={t} onDismiss={dismiss} />
          ))}
        </div>
        <div role="alert" className="flex w-full flex-col gap-2">
          {assertive.map((t) => (
            <ToastCard key={t.id} item={t} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (hovered) return;
    const timer = window.setTimeout(() => onDismiss(item.id), LIFETIME_MS[item.kind]);
    return () => window.clearTimeout(timer);
  }, [hovered, item.id, item.kind, onDismiss]);

  return (
    <div
      className={`pointer-events-auto flex items-start gap-3 rounded-md border px-3 py-2 text-sm shadow-md ${KIND_CLASS[item.kind]}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <p className="min-w-0 flex-1 break-words">
        {item.message}
        {item.link && (
          <>
            {" "}
            <Link to={item.link.to} className="font-medium underline">
              {item.link.label}
            </Link>
          </>
        )}
      </p>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss message"
        className="-my-0.5 shrink-0 rounded px-1.5 text-base leading-none opacity-70 hover:opacity-100"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

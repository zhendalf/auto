import { useEffect, useId, useRef, useState } from "react";
import { BTN, BTN_DANGER, BTN_SM } from "./ui.ts";

/**
 * A button that asks before acting. Clicking it swaps it for an inline
 * question with two buttons; focus moves to the safe choice ("Keep") and Escape
 * cancels. Inline rather than a modal so it is
 * keyboard-friendly and never hides the page state the decision depends on.
 */
export function ConfirmButton({
  label,
  question,
  confirmLabel,
  cancelLabel = "Keep",
  onConfirm,
  disabled,
  pending,
  small,
  className,
  tone = "default",
  ariaLabel,
  buttonRef,
}: {
  label: string;
  question: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  pending?: boolean;
  small?: boolean;
  className?: string;
  tone?: "default" | "danger";
  /** Accessible name for the opening button when the visible label alone is ambiguous (several "Disable" on a page). */
  ariaLabel?: string;
  /** Receives the opening button, for a parent that has to move focus to it. */
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  const [asking, setAsking] = useState(false);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const wasAsking = useRef(false);
  const questionId = useId();

  useEffect(() => {
    if (asking) keepRef.current?.focus();
    else if (wasAsking.current) openerRef.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  const size = small ? BTN_SM : "";
  if (!asking) {
    return (
      <button
        ref={(el) => {
          openerRef.current = el;
          if (typeof buttonRef === "function") buttonRef(el);
          else if (buttonRef) (buttonRef as React.MutableRefObject<HTMLButtonElement | null>).current = el;
        }}
        type="button"
        className={`${tone === "danger" ? BTN_DANGER : BTN} ${size} ${className ?? ""}`}
        disabled={disabled || pending}
        aria-label={ariaLabel}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    );
  }
  return (
    <span
      role="group"
      aria-labelledby={questionId}
      className="inline-flex flex-wrap items-center gap-2 rounded-md border border-line-strong bg-sunken px-2 py-1"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setAsking(false);
        }
      }}
    >
      <span id={questionId} className="text-sm">
        {question}
      </span>
      <button
        type="button"
        className={`${BTN_DANGER} ${BTN_SM}`}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button ref={keepRef} type="button" className={`${BTN} ${BTN_SM}`} onClick={() => setAsking(false)}>
        {cancelLabel}
      </button>
    </span>
  );
}

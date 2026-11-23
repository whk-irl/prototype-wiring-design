/**
 * The one dialog pattern: a title bar (with a close button when the dialog
 * can be dismissed), a body that scrolls, and a footer with the secondary
 * actions left of the primary one. Escape closes it; focus moves into it.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { IconClose } from './icons';

/**
 * The one way a dialog takes keys: Escape closes it (when it can be closed)
 * and goes no further. Tab stays inside and the focus returns to the opener
 * when it closes (modalFocus.ts, for every `aria-modal` dialog).
 */
export function dialogKeys(onClose?: () => void): (e: React.KeyboardEvent) => void {
  return (e) => {
    if (e.key !== 'Escape' || !onClose) return;
    e.stopPropagation();
    onClose();
  };
}

/** For dialogs not built on `Dialog`: focus the dialog when it opens, so Escape reaches it (and not the app's own Escape). */
export function useModalFocus<T extends HTMLElement>(open = true): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (open && el && !el.contains(document.activeElement)) el.focus();
  }, [open]);
  return ref;
}

export function Dialog({
  title,
  onClose,
  footer,
  children,
  className = '',
  role = 'dialog',
  describedBy,
}: {
  title: ReactNode;
  onClose?: () => void;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  role?: 'dialog' | 'alertdialog';
  describedBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useRef(`dlg-${Math.random().toString(36).slice(2, 8)}`).current;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Focus the first control that asks for it, else the dialog itself.
    const first = el.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
    (first ?? el).focus();
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        ref={ref}
        className={`modal ${className}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        tabIndex={-1}
        onKeyDown={dialogKeys(onClose)}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
              <IconClose />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </div>
  );
}

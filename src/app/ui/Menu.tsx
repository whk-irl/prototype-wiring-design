/**
 * A drop-down menu: a button that opens a list of actions. Keyboard: Enter,
 * Space or Arrow Down opens it and focuses the first item; Arrow Up/Down move;
 * Home/End jump; Escape closes and returns focus to the button. A click
 * outside closes it. The list is drawn over the page (a portal on the body,
 * fixed under its button), so a container that clips or scrolls (the header)
 * cannot hide it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  /** A second, quieter line. */
  detail?: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

export type MenuEntry = MenuItem | { heading: string } | 'separator';

export function Menu({
  label,
  title,
  icon,
  entries,
  className = '',
  align = 'left',
  buttonClass = '',
  hideLabel = false,
}: {
  label: string;
  title?: string;
  icon?: ReactNode;
  entries: MenuEntry[];
  className?: string;
  align?: 'left' | 'right';
  buttonClass?: string;
  hideLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  const items = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];

  useLayoutEffect(() => {
    if (!open) return;
    const at = () => {
      const r = button.current?.getBoundingClientRect();
      if (!r) return;
      setPlace(
        align === 'right'
          ? {
              top: r.bottom + 4,
              right: Math.max(4, window.innerWidth - r.right),
            }
          : { top: r.bottom + 4, left: Math.max(4, r.left) },
      );
    };
    at();
    window.addEventListener('resize', at);
    return () => window.removeEventListener('resize', at);
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    // preventScroll: focusing an item must not scroll whatever holds the button.
    requestAnimationFrame(() => items()[0]?.focus({ preventScroll: true }));
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className={`menu ${className}`} ref={root} onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        className={buttonClass}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={hideLabel ? label : undefined}
        title={title ?? label}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon}
        {!hideLabel && <span className="btn-label">{label}</span>}
        <span className="caret" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div ref={list} className={`menu-list menu-floating menu-${align}`} style={place} role="menu" aria-label={label}>
            {entries.map((entry, k) => {
              if (entry === 'separator') return <div key={k} className="menu-sep" role="separator" />;
              if ('heading' in entry)
                return (
                  <div key={k} className="menu-heading" role="presentation">
                    {entry.heading}
                  </div>
                );
              return (
                <button
                  key={k}
                  type="button"
                  role="menuitem"
                  disabled={entry.disabled}
                  onClick={() => {
                    setOpen(false);
                    entry.onSelect();
                  }}
                >
                  <span className="menu-icon">{entry.icon}</span>
                  <span className="menu-text">
                    <span className="menu-title">{entry.label}</span>
                    {entry.detail && <span className="menu-desc">{entry.detail}</span>}
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

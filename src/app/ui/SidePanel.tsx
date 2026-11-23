/**
 * A side panel the user can resize by dragging its inner edge (or with the
 * arrow keys on the handle; double-click resets) and collapse to a slim rail.
 * Its width and whether it is collapsed are remembered on this PC.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconChevronLeft, IconChevronRight } from './icons';

interface Saved {
  width: number;
  collapsed: boolean;
}

function load(key: string, fallback: Saved): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Saved> | null;
    if (!raw) return fallback;
    return { width: typeof raw.width === 'number' ? raw.width : fallback.width, collapsed: raw.collapsed === true };
  } catch {
    return fallback;
  }
}

function save(key: string, v: Saved): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // remembered for this session only
  }
}

export function SidePanel({
  side,
  label,
  storageKey,
  min,
  max,
  initial,
  children,
}: {
  side: 'left' | 'right';
  label: string;
  storageKey: string;
  min: number;
  max: number;
  initial: number;
  children: ReactNode;
}) {
  const [state, setState] = useState<Saved>(() => {
    const s = load(storageKey, { width: initial, collapsed: false });
    return { ...s, width: Math.min(max, Math.max(min, s.width)) };
  });
  const drag = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => save(storageKey, state), [storageKey, state]);
  const setWidth = (w: number) => setState((s) => ({ ...s, width: Math.round(Math.min(max, Math.max(min, w))) }));
  const sign = side === 'left' ? 1 : -1;
  // Collapsing or expanding swaps the button: the focus moves to the one that replaces it.
  const toggled = useRef(false);
  const swapBtn = useRef<HTMLButtonElement>(null);
  const collapse = (collapsed: boolean) => {
    toggled.current = true;
    setState((s) => ({ ...s, collapsed }));
  };
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    swapBtn.current?.focus();
  }, [state.collapsed]);
  // A width dragged on a wide window must not squeeze the view on a narrow one: at most 35% of the window.
  const [winW, setWinW] = useState(() => (typeof window === 'undefined' ? 1600 : window.innerWidth));
  useEffect(() => {
    const on = () => setWinW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const shownWidth = Math.max(min, Math.min(state.width, Math.round(winW * 0.35)));

  if (state.collapsed)
    return (
      <aside className={`panel panel-${side} collapsed`} aria-label={label}>
        <button ref={swapBtn} type="button" className="icon-btn rail-btn" onClick={() => collapse(false)} title={`Show ${label.toLowerCase()}`} aria-label={`Show ${label.toLowerCase()}`}>
          {side === 'left' ? <IconChevronRight /> : <IconChevronLeft />}
        </button>
      </aside>
    );
  return (
    <aside className={`panel panel-${side}`} aria-label={label} style={{ width: shownWidth }}>
      {children}
      <button ref={swapBtn} type="button" className={`icon-btn collapse-btn collapse-${side}`} onClick={() => collapse(true)} title={`Hide ${label.toLowerCase()}`} aria-label={`Hide ${label.toLowerCase()}`}>
        {side === 'left' ? <IconChevronLeft /> : <IconChevronRight />}
      </button>
      <div
        className={`resizer resizer-${side}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label.toLowerCase()}`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={state.width}
        tabIndex={0}
        title="Drag to resize; double-click to reset"
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, w: state.width };
          document.body.classList.add('resizing');
        }}
        onPointerMove={(e) => {
          if (drag.current) setWidth(drag.current.w + sign * (e.clientX - drag.current.x));
        }}
        onPointerUp={() => {
          drag.current = null;
          document.body.classList.remove('resizing');
        }}
        onPointerCancel={() => {
          drag.current = null;
          document.body.classList.remove('resizing');
        }}
        onDoubleClick={() => setWidth(initial)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 40 : 10;
          if (e.key === 'ArrowLeft') setWidth(state.width - sign * step);
          else if (e.key === 'ArrowRight') setWidth(state.width + sign * step);
          else if (e.key === 'Home') setWidth(min);
          else if (e.key === 'End') setWidth(max);
          else return;
          e.preventDefault();
        }}
      />
    </aside>
  );
}

/** A section of a side panel with a header that collapses it; its body scrolls on its own. */
export function PanelSection({ title, count, children, storageKey, actions }: { title: string; count?: number; children: ReactNode; storageKey: string; actions?: ReactNode }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== 'closed';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, open ? 'open' : 'closed');
    } catch {
      // session only
    }
  }, [storageKey, open]);
  return (
    <section className={`psec${open ? ' open' : ''}`}>
      <div className="psec-head">
        <button type="button" className="psec-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={`chev${open ? ' open' : ''}`} aria-hidden="true" />
          <span className="section-label">{title}</span>
          {count !== undefined && <span className="count">{count}</span>}
        </button>
        {actions && <span className="psec-actions">{actions}</span>}
      </div>
      {open && <div className="psec-body">{children}</div>}
    </section>
  );
}

/**
 * Focus for every modal dialog, whichever way it is built: Tab and Shift+Tab
 * stay inside the open dialog (the last one opened), and when it closes the
 * focus goes back to where it was before it opened. Installed once.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function openModal(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
  return all.length ? all[all.length - 1]! : null;
}

let installed = false;

export function installModalFocus(): () => void {
  if (installed || typeof document === 'undefined') return () => {};
  installed = true;
  const openers: Array<{ modal: HTMLElement; opener: Element | null }> = [];
  let lastFocus: Element | null = document.activeElement;
  const onFocusIn = (e: FocusEvent) => {
    if (!openModal()) lastFocus = e.target as Element;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const modal = openModal();
    if (!modal) return;
    const items = [...modal.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
    if (items.length === 0) {
      e.preventDefault();
      modal.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const inside = modal.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };
  const watch = new MutationObserver(() => {
    const present = new Set(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'));
    for (const m of present) if (!openers.some((o) => o.modal === m)) openers.push({ modal: m, opener: lastFocus });
    for (let i = openers.length - 1; i >= 0; i--) {
      const o = openers[i]!;
      if (present.has(o.modal)) continue;
      openers.splice(i, 1);
      // Back where it was, unless something else already took the focus.
      const active = document.activeElement;
      if ((!active || active === document.body) && o.opener instanceof HTMLElement && o.opener.isConnected) o.opener.focus();
    }
  });
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('keydown', onKey, true);
  watch.observe(document.body, { childList: true, subtree: true });
  return () => {
    installed = false;
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('keydown', onKey, true);
    watch.disconnect();
  };
}

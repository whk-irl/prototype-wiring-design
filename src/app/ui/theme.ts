/**
 * Light and dark themes. The choice is 'system' (follow the operating
 * system), 'light' or 'dark', remembered on this PC. The resolved theme is
 * written to `<html data-theme>`, which the stylesheet keys on, and announced
 * with a `wd-theme` event so the 3D view can follow.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'wiring-design.theme';

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let choice: ThemeChoice = typeof localStorage === 'undefined' ? 'system' : read();
const media = typeof matchMedia === 'undefined' ? null : matchMedia('(prefers-color-scheme: dark)');

export function themeChoice(): ThemeChoice {
  return choice;
}

/** The theme in effect. */
export function resolvedTheme(): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return media?.matches ? 'dark' : 'light';
}

function apply(): void {
  if (typeof document === 'undefined') return;
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  document.documentElement.style.colorScheme = t;
  window.dispatchEvent(new CustomEvent('wd-theme', { detail: t }));
}

export function setThemeChoice(next: ThemeChoice): void {
  choice = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // remembered for this session only
  }
  apply();
}

/** Apply the remembered choice and follow the system while it is 'system'. Call once at start-up. */
export function initTheme(): void {
  apply();
  media?.addEventListener('change', () => {
    if (choice === 'system') apply();
  });
}

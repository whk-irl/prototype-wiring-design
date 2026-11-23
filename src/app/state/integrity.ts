/**
 * The app must never write a design it cannot reopen. In development builds
 * every design change is re-validated with the library and a failure is shown
 * as a visible error. `checkBeforeSave` runs in every build.
 */
import { validateDesign, type Design, type Issue } from '@core';
import { useApp } from './store';

function errorsOf(design: Design): Issue[] {
  return validateDesign(design, useApp.getState().library ?? undefined, useApp.getState().connectorLibrary ?? undefined).filter((i) => i.severity === 'error');
}

let lastReported = '';

export function watchDesignIntegrity(): () => void {
  if (!import.meta.env.DEV) return () => {};
  return useApp.subscribe((s, prev) => {
    if (s.design === prev.design) return;
    const errors = errorsOf(s.design);
    if (errors.length === 0) {
      lastReported = '';
      return;
    }
    const key = errors.map((e) => `${e.path}:${e.message}`).join('|');
    if (key === lastReported) return;
    lastReported = key;
    console.error('Design failed validation after an edit', errors);
    s.notify(
      'error',
      'Internal error: the design no longer passes validation',
      errors.map((e) => `${e.path}: ${e.message}`),
    );
  });
}

/** Errors that would make the saved file unreadable. Empty when it is fine. */
export function checkBeforeSave(design: Design): string[] {
  return errorsOf(design).map((e) => `${e.path}: ${e.message}`);
}

/** `base-1`, `base-2`, ... : the first id of that form not in `taken`. */
export function nextId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const clean = base.replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'item';
  for (let n = 1; ; n++) {
    const id = `${clean}-${n}`;
    if (!set.has(id)) return id;
  }
}

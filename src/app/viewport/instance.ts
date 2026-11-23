/** The single viewport, for code outside React (loaders, keyboard shortcuts). */
import type { Viewport } from './Viewport';

let current: Viewport | null = null;

export function setViewport(v: Viewport | null): void {
  current = v;
}

export function getViewport(): Viewport | null {
  return current;
}

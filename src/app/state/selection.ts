/** Multi-selection logic for meshes. Pure. */

/** Add `id` if absent, remove it if present. */
export function toggleId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/**
 * Everything between `anchor` and `target` in display `order`, inclusive.
 * Falls back to just `target` when the anchor is not in the order.
 */
export function rangeIds(order: readonly string[], anchor: string | null, target: string): string[] {
  const b = order.indexOf(target);
  if (b < 0) return [];
  const a = anchor ? order.indexOf(anchor) : -1;
  if (a < 0) return [target];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return order.slice(lo, hi + 1);
}

/** Within `linkMeshes`, select exactly what is not selected now; keeps selection elsewhere. */
export function invertWithin(linkMeshes: readonly string[], selected: readonly string[]): string[] {
  const inLink = new Set(linkMeshes);
  const sel = new Set(selected);
  return [...selected.filter((id) => !inLink.has(id)), ...linkMeshes.filter((id) => !sel.has(id))];
}

export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function normaliseRect(r: ScreenRect): ScreenRect {
  return { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) };
}

/**
 * Meshes whose projected bounding box lies entirely inside the rectangle.
 * `boxes` gives each mesh's 8 projected corners in the same pixel space;
 * a corner behind the camera (`null`) disqualifies the mesh.
 */
export function idsInRect(rect: ScreenRect, boxes: ReadonlyArray<{ id: string; corners: ReadonlyArray<readonly [number, number] | null> }>): string[] {
  const r = normaliseRect(rect);
  return boxes
    .filter((b) => b.corners.length > 0 && b.corners.every((c) => c !== null && c[0] >= r.x0 && c[0] <= r.x1 && c[1] >= r.y0 && c[1] <= r.y1))
    .map((b) => b.id);
}

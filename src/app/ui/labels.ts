/**
 * Short, distinguishing labels for meshes in lists. CAD exports give every
 * body a long shared prefix ("Assembly 1/...", "robot_asm.") and
 * repeated part names; the mesh ids are unique and numbered ("link", "link_2"),
 * so the label is the id with the prefix every mesh shares removed.
 */
import type { Design } from '@core';

const cache = new WeakMap<object, Map<string, string>>();

/** Longest common prefix, cut back to the last component separator (. / :) so whole names stay. */
export function commonPrefix(ids: readonly string[]): string {
  if (ids.length < 2) {
    const only = ids[0] ?? '';
    const cut = Math.max(only.lastIndexOf('.'), only.lastIndexOf('/'), only.lastIndexOf(':'));
    return cut >= 0 ? only.slice(0, cut + 1) : '';
  }
  let p = ids[0]!;
  for (const id of ids) {
    let i = 0;
    while (i < p.length && i < id.length && p[i] === id[i]) i++;
    p = p.slice(0, i);
  }
  // Cut only between whole name components (the source prefix "x.", a path
  // like "Assembly 1/"), never inside a part name such as "link_2".
  const cut = Math.max(p.lastIndexOf('.'), p.lastIndexOf('/'), p.lastIndexOf(':'));
  return cut >= 0 ? p.slice(0, cut + 1) : '';
}

export function meshLabels(design: Design): Map<string, string> {
  const key = design.scene.links;
  const hit = cache.get(key);
  if (hit) return hit;
  const ids = design.scene.links.flatMap((l) => l.meshes.map((m) => m.id));
  const prefix = commonPrefix(ids);
  const out = new Map<string, string>();
  for (const id of ids) out.set(id, id.slice(prefix.length) || id);
  cache.set(key, out);
  return out;
}

/** Tooltip: full id and the node name in the source file. */
export function meshTooltip(id: string, node: string): string {
  return node && node !== id ? `${id}\n${node}` : id;
}

/**
 * The joint-slack model of a route (`routeSlack`), remembered. It does not
 * depend on the pose shown (it samples every joint's range), so the checks,
 * the drawing and the range check can share one analysis per route, cable
 * envelope and scene. About 4 ms per crossing to compute.
 *
 * With `detour` (the way round the model at a pose, see detour.ts) the
 * result is remembered only once every figure it asked for is known: while
 * some are still being worked out it is worked out again on the next call.
 */
import { routeSlack, type CableEnvelope, type CrossingEnds, type Design, type Route, type RouteSlack } from '@core';

interface Entry {
  scene: Design['scene'];
  slack: RouteSlack;
}

const cache = new WeakMap<Route, Map<string, Entry>>();

/** Lift (half height) and the two bend limits are all the slack model reads from a cable. */
function keyOf(env: CableEnvelope, withDetour: boolean): string {
  return `${env.height_mm / 2}|${env.bend_static_mm}|${env.bend_dynamic_mm ?? ''}|${withDetour ? 'd' : ''}`;
}

export interface SlackDetour {
  /** As core's `RouteSlackOptions.detour_mm`. */
  detour_mm: (after_segment: number, values: Readonly<Record<string, number>>, ends: CrossingEnds) => number | undefined;
  /** After a call: true when some figure is still being worked out (the result is then not remembered). */
  pending: () => boolean;
  /** What the figures depend on beyond the scene (which bodies can be seen): part of the key. */
  key: string;
}

export function slackOf(design: Design, route: Route, env: CableEnvelope, detour?: SlackDetour): RouteSlack {
  let byEnv = cache.get(route);
  if (!byEnv) {
    byEnv = new Map();
    cache.set(route, byEnv);
  }
  const key = `${keyOf(env, !!detour)}|${detour?.key ?? ''}`;
  const hit = byEnv.get(key);
  if (hit && hit.scene === design.scene) return hit.slack;
  const slack = routeSlack(design, route, env.height_mm / 2, {
    bend_static_mm: env.bend_static_mm,
    ...(env.bend_dynamic_mm !== undefined ? { bend_dynamic_mm: env.bend_dynamic_mm } : {}),
    ...(detour ? { detour_mm: detour.detour_mm } : {}),
  });
  if (!detour?.pending()) byEnv.set(key, { scene: design.scene, slack });
  return slack;
}

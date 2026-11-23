/** Display units: joints in degrees (rotary) or mm (prismatic); lengths in mm. */
import type { Joint } from '@core';

export const RAD2DEG = 180 / Math.PI;

export function isRotary(j: Joint): boolean {
  return j.type === 'revolute' || j.type === 'continuous';
}

export function jointUnit(j: Joint): string {
  return isRotary(j) ? '°' : 'mm';
}

/** Internal value (rad or mm) to display value (deg or mm). */
export function toDisplay(j: Joint, v: number): number {
  return isRotary(j) ? v * RAD2DEG : v;
}

export function fromDisplay(j: Joint, v: number): number {
  return isRotary(j) ? v / RAD2DEG : v;
}

/** Slider range in display units. Unlimited rotary joints (continuous) get one full turn each way: -360 to 360 degrees. */
export function displayRange(j: Joint): [number, number] {
  if (j.limit) return [toDisplay(j, j.limit.lower), toDisplay(j, j.limit.upper)];
  return isRotary(j) ? [-360, 360] : [-100, 100];
}

export function fmt(v: number, digits = 1): string {
  const s = v.toFixed(digits);
  return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
}

export function fmtMm(v: number): string {
  const a = Math.abs(v);
  return fmt(v, a >= 1000 ? 0 : a >= 10 ? 1 : 2);
}

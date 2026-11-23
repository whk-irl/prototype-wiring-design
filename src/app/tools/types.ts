/**
 * The tool seam. The viewport forwards pointer and key events to exactly one
 * active tool, with the ray hit already resolved against the BVHs. Selection
 * is itself a tool (`selectTool.ts`); zone painting and part placement plug in
 * the same way.
 *
 * Coordinates: `world` is the scene frame (Z up, mm). `link` is the frame of
 * the link the hit mesh belongs to, which is the frame the design stores
 * zones, components and routes in.
 */
import type { Ray, Vector2, Vector3 } from 'three';
import type { useApp } from '../state/store';
import type { registry } from '../scene/registry';
import type { Viewport } from '../viewport/Viewport';

export interface RayHit {
  meshId: string;
  linkId: string;
  /** Triangle index in the mesh's original index order (zones use this). */
  triangle: number;
  distance: number;
  world: { point: Vector3; normal: Vector3 };
  link: { point: Vector3; normal: Vector3 };
  /** In the mesh's imported frame (`MeshRef.pose` undone): what BVH and triangle queries use. */
  local: { point: Vector3; normal: Vector3 };
}

export interface ToolPointerEvent {
  native: PointerEvent | MouseEvent;
  /** Normalised device coordinates of the pointer (-1..1). */
  ndc: Vector2;
  /** World-space ray under the pointer. */
  ray: Ray;
  /** First mesh hit, or null. Computed lazily on first access. */
  readonly hit: RayHit | null;
}

export interface ToolContext {
  viewport: Viewport;
  store: typeof useApp;
  registry: typeof registry;
}

export interface Tool {
  readonly id: string;
  readonly label: string;
  /** CSS cursor while the tool is active. */
  readonly cursor?: string;
  activate?(ctx: ToolContext): void;
  deactivate?(ctx: ToolContext): void;
  /** Return true to capture the pointer: camera controls stay off until pointer up. */
  onPointerDown?(e: ToolPointerEvent, ctx: ToolContext): boolean | void;
  /** Hover moves (no button) and drags the tool captured. */
  onPointerMove?(e: ToolPointerEvent, ctx: ToolContext): void;
  onPointerUp?(e: ToolPointerEvent, ctx: ToolContext): void;
  onPointerLeave?(ctx: ToolContext): void;
  /** A captured gesture was interrupted (pointercancel, lost capture). Defaults to onPointerUp. */
  onPointerCancel?(ctx: ToolContext): void;
  /** Press and release without dragging (camera did not move). */
  onClick?(e: ToolPointerEvent, ctx: ToolContext): void;
  onDoubleClick?(e: ToolPointerEvent, ctx: ToolContext): void;
  /** Return true if the key was handled (global shortcuts then skip it). */
  onKeyDown?(e: KeyboardEvent, ctx: ToolContext): boolean | void;
  /** Link poses changed (joint preview, undo, new model). */
  onPoseChanged?(ctx: ToolContext): void;
}

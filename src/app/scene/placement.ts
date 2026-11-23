/**
 * Where meshes sit. The design, not the import, decides which link a mesh
 * belongs to and where its imported geometry sits in that link's frame
 * (`MeshRef.pose`; absent = identity):
 *
 *   point in link frame = pose * imported vertex
 *
 * Imported geometry and its BVH are never modified; everything that works in
 * a link frame goes through these helpers. Pure: no DOM, no renderer.
 */
import { Matrix3, Matrix4, Vector3, type Intersection } from 'three';
import { meshPoseMatrix, type Design, type MeshRef } from '@core';

export interface MeshPlacement {
  link: string;
  ref: MeshRef;
  /** Imported (mesh-local) frame -> link frame. */
  pose: Matrix4;
}

const cache = new WeakMap<object, Map<string, MeshPlacement>>();

/** Mesh id -> link and pose, from the design. Cached per `scene.links` array. */
export function meshPlacements(design: Design): Map<string, MeshPlacement> {
  const key = design.scene.links;
  let map = cache.get(key);
  if (map) return map;
  map = new Map();
  for (const link of design.scene.links) {
    for (const ref of link.meshes) map.set(ref.id, { link: link.id, ref, pose: meshPoseMatrix(ref) });
  }
  cache.set(key, map);
  return map;
}

export interface ResolvedHit {
  triangle: number;
  distance: number;
  world: { point: Vector3; normal: Vector3 };
  link: { point: Vector3; normal: Vector3 };
  /** In the mesh's imported frame: what the BVH and the triangle data use. */
  local: { point: Vector3; normal: Vector3 };
}

/**
 * Express a raycast intersection with a mesh in world, link and mesh-local
 * frames. `meshWorld` is the mesh object's world matrix (link world * pose),
 * `linkWorld` its link group's world matrix. `face.normal` from three.js is
 * in the mesh-local frame.
 */
export function resolveHit(hit: Pick<Intersection, 'point' | 'distance' | 'faceIndex' | 'face'>, meshWorld: Matrix4, linkWorld: Matrix4): ResolvedHit | null {
  if (hit.faceIndex == null || !hit.face) return null;
  const localNormal = hit.face.normal.clone().normalize();
  const localPoint = hit.point.clone().applyMatrix4(new Matrix4().copy(meshWorld).invert());
  const linkPoint = hit.point.clone().applyMatrix4(new Matrix4().copy(linkWorld).invert());
  const meshInLink = new Matrix4().copy(linkWorld).invert().multiply(meshWorld);
  const linkNormal = localNormal.clone().applyMatrix3(new Matrix3().getNormalMatrix(meshInLink)).normalize();
  const worldNormal = localNormal.clone().applyMatrix3(new Matrix3().getNormalMatrix(meshWorld)).normalize();
  return {
    triangle: hit.faceIndex,
    distance: hit.distance,
    world: { point: hit.point.clone(), normal: worldNormal },
    link: { point: linkPoint, normal: linkNormal },
    local: { point: localPoint, normal: localNormal },
  };
}

/// <reference lib="webworker" />
/** Builds an indirect MeshBVH off the main thread and sends back its buffers. */
import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

interface Request {
  id: number;
  position: Float32Array;
  index: Uint32Array | Uint16Array;
}

self.onmessage = (e: MessageEvent<Request>) => {
  const { id, position, index } = e.data;
  try {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(position, 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    const bvh = new MeshBVH(geometry, { indirect: true });
    const s = MeshBVH.serialize(bvh, { cloneBuffers: false });
    const indirect = s.indirectBuffer as Uint32Array | Uint16Array | null;
    const transfer: ArrayBuffer[] = [...(s.roots as ArrayBuffer[])];
    if (indirect) transfer.push(indirect.buffer as ArrayBuffer);
    (self as unknown as Worker).postMessage({ id, roots: s.roots, indirectBuffer: indirect }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};

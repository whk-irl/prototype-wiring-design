/**
 * BVH construction for picking. Every mesh gets an *indirect* BVH so the
 * index buffer keeps its original triangle order: zones address triangles by
 * index, so the BVH must never reorder them.
 *
 * Small meshes are built on the main thread between frames; large ones in a
 * small pool of workers so loading stays responsive.
 */
import { BufferGeometry, Mesh } from 'three';
import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree, type SerializedBVH } from 'three-mesh-bvh';

// Accelerated raycast for every mesh; it falls back to the brute-force path
// when a geometry has no boundsTree.
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

/** Triangle count above which a mesh is handed to a worker. */
const WORKER_THRESHOLD = 30_000;
/** Main-thread triangle budget per slice before yielding to the browser. */
const SLICE_TRIANGLES = 60_000;

interface Job {
  geometry: BufferGeometry;
  triCount: number;
}

interface WorkerReply {
  id: number;
  roots?: ArrayBuffer[];
  indirectBuffer?: Uint32Array | Uint16Array;
  error?: string;
}

class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Array<() => void> = [];
  private seq = 0;

  constructor(private size: number) {}

  private take(): Promise<Worker> {
    const w = this.idle.pop();
    if (w) return Promise.resolve(w);
    if (this.workers.length < this.size) {
      const worker = new Worker(new URL('./bvh.worker.ts', import.meta.url), { type: 'module' });
      this.workers.push(worker);
      return Promise.resolve(worker);
    }
    return new Promise((resolve) => this.queue.push(() => resolve(this.idle.pop()!)));
  }

  private release(w: Worker): void {
    this.idle.push(w);
    this.queue.shift()?.();
  }

  async build(geometry: BufferGeometry): Promise<MeshBVH> {
    const worker = await this.take();
    const id = ++this.seq;
    const position = (geometry.getAttribute('position').array as Float32Array).slice();
    const index = geometry.getIndex()!.array.slice() as Uint32Array | Uint16Array;
    try {
      const reply = await new Promise<WorkerReply>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<WorkerReply>) => {
          if (e.data.id === id) resolve(e.data);
        };
        worker.onerror = (e) => reject(new Error(e.message || 'BVH worker failed'));
        worker.postMessage({ id, position, index }, [position.buffer, index.buffer]);
      });
      if (reply.error || !reply.roots) throw new Error(reply.error ?? 'BVH worker returned nothing');
      const data: SerializedBVH = {
        version: 1,
        roots: reply.roots,
        index: geometry.getIndex()!.array as Uint32Array,
        indirectBuffer: reply.indirectBuffer ?? null,
      } as unknown as SerializedBVH;
      return MeshBVH.deserialize(data, geometry, { setIndex: false });
    } finally {
      this.release(worker);
    }
  }
}

let pool: WorkerPool | null = null;
function getPool(): WorkerPool {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  pool ??= new WorkerPool(Math.max(1, Math.min(4, cores - 1)));
  return pool;
}

const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Build a BVH for each job. `onDone` fires per job as soon as its BVH is set.
 * `cancelled` is polled so a newer import can abandon an older build.
 */
export async function buildBVHs<T extends Job>(
  jobs: readonly T[],
  onDone: (job: T) => void,
  cancelled: () => boolean,
): Promise<void> {
  const big = jobs.filter((j) => j.triCount >= WORKER_THRESHOLD && j.geometry.getIndex());
  const small = jobs.filter((j) => !big.includes(j));

  const workerPart = Promise.all(
    big.map(async (job) => {
      try {
        const bvh = await getPool().build(job.geometry);
        if (cancelled()) return;
        job.geometry.boundsTree = bvh;
      } catch (e) {
        // Fall back to the main thread rather than leave the mesh unpickable.
        console.warn('BVH worker failed, building on the main thread', e);
        if (cancelled()) return;
        job.geometry.computeBoundsTree({ indirect: true });
      }
      onDone(job);
    }),
  );

  let budget = 0;
  for (const job of small) {
    if (cancelled()) return;
    job.geometry.computeBoundsTree({ indirect: true });
    onDone(job);
    budget += job.triCount;
    if (budget > SLICE_TRIANGLES) {
      budget = 0;
      await nextFrame();
    }
  }
  await workerPart;
}

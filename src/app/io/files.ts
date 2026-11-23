/** Getting files from the user (picker, drag and drop) and giving files back (download). */
import type { ImportFile } from '../ingest/types';

/** Open the browser file picker. Resolves with [] if the user cancels. */
export function pickFiles(opts: { multiple?: boolean; directory?: boolean; accept?: string } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = opts.multiple ?? true;
    if (opts.accept) input.accept = opts.accept;
    if (opts.directory) input.webkitdirectory = true;
    input.style.display = 'none';
    let settled = false;
    const done = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}

/** Read picked files. Paths are relative to the picked folder, forward slashes. */
export async function readFiles(files: readonly File[]): Promise<ImportFile[]> {
  return Promise.all(
    files.map(async (f) => ({
      path: normalisePath(f.webkitRelativePath || f.name),
      data: await f.arrayBuffer(),
    })),
  );
}

/**
 * Read everything dropped: files and whole folders. Must be called
 * synchronously inside the drop handler (the DataTransfer is cleared after).
 */
export function readDataTransfer(dt: DataTransfer): Promise<ImportFile[]> {
  const entries: FileSystemEntry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) loose.push(f);
    }
  }
  return (async () => {
    const out: ImportFile[] = await readFiles(loose);
    for (const e of entries) await walk(e, out);
    return out;
  })();
}

async function walk(entry: FileSystemEntry, out: ImportFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ path: normalisePath(entry.fullPath || file.name), data: await file.arrayBuffer() });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most ~100 entries per call.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, out);
    }
  }
}

export function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.?\/+/, '');
}

export function baseName(p: string): string {
  const parts = normalisePath(p).split('/');
  return parts[parts.length - 1] ?? p;
}

export function downloadText(fileName: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Offer bytes as a file download. */
export function downloadBytes(fileName: string, data: ArrayBuffer, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

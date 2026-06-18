import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";

// Atomic file write: write to a temp file in the same directory, then rename(2) over
// the target. rename is atomic on a POSIX filesystem, so a crash / full disk mid-write
// can never leave a half-written (truncated) file — a reader sees either the old
// complete content or the new complete content, never a partial one. The temp file
// must share the target's directory so the rename stays on a single filesystem.
//
// `mode` is applied to the temp file and preserved by rename, so secret state files
// keep their restrictive permissions (e.g. 0o600) and never briefly exist world-readable.

type AtomicWriteOptions = { mode?: number };

export async function atomicWrite(absolutePath: string, data: string | Buffer, options?: AtomicWriteOptions): Promise<void> {
  const tempPath = `${absolutePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tempPath, data, options?.mode !== undefined ? { mode: options.mode } : undefined);
    await rename(tempPath, absolutePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function atomicWriteSync(absolutePath: string, data: string | Buffer, options?: AtomicWriteOptions): void {
  const tempPath = `${absolutePath}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tempPath, data, options?.mode !== undefined ? { mode: options.mode } : undefined);
    renameSync(tempPath, absolutePath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

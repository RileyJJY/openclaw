// Shared filesystem helpers for plugin doctor legacy-state migrations.
import fs from "node:fs/promises";
import { readFileHandleBounded } from "@openclaw/fs-safe/advanced";

/** Bound the existing-archive byte comparison so a huge prior snapshot cannot
 * force an unbounded allocation during a later migration. */
const ARCHIVE_COMPARE_MAX_BYTES = 64 * 1024 * 1024;

/** True when the legacy-state path exists and is a regular file. */
export async function legacyStateFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Renames a migrated legacy source to `<path>.migrated`, recording the outcome in the
 * doctor changes/warnings lists. Never throws: a failed archive leaves the source in
 * place so a later doctor run can retry without losing migrated data.
 */
export async function archiveLegacyStateSource(params: {
  filePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  try {
    if (await legacyStateFileExists(archivedPath)) {
      // Import commits before archival, so an existing archive must converge
      // instead of re-warning every startup (#102749): identical bytes already
      // preserve the snapshot; differing bytes archive under a free suffix.
      const [sourceStat, archiveStat] = await Promise.all([
        fs.stat(params.filePath),
        fs.stat(archivedPath),
      ]);
      if (
        sourceStat.isFile() &&
        archiveStat.isFile() &&
        sourceStat.size === archiveStat.size &&
        sourceStat.size <= ARCHIVE_COMPARE_MAX_BYTES
      ) {
        const [sourceResult, archiveResult] = await Promise.all([
          readArchiveComparisonFile(params.filePath),
          readArchiveComparisonFile(archivedPath),
        ]);
        if (sourceResult !== null && archiveResult !== null && sourceResult.equals(archiveResult)) {
          await fs.rm(params.filePath, { force: true });
          params.changes.push(
            `Removed already-archived ${params.label} legacy source ${params.filePath}`,
          );
          return;
        }
      }
      const nextArchivePath = await firstFreeArchivePath(params.filePath);
      await fs.rename(params.filePath, nextArchivePath);
      params.changes.push(`Archived ${params.label} legacy source -> ${nextArchivePath}`);
      return;
    }
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived ${params.label} legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving ${params.label} legacy source: ${String(err)}`);
  }
}

/**
 * Reads a legacy source or archive for collision comparison. Unlike the bounded
 * migration read, this intentionally follows legacy symlinks to preserve the
 * historical archive-convergence behavior while keeping the comparison bounded.
 */
async function readArchiveComparisonFile(filePath: string): Promise<Buffer | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > ARCHIVE_COMPARE_MAX_BYTES) {
      return null;
    }
    try {
      return await readFileHandleBounded(handle, ARCHIVE_COMPARE_MAX_BYTES);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("file exceeds limit of")) {
        return null;
      }
      throw err;
    }
  } finally {
    await handle?.close();
  }
}

async function firstFreeArchivePath(sourcePath: string): Promise<string> {
  for (let index = 2; ; index++) {
    const candidate = `${sourcePath}.migrated.${index}`;
    if (!(await legacyStateFileExists(candidate))) {
      return candidate;
    }
  }
}

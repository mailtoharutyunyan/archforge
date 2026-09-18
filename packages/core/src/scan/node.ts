/**
 * Node filesystem adapter for the scanners.
 *
 * This is the only file in the scanning path that knows `node:fs` exists.
 * Everything that decides *what a dependency is* lives in the host-agnostic
 * detectors, so the browser and the CLI cannot disagree about a repository.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { scanRepository, type RepositoryScan, type ScannerOptions } from './registry.ts';
import { IGNORED_DIRS, isScannable, type FileSource, type SourceFileRef } from './source.ts';

export interface NodeSourceOptions {
  /** Follow symlinked directories. Off by default: cycles and escapes. */
  readonly followSymlinks?: boolean;
}

/**
 * A `FileSource` over a real directory. Paths handed to the detectors are
 * always repo-root-relative and POSIX-style, so evidence in a report is
 * identical whichever machine produced it.
 */
export function nodeFileSource(root: string, options: NodeSourceOptions = {}): FileSource {
  const absoluteRoot = resolve(root);
  let cached: readonly SourceFileRef[] | undefined;

  const toPosix = (path: string): string => path.split(sep).join('/');

  const walk = async (dir: string, rel: string, found: SourceFileRef[]): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory: skip rather than abort the whole scan.
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const childAbs = join(dir, entry.name);

      if (entry.isSymbolicLink() && !options.followSymlinks) continue;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.includes(entry.name)) continue;
        await walk(childAbs, childRel, found);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isScannable(childRel)) continue;

      try {
        const info = await stat(childAbs);
        // Oversized files are still listed; the analyser decides to skip them
        // so that the reason appears in the report rather than vanishing here.
        found.push({ path: toPosix(childRel), size: info.size });
      } catch {
        // Raced away between readdir and stat; ignore.
      }
    }
  };

  return {
    async list() {
      if (cached) return cached;
      const found: SourceFileRef[] = [];
      await walk(absoluteRoot, '', found);
      cached = found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return cached;
    },
    async read(path: string) {
      try {
        return await readFile(join(absoluteRoot, ...path.split('/')), 'utf8');
      } catch {
        return '';
      }
    },
  };
}

export interface ScanRepoOptions extends ScannerOptions {
  readonly root: string;
  readonly followSymlinks?: boolean;
}

/**
 * Convenience wrapper: scan a directory on disk with every registered scanner,
 * whatever languages it happens to contain.
 */
export async function scanRepo(options: ScanRepoOptions): Promise<RepositoryScan> {
  const source = nodeFileSource(options.root, { followSymlinks: options.followSymlinks });
  return scanRepository(source, {
    include: options.include,
    maxFileBytes: options.maxFileBytes,
    scanners: options.scanners,
  });
}

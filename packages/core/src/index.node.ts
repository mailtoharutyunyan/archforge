/**
 * Node-only API: everything that touches a filesystem.
 *
 * Kept separate from `index.ts` so importing the engine in a browser can never
 * accidentally pull in `node:fs`. The static web build imports `index.ts`
 * only, which is why it can be hosted on GitHub Pages with no server.
 */

export * from './index.ts';

export { scanJava } from './scan/java.ts';
export type { ScanOptions } from './scan/java.ts';
export { scanPolyglot } from './scan/polyglot.ts';
export { merge, scanRepository, SCANNERS } from './scan/registry.ts';
export type { RepositoryScan, Scanner, ScannerOptions } from './scan/registry.ts';
export { nodeFileSource, scanRepo } from './scan/node.ts';
export type { NodeSourceOptions, ScanRepoOptions } from './scan/node.ts';
export {
  basenameOf,
  fileSourceFromFileList,
  isIgnoredPath,
  isScannable,
  languageOf,
  MemoryFileSource,
  normalizePath,
} from './scan/source.ts';
export type { FileSource, SourceFileRef } from './scan/source.ts';
export type {
  ExternalSubtype,
  InferredComponent,
  InferredExternal,
  InferredRelation,
  InferredSignal,
  ScanResult,
} from './scan/types.ts';

export { detectDrift } from './drift/drift.ts';
export type { DriftFinding, DriftOptions, DriftReport } from './drift/drift.ts';

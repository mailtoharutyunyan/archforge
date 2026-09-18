/**
 * File access abstraction for repository scanning.
 *
 * The scanners' detectors are the valuable part and they must exist exactly
 * once. They run in two very different hosts:
 *
 *   - the CLI, over a real directory on disk
 *   - the browser, over a folder the user dragged onto the page
 *
 * The browser case is not a nicety: it means "analyse my repository" works on
 * a static site with no backend, so source code never leaves the user's
 * machine. That is only affordable if the detectors are host-agnostic, which
 * is what this interface buys.
 */

export interface SourceFileRef {
  /** Repository-root-relative, POSIX separators, no leading `./`. */
  readonly path: string;
  readonly size: number;
}

export interface FileSource {
  /** Every candidate file, already filtered and in deterministic path order. */
  list(): Promise<readonly SourceFileRef[]>;
  read(path: string): Promise<string>;
}

/** Directory names never worth scanning, whatever the language. */
export const IGNORED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'target',
  'build',
  'dist',
  'out',
  'bin',
  'obj',
  '.gradle',
  '.mvn',
  '.idea',
  '.vscode',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'vendor',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.venv',
  'venv',
  'env',
  'coverage',
  'htmlcov',
  '.terraform',
  'Pods',
  'DerivedData',
];

export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

/**
 * Source extensions across the languages we detect. Deliberately broad: the
 * cost of listing a file we have no detector for is one `classify` miss, while
 * the cost of not listing it is a silent blind spot in someone's repository.
 */
export const SOURCE_EXTENSIONS: readonly string[] = [
  // JVM
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.groovy',
  // JavaScript / TypeScript
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.svelte',
  '.vue',
  // Python
  '.py',
  '.pyi',
  // Go, Rust, C#, JVM-adjacent and others
  '.go',
  '.rs',
  '.cs',
  '.fs',
  '.vb',
  '.rb',
  '.php',
  '.ex',
  '.exs',
  '.erl',
  '.dart',
  '.swift',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.m',
  '.mm',
  '.pl',
  '.lua',
  '.sh',
];

/** Configuration, manifest and infrastructure formats. */
export const CONFIG_EXTENSIONS: readonly string[] = [
  '.properties',
  '.yml',
  '.yaml',
  '.json',
  '.toml',
  '.ini',
  '.conf',
  '.cfg',
  '.xml',
  '.gradle',
  '.tf',
  '.tfvars',
  '.hcl',
  '.env',
  '.sql',
  '.proto',
  '.graphql',
  '.csproj',
  '.fsproj',
  '.sbt',
];

/**
 * Files with no useful extension that still carry architecture information.
 * Matched on basename, case-insensitively.
 */
export const SIGNIFICANT_BASENAMES: readonly string[] = [
  'dockerfile',
  'containerfile',
  'makefile',
  'procfile',
  'go.mod',
  'go.sum',
  'requirements.txt',
  'requirements-dev.txt',
  'pipfile',
  'gemfile',
  'cargo.toml',
  'pyproject.toml',
  'package.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'chart.yaml',
  'values.yaml',
  'skaffold.yaml',
  'serverless.yml',
  'serverless.yaml',
  'schema.prisma',
];

export const SCANNABLE_EXTENSIONS: readonly string[] = [
  ...SOURCE_EXTENSIONS,
  ...CONFIG_EXTENSIONS,
];

export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function isIgnoredPath(path: string): boolean {
  return path.split('/').some((segment) => IGNORED_DIRS.includes(segment));
}

export function isScannable(path: string): boolean {
  const base = basenameOf(path).toLowerCase();
  if (SIGNIFICANT_BASENAMES.includes(base)) return true;
  if (base.startsWith('dockerfile')) return true;
  return SCANNABLE_EXTENSIONS.some((extension) => base.endsWith(extension));
}

/** Normalises any host path into the canonical repo-relative form. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Best-effort language label for a path. Used to attribute detections and to
 * report which stacks a repository actually contains.
 */
export function languageOf(path: string): string | undefined {
  const base = basenameOf(path).toLowerCase();
  if (base.startsWith('dockerfile') || base === 'containerfile') return 'docker';
  if (base === 'go.mod' || base === 'go.sum') return 'go';
  if (base === 'package.json' || base === 'schema.prisma') return 'javascript';
  if (base === 'requirements.txt' || base === 'pyproject.toml' || base === 'pipfile') return 'python';
  if (base === 'pom.xml' || base.startsWith('build.gradle')) return 'jvm';
  if (base === 'cargo.toml') return 'rust';
  if (base === 'gemfile') return 'ruby';

  const dot = base.lastIndexOf('.');
  const extension = dot < 0 ? '' : base.slice(dot);
  switch (extension) {
    case '.java':
    case '.kt':
    case '.kts':
    case '.scala':
    case '.groovy':
      return 'jvm';
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
    case '.svelte':
    case '.vue':
      return 'javascript';
    case '.py':
    case '.pyi':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.cs':
    case '.fs':
    case '.vb':
      return 'dotnet';
    case '.rb':
      return 'ruby';
    case '.php':
      return 'php';
    case '.ex':
    case '.exs':
      return 'elixir';
    case '.tf':
    case '.tfvars':
    case '.hcl':
      return 'terraform';
    case '.yml':
    case '.yaml':
      return 'yaml';
    default:
      return undefined;
  }
}

/**
 * In-memory source, used by the browser (from a `FileList` or the File System
 * Access API) and by tests. Also the simplest way to keep the Node path
 * honest: a detector that only works against `node:fs` fails here immediately.
 */
export class MemoryFileSource implements FileSource {
  readonly #files: Map<string, string>;

  constructor(files: Readonly<Record<string, string>> | Map<string, string>) {
    this.#files = new Map(
      [...(files instanceof Map ? files.entries() : Object.entries(files))].map(
        ([path, text]) => [normalizePath(path), text],
      ),
    );
  }

  async list(): Promise<readonly SourceFileRef[]> {
    return [...this.#files.entries()]
      .filter(([path]) => !isIgnoredPath(path) && isScannable(path))
      .map(([path, text]) => ({ path, size: text.length }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async read(path: string): Promise<string> {
    return this.#files.get(normalizePath(path)) ?? '';
  }
}

/**
 * Builds a source from browser `File` objects, e.g. from a drop event or an
 * `<input type="file" webkitdirectory>`. Kept here rather than in the web
 * package so the browser entry point stays trivial.
 */
export function fileSourceFromFileList(
  files: readonly {
    readonly name: string;
    readonly size: number;
    readonly text: () => Promise<string>;
    readonly webkitRelativePath?: string;
  }[],
  options: { maxFileBytes?: number } = {},
): FileSource {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const byPath = new Map<string, (typeof files)[number]>();

  for (const file of files) {
    const raw =
      file.webkitRelativePath && file.webkitRelativePath !== ''
        ? file.webkitRelativePath
        : file.name;
    const path = stripLeadingDir(normalizePath(raw));
    if (isIgnoredPath(path) || !isScannable(path)) continue;
    if (file.size > maxFileBytes) continue;
    byPath.set(path, file);
  }

  return {
    async list() {
      return [...byPath.entries()]
        .map(([path, file]) => ({ path, size: file.size }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
    async read(path: string) {
      const file = byPath.get(normalizePath(path));
      return file ? await file.text() : '';
    },
  };
}

/**
 * Drag-and-drop yields paths prefixed with the dropped folder's own name.
 * Removing it makes `source "services/payment-api"` bindings in the DSL match
 * regardless of what the user called their checkout directory.
 */
function stripLeadingDir(path: string): string {
  const slash = path.indexOf('/');
  return slash > 0 ? path.slice(slash + 1) : path;
}

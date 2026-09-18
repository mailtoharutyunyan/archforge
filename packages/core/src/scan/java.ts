/**
 * Java / Spring repository scanner.
 *
 * Pure heuristics over text: no Java parser, no dependencies. Each detector
 * looks for one idiom, records *where* it saw it, and states how sure it is
 * as a `Confidence` class. Nothing here fabricates a numeric score.
 *
 * Determinism contract: files are visited in sorted order, every id is derived
 * from names in the code (never from host paths), every output array is sorted
 * by id, and evidence paths are repo-relative POSIX. Two runs over the same tree
 * on two machines are byte-identical.
 *
 * Coverage is honest about its limits: comment lines (`//`, `*`) are ignored,
 * but a detector can still be fooled by an annotation inside a string literal
 * or a multi-line block comment without leading asterisks.
 */

import type { FileSource } from './source.ts';
import type { Confidence, Evidence } from '../model/types.ts';
import { CONFIDENCE_ORDER } from '../model/types.ts';
import { compareIds, slug, sortBy } from '../util/canonical.ts';
import type {
  DetectorInfo,
  ExternalSubtype,
  InferredComponent,
  InferredDirection,
  InferredExternal,
  InferredProvenance,
  InferredRelation,
  InferredSignal,
  ScanResult,
} from './types.ts';

export interface ScanOptions {
  /** Optional repo-relative path prefixes to restrict the scan to. */
  include?: readonly string[];
  /** Files larger than this are skipped and listed in `skippedFiles`. Default 512 KiB. */
  maxFileBytes?: number;
}

export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

/** Directory names that never contain source we should reason about. */
const SKIP_SEGMENTS: ReadonlySet<string> = new Set([
  'target',
  'build',
  'node_modules',
  '.git',
  'test',
  'generated',
]);

const SNIPPET_MAX = 160;
const HTTP_URL_WINDOW = 10;
const ANNOTATION_WINDOW = 8;

/** Registry of detectors with their nominal confidence class. */
export const DETECTORS: readonly DetectorInfo[] = [
  { id: 'spring/rest-controller', confidence: 'high', description: '@RestController / @Controller -> api component' },
  { id: 'spring/service', confidence: 'high', description: '@Service -> service component' },
  { id: 'spring/repository', confidence: 'high', description: '@Repository -> service component' },
  { id: 'spring/configuration', confidence: 'high', description: '@Configuration -> configuration component' },
  { id: 'spring/component', confidence: 'high', description: '@Component -> component' },
  { id: 'jpa/entity', confidence: 'high', description: '@Entity -> persistence signal' },
  { id: 'kafka/listener', confidence: 'high', description: '@KafkaListener(topics=...) -> inbound topic (medium when the topic is an unresolved placeholder)' },
  { id: 'kafka/producer', confidence: 'high', description: 'KafkaTemplate + .send("topic") -> outbound topic (medium when the topic cannot be resolved)' },
  { id: 'feign/client', confidence: 'high', description: '@FeignClient(name=...) -> outbound HTTP/Feign system' },
  { id: 'http/client', confidence: 'medium', description: 'RestTemplate / WebClient / RestClient -> outbound HTTP; host from adjacent literals' },
  { id: 'jdbc/datasource', confidence: 'high', description: 'spring.datasource.url -> database with engine (medium for JdbcTemplate/DataSource usage associated across files)' },
  { id: 'redis/client', confidence: 'high', description: 'RedisTemplate / StringRedisTemplate -> cache (medium for starter dependency or spring.redis.* config)' },
  { id: 'mongo/client', confidence: 'high', description: 'MongoTemplate / MongoRepository -> database (medium for spring.data.mongodb.* config)' },
  { id: 'compose/service', confidence: 'medium', description: 'docker-compose services with well-known images -> external dependencies' },
];

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

type FileKind = 'java' | 'config' | 'compose' | 'build';

const COMPOSE_NAME = /^(?:docker-)?compose(?:[.-][\w-]+)?\.ya?ml$/;
const BUILD_NAMES: ReadonlySet<string> = new Set(['pom.xml', 'build.gradle', 'build.gradle.kts']);

function classify(relPath: string): FileKind | undefined {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  if (base.endsWith('.java')) return 'java';
  if (COMPOSE_NAME.test(base)) return 'compose';
  if (BUILD_NAMES.has(base)) return 'build';
  if (base.endsWith('.properties') || base.endsWith('.yml') || base.endsWith('.yaml')) return 'config';
  return undefined;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

function normalizePrefix(prefix: string): string {
  return toPosix(prefix).replace(/^\.\//, '').replace(/\/+$/, '');
}

function underPrefix(relPath: string, prefix: string): boolean {
  return prefix === '' || relPath === prefix || relPath.startsWith(`${prefix}/`);
}

interface Discovered {
  readonly files: string[];
  readonly skipped: string[];
}

/**
 * Selects the files to analyse from whatever the host offers.
 *
 * Filtering lives here rather than in the `FileSource` so that both hosts —
 * a directory on disk and a folder dropped onto a web page — apply exactly the
 * same skip rules, size limits and include prefixes, and therefore produce
 * exactly the same result for the same repository.
 */
async function discover(
  source: FileSource,
  include: readonly string[],
  maxFileBytes: number,
): Promise<Discovered> {
  const files: string[] = [];
  const skipped: string[] = [];

  for (const ref of await source.list()) {
    const rel = toPosix(ref.path).replace(/^\.\//, '');
    if (rel.split('/').some((segment) => SKIP_SEGMENTS.has(segment))) continue;
    if (include.length > 0 && !include.some((prefix) => underPrefix(rel, prefix))) continue;
    if (classify(rel) === undefined) continue;
    if (ref.size > maxFileBytes) {
      skipped.push(rel);
      continue;
    }
    files.push(rel);
  }

  return { files: files.sort(compareIds), skipped: skipped.sort(compareIds) };
}

/**
 * The build module a file belongs to: everything before `/src/`, else the
 * file's directory. `''` means the scan root itself.
 */
function moduleOf(relPath: string): string {
  const idx = relPath.indexOf('/src/');
  if (idx >= 0) return relPath.slice(0, idx);
  if (relPath.startsWith('src/')) return '';
  const slash = relPath.lastIndexOf('/');
  return slash < 0 ? '' : relPath.slice(0, slash);
}

function moduleId(module: string): string {
  return `module-${slug(module) || 'root'}`;
}

// ---------------------------------------------------------------------------
// Accumulator with deterministic merging
// ---------------------------------------------------------------------------

interface Fact {
  detector: string;
  confidence: Confidence;
  evidence: Evidence[];
}

interface ExternalAcc extends Fact {
  id: string;
  name: string;
  subtype: ExternalSubtype;
  technology?: string;
  unresolved?: boolean;
}

interface RelationAcc extends Fact {
  /** Either a final id (`module-x`, external id) or `unit:<file>` to be resolved later. */
  sourceRef: string;
  destRef: string;
  direction: InferredDirection;
  technology?: string;
  description?: string;
}

interface ComponentAcc extends Fact {
  file: string;
  module: string;
  className: string;
  subtype: string;
  technology?: string;
}

interface SignalAcc extends Fact {
  className: string;
  module: string;
  technology?: string;
}

function compareEvidence(a: Evidence, b: Evidence): number {
  const byFile = compareIds(a.file, b.file);
  if (byFile !== 0) return byFile;
  if (a.line !== b.line) return a.line - b.line;
  return compareIds(a.snippet, b.snippet);
}

function dedupeEvidence(evidence: readonly Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const e of [...evidence].sort(compareEvidence)) {
    const key = `${e.file}:${e.line}:${e.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** Merge a repeated observation: union the evidence, keep the strongest detector. */
function mergeFact(into: Fact, from: Fact): void {
  into.evidence.push(...from.evidence);
  const better =
    CONFIDENCE_ORDER[from.confidence] > CONFIDENCE_ORDER[into.confidence] ||
    (from.confidence === into.confidence && compareIds(from.detector, into.detector) < 0);
  if (better) {
    into.confidence = from.confidence;
    into.detector = from.detector;
  }
}

function provenanceOf(fact: Fact): InferredProvenance {
  return {
    source: 'inferred',
    detector: fact.detector,
    confidence: fact.confidence,
    evidence: dedupeEvidence(fact.evidence),
  };
}

class Accumulator {
  readonly externals = new Map<string, ExternalAcc>();
  readonly relations = new Map<string, RelationAcc>();
  readonly components: ComponentAcc[] = [];
  readonly signals: SignalAcc[] = [];

  external(input: Omit<ExternalAcc, 'evidence'> & { evidence: readonly Evidence[] }): string {
    const existing = this.externals.get(input.id);
    const fact: Fact = { detector: input.detector, confidence: input.confidence, evidence: [...input.evidence] };
    if (existing) {
      mergeFact(existing, fact);
      // Prefer a resolved name/technology over an unresolved one.
      if (existing.unresolved && !input.unresolved) {
        existing.unresolved = false;
        existing.name = input.name;
      }
      if (!existing.technology && input.technology) existing.technology = input.technology;
    } else {
      this.externals.set(input.id, { ...input, ...fact });
    }
    return input.id;
  }

  relation(input: Omit<RelationAcc, 'evidence'> & { evidence: readonly Evidence[] }): void {
    const key = `${input.sourceRef}->${input.destRef}:${input.detector}`;
    const existing = this.relations.get(key);
    const fact: Fact = { detector: input.detector, confidence: input.confidence, evidence: [...input.evidence] };
    if (existing) {
      mergeFact(existing, fact);
      if (!existing.description && input.description) existing.description = input.description;
    } else {
      this.relations.set(key, { ...input, ...fact });
    }
  }
}

// ---------------------------------------------------------------------------
// Line helpers
// ---------------------------------------------------------------------------

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function evidenceAt(file: string, lines: readonly string[], index: number): Evidence {
  const raw = lines[index] ?? '';
  return { file, line: index + 1, snippet: raw.trim().slice(0, SNIPPET_MAX) };
}

/** Lines the detectors are allowed to look at: not blank, not a comment. */
function codeLines(lines: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === '' || isCommentLine(trimmed)) continue;
    out.push(i);
  }
  return out;
}

function windowText(lines: readonly string[], start: number, size: number): string {
  return lines.slice(start, start + size).join(' ');
}

const PLACEHOLDER = /\$\{([^}:]+)(?::([^}]*))?\}/g;

/** Substitute `${key[:default]}` from resolved config; leave unknown keys in place. */
function resolvePlaceholders(value: string, props: ReadonlyMap<string, string>): string {
  let current = value;
  for (let depth = 0; depth < 5 && current.includes('${'); depth += 1) {
    const next = current.replace(PLACEHOLDER, (whole, key: string, fallback: string | undefined) => {
      const known = props.get(key.trim());
      if (known !== undefined) return known;
      if (fallback !== undefined) return fallback;
      return whole;
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

function isUnresolved(value: string): boolean {
  return value.includes('${') || value.trim() === '';
}

// ---------------------------------------------------------------------------
// Config parsing (.properties / .yml) -> flattened key/value with evidence
// ---------------------------------------------------------------------------

interface ConfigEntry {
  readonly value: string;
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

type ConfigMap = Map<string, ConfigEntry>;

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseProperties(file: string, lines: readonly string[], into: ConfigMap): void {
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const m = /^([^=:\s]+)\s*[=:]?\s*(.*)$/.exec(trimmed);
    if (!m || !m[1]) continue;
    into.set(m[1], { value: stripQuotes(m[2] ?? ''), file, line: i + 1, snippet: trimmed.slice(0, SNIPPET_MAX) });
  }
}

function parseYaml(file: string, lines: readonly string[], into: ConfigMap): void {
  const stack: { indent: number; key: string }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed === '---') {
      stack.length = 0;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    const m = /^(?:"([^"]+)"|'([^']+)'|([\w.\-/]+))\s*:(?:\s+(.*))?$/.exec(trimmed);
    if (!m) continue;
    const key = m[1] ?? m[2] ?? m[3] ?? '';
    let value = (m[4] ?? '').trim();
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop();
    const path = [...stack.map((s) => s.key), key].join('.');
    if (value === '') {
      stack.push({ indent, key });
      continue;
    }
    // Drop trailing comments outside quotes.
    if (!value.startsWith('"') && !value.startsWith("'")) value = value.replace(/\s+#.*$/, '');
    into.set(path, { value: stripQuotes(value), file, line: i + 1, snippet: trimmed.slice(0, SNIPPET_MAX) });
  }
}

function toProps(config: ConfigMap): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of config) out.set(k, v.value);
  return out;
}

// ---------------------------------------------------------------------------
// JDBC / engine vocabulary
// ---------------------------------------------------------------------------

const ENGINE_TECH: Readonly<Record<string, string>> = {
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  oracle: 'Oracle',
  h2: 'H2',
  sqlserver: 'SQL Server',
  hsqldb: 'HSQLDB',
  sqlite: 'SQLite',
  db2: 'DB2',
  mongodb: 'MongoDB',
};

interface JdbcInfo {
  readonly engine: string;
  readonly technology: string;
  readonly database?: string;
}

function parseJdbcUrl(url: string): JdbcInfo | undefined {
  const m = /^(?:jdbc|r2dbc)(?::(?:p6spy|log4jdbc|tc))?:([a-z0-9]+)/i.exec(url.trim());
  if (!m || !m[1]) return undefined;
  const engine = m[1].toLowerCase();
  const technology = ENGINE_TECH[engine] ?? engine;
  let database: string | undefined;
  const sqlServer = /databaseName=([\w-]+)/i.exec(url);
  if (sqlServer?.[1]) {
    database = sqlServer[1];
  } else {
    const bare = url.replace(/[?;].*$/, '');
    const segments = bare.split(/[/:]/).filter((s) => s !== '' && !s.includes('${'));
    const last = segments[segments.length - 1];
    if (last && !/^\d+$/.test(last) && last.toLowerCase() !== engine && !last.startsWith('@')) {
      database = last;
    }
  }
  return { engine, technology, database };
}

function databaseExternal(info: JdbcInfo): Pick<ExternalAcc, 'id' | 'name' | 'subtype' | 'technology'> {
  return {
    id: `database-${slug(info.database ?? info.engine)}`,
    name: info.database ?? `${info.technology} database`,
    subtype: 'database',
    technology: info.technology,
  };
}

const UNKNOWN_DATABASE: Pick<ExternalAcc, 'id' | 'name' | 'subtype' | 'technology' | 'unresolved'> = {
  id: 'database-unknown',
  name: 'unresolved JDBC database',
  subtype: 'database',
  technology: 'JDBC',
  unresolved: true,
};

const REDIS_EXTERNAL: Pick<ExternalAcc, 'id' | 'name' | 'subtype' | 'technology'> = {
  id: 'cache-redis',
  name: 'Redis',
  subtype: 'cache',
  technology: 'Redis',
};

const MONGO_EXTERNAL: Pick<ExternalAcc, 'id' | 'name' | 'subtype' | 'technology'> = {
  id: 'database-mongodb',
  name: 'MongoDB',
  subtype: 'database',
  technology: 'MongoDB',
};

// ---------------------------------------------------------------------------
// Module-level (config + build) detectors
// ---------------------------------------------------------------------------

const DATASOURCE_KEY = /^spring\.datasource(?:\.[\w-]+)*\.(?:url|jdbc-url)$|^spring\.r2dbc\.url$/;
const REDIS_KEY = /^spring\.(?:data\.)?redis\.(?:host|url)$/;
const MONGO_KEY = /^spring\.data\.mongodb\.(?:uri|host|database)$/;

interface ModuleFacts {
  /** Databases named by this module's config, used to resolve JdbcTemplate usage. */
  databases: { external: ReturnType<typeof databaseExternal>; evidence: Evidence }[];
  props: Map<string, string>;
}

function scanModuleConfig(module: string, config: ConfigMap, acc: Accumulator): ModuleFacts {
  const props = toProps(config);
  const facts: ModuleFacts = { databases: [], props };
  const source = moduleId(module);
  const keys = [...config.keys()].sort(compareIds);

  for (const key of keys) {
    const entry = config.get(key);
    if (!entry) continue;
    const evidence: Evidence = { file: entry.file, line: entry.line, snippet: entry.snippet };
    const value = resolvePlaceholders(entry.value, props);

    if (DATASOURCE_KEY.test(key)) {
      const info = parseJdbcUrl(value);
      if (info) {
        const external = databaseExternal(info);
        acc.external({ ...external, detector: 'jdbc/datasource', confidence: 'high', evidence: [evidence] });
        acc.relation({
          sourceRef: source,
          destRef: external.id,
          direction: 'outbound',
          technology: info.technology,
          description: `datasource ${key}`,
          detector: 'jdbc/datasource',
          confidence: 'high',
          evidence: [evidence],
        });
        facts.databases.push({ external, evidence });
      } else {
        // The key is unambiguous, the engine is not: the URL comes from the environment.
        acc.external({ ...UNKNOWN_DATABASE, detector: 'jdbc/datasource', confidence: 'medium', evidence: [evidence] });
        acc.relation({
          sourceRef: source,
          destRef: UNKNOWN_DATABASE.id,
          direction: 'outbound',
          technology: 'JDBC',
          description: `datasource ${key} (engine not resolvable from config)`,
          detector: 'jdbc/datasource',
          confidence: 'medium',
          evidence: [evidence],
        });
      }
    } else if (REDIS_KEY.test(key)) {
      acc.external({ ...REDIS_EXTERNAL, detector: 'redis/client', confidence: 'medium', evidence: [evidence] });
      acc.relation({
        sourceRef: source,
        destRef: REDIS_EXTERNAL.id,
        direction: 'outbound',
        technology: 'Redis',
        description: `configured via ${key}`,
        detector: 'redis/client',
        confidence: 'medium',
        evidence: [evidence],
      });
    } else if (MONGO_KEY.test(key)) {
      acc.external({ ...MONGO_EXTERNAL, detector: 'mongo/client', confidence: 'medium', evidence: [evidence] });
      acc.relation({
        sourceRef: source,
        destRef: MONGO_EXTERNAL.id,
        direction: 'outbound',
        technology: 'MongoDB',
        description: `configured via ${key}`,
        detector: 'mongo/client',
        confidence: 'medium',
        evidence: [evidence],
      });
    }
  }
  return facts;
}

function scanBuildFile(file: string, lines: readonly string[], acc: Accumulator): void {
  const source = moduleId(moduleOf(file));
  for (const i of codeLines(lines)) {
    const line = lines[i] ?? '';
    if (line.includes('spring-boot-starter-data-redis')) {
      const evidence = [evidenceAt(file, lines, i)];
      acc.external({ ...REDIS_EXTERNAL, detector: 'redis/client', confidence: 'medium', evidence });
      acc.relation({
        sourceRef: source,
        destRef: REDIS_EXTERNAL.id,
        direction: 'outbound',
        technology: 'Redis',
        description: 'spring-boot-starter-data-redis dependency',
        detector: 'redis/client',
        confidence: 'medium',
        evidence,
      });
    }
    if (line.includes('spring-boot-starter-data-mongodb')) {
      const evidence = [evidenceAt(file, lines, i)];
      acc.external({ ...MONGO_EXTERNAL, detector: 'mongo/client', confidence: 'medium', evidence });
      acc.relation({
        sourceRef: source,
        destRef: MONGO_EXTERNAL.id,
        direction: 'outbound',
        technology: 'MongoDB',
        description: 'spring-boot-starter-data-mongodb dependency',
        detector: 'mongo/client',
        confidence: 'medium',
        evidence,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// docker-compose
// ---------------------------------------------------------------------------

interface ImageMapping {
  readonly subtype: ExternalSubtype;
  readonly technology: string;
}

function mapImage(image: string): ImageMapping | undefined {
  // `registry/org/name:tag@sha` -> `name`
  const withoutDigest = image.split('@')[0] ?? image;
  const lastSegment = withoutDigest.slice(withoutDigest.lastIndexOf('/') + 1);
  const name = (lastSegment.split(':')[0] ?? lastSegment).toLowerCase();
  if (/^(postgres|postgresql)$/.test(name)) return { subtype: 'database', technology: 'PostgreSQL' };
  if (name === 'mysql') return { subtype: 'database', technology: 'MySQL' };
  if (name === 'mariadb') return { subtype: 'database', technology: 'MariaDB' };
  if (/^(mongo|mongodb)$/.test(name)) return { subtype: 'database', technology: 'MongoDB' };
  if (/^(redis|valkey)$/.test(name)) return { subtype: 'cache', technology: 'Redis' };
  if (/zookeeper$/.test(name)) return { subtype: 'infrastructure', technology: 'ZooKeeper' };
  if (/kafka$/.test(name)) return { subtype: 'broker', technology: 'Kafka' };
  if (name === 'rabbitmq') return { subtype: 'broker', technology: 'RabbitMQ' };
  if (name === 'nginx') return { subtype: 'proxy', technology: 'Nginx' };
  return undefined;
}

function scanCompose(file: string, lines: readonly string[], acc: Accumulator): void {
  let inServices = false;
  let serviceIndent = -1;
  let current: { name: string; line: number } | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      inServices = /^services\s*:\s*$/.test(trimmed);
      serviceIndent = -1;
      current = undefined;
      continue;
    }
    if (!inServices) continue;

    if (serviceIndent < 0) serviceIndent = indent;
    if (indent === serviceIndent) {
      const m = /^([\w.-]+)\s*:\s*$/.exec(trimmed);
      current = m?.[1] ? { name: m[1], line: i } : undefined;
      continue;
    }
    if (!current || indent <= serviceIndent) continue;

    const image = /^image\s*:\s*(.+)$/.exec(trimmed);
    if (!image?.[1]) continue;
    const mapping = mapImage(stripQuotes(image[1]));
    if (!mapping) continue;
    acc.external({
      id: `compose-${slug(current.name)}`,
      name: current.name,
      subtype: mapping.subtype,
      technology: mapping.technology,
      detector: 'compose/service',
      confidence: 'medium',
      evidence: [evidenceAt(file, lines, current.line), evidenceAt(file, lines, i)],
    });
  }
}

// ---------------------------------------------------------------------------
// Java detectors
// ---------------------------------------------------------------------------

interface JavaFile {
  readonly file: string;
  readonly module: string;
  readonly lines: readonly string[];
  readonly code: readonly number[];
  readonly className: string;
  readonly constants: ReadonlyMap<string, string>;
  readonly props: ReadonlyMap<string, string>;
  readonly unitRef: string;
}

const COMPONENT_ANNOTATIONS: readonly { re: RegExp; detector: string; subtype: string }[] = [
  { re: /^@(?:RestController|Controller)\b/, detector: 'spring/rest-controller', subtype: 'api' },
  { re: /^@Service\b/, detector: 'spring/service', subtype: 'service' },
  { re: /^@Repository\b/, detector: 'spring/repository', subtype: 'service' },
  { re: /^@Configuration\b/, detector: 'spring/configuration', subtype: 'configuration' },
  { re: /^@Component\b/, detector: 'spring/component', subtype: 'component' },
];

function fileStem(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  return base.replace(/\.java$/, '');
}

/** `PaymentController` -> `payment-controller`, `HTTPClient` -> `http-client`. */
function classSlug(className: string): string {
  return slug(
    className
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2'),
  );
}

function findClassName(lines: readonly string[], code: readonly number[], fallback: string): string {
  for (const i of code) {
    const m = /\b(?:class|interface|record|enum)\s+([A-Za-z_]\w*)/.exec(lines[i] ?? '');
    if (m?.[1]) return m[1];
  }
  return fallback;
}

function collectConstants(lines: readonly string[], code: readonly number[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of code) {
    const m = /\bString\s+([A-Za-z_]\w*)\s*=\s*"([^"]*)"/.exec(lines[i] ?? '');
    if (m?.[1] && m[2] !== undefined) out.set(m[1], m[2]);
  }
  return out;
}

/** Resolve a literal or an identifier (possibly qualified) to a string value. */
function resolveValue(ctx: JavaFile, literal: string | undefined, identifier: string | undefined): string | undefined {
  if (literal !== undefined) return resolvePlaceholders(literal, ctx.props);
  if (identifier !== undefined) {
    const last = identifier.slice(identifier.lastIndexOf('.') + 1);
    const constant = ctx.constants.get(last);
    return constant === undefined ? undefined : resolvePlaceholders(constant, ctx.props);
  }
  return undefined;
}

function detectComponents(ctx: JavaFile, acc: Accumulator): void {
  for (const i of ctx.code) {
    const trimmed = (ctx.lines[i] ?? '').trim();
    if (!trimmed.startsWith('@')) continue;
    for (const candidate of COMPONENT_ANNOTATIONS) {
      if (!candidate.re.test(trimmed)) continue;
      acc.components.push({
        file: ctx.file,
        module: ctx.module,
        className: ctx.className,
        subtype: candidate.subtype,
        detector: candidate.detector,
        confidence: 'high',
        evidence: [evidenceAt(ctx.file, ctx.lines, i)],
      });
      return; // one component per file; the first class-level annotation wins
    }
  }
}

function detectEntities(ctx: JavaFile, acc: Accumulator): void {
  for (const i of ctx.code) {
    const trimmed = (ctx.lines[i] ?? '').trim();
    if (!/^@Entity\b/.test(trimmed)) continue;
    acc.signals.push({
      className: ctx.className,
      module: ctx.module,
      technology: 'JPA',
      detector: 'jpa/entity',
      confidence: 'high',
      evidence: [evidenceAt(ctx.file, ctx.lines, i)],
    });
    return;
  }
}

function topicExternal(name: string, unresolved: boolean): Pick<ExternalAcc, 'id' | 'name' | 'subtype' | 'technology' | 'unresolved'> {
  return {
    id: `topic-${slug(name)}`,
    name,
    subtype: 'topic',
    technology: 'Kafka',
    unresolved,
  };
}

function detectKafkaListener(ctx: JavaFile, acc: Accumulator): void {
  for (const i of ctx.code) {
    const trimmed = (ctx.lines[i] ?? '').trim();
    if (!/^@KafkaListener\b/.test(trimmed)) continue;
    const text = windowText(ctx.lines, i, ANNOTATION_WINDOW);
    const topicsExpr = /topics\s*=\s*(\{[^}]*\}|"[^"]*"|[A-Za-z_][\w.]*)/.exec(text)?.[1];
    if (!topicsExpr) continue;
    const evidence = [evidenceAt(ctx.file, ctx.lines, i)];

    const values: string[] = [];
    const literals = [...topicsExpr.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '');
    if (literals.length > 0) {
      for (const lit of literals) values.push(resolvePlaceholders(lit, ctx.props));
    } else {
      const resolved = resolveValue(ctx, undefined, topicsExpr);
      values.push(resolved ?? topicsExpr);
    }

    for (const value of values) {
      const unresolved = isUnresolved(value);
      const external = topicExternal(value, unresolved);
      const confidence: Confidence = unresolved ? 'medium' : 'high';
      acc.external({ ...external, detector: 'kafka/listener', confidence, evidence });
      acc.relation({
        sourceRef: external.id,
        destRef: ctx.unitRef,
        direction: 'inbound',
        technology: 'Kafka',
        description: `consumes ${value}`,
        detector: 'kafka/listener',
        confidence,
        evidence,
      });
    }
  }
}

function detectKafkaProducer(ctx: JavaFile, acc: Accumulator): void {
  const templateLines = ctx.code.filter((i) => {
    const line = ctx.lines[i] ?? '';
    return /\bKafkaTemplate\b/.test(line) && !/^\s*import\b/.test(line);
  });
  const usesKafka = templateLines.length > 0 || ctx.code.some((i) => /\bKafkaTemplate\b/.test(ctx.lines[i] ?? ''));
  if (!usesKafka) return;

  const byTopic = new Map<string, Evidence[]>();
  for (const i of ctx.code) {
    const line = ctx.lines[i] ?? '';
    const send = /\.send\(\s*(?:"([^"]*)"|([A-Za-z_][\w.]*)\s*[,)])/.exec(line);
    const record = /ProducerRecord<[^>]*>\(\s*(?:"([^"]*)"|([A-Za-z_][\w.]*)\s*,)/.exec(line);
    const m = send ?? record;
    if (!m) continue;
    const value = resolveValue(ctx, m[1], m[2]);
    if (value === undefined) continue;
    const list = byTopic.get(value) ?? [];
    list.push(evidenceAt(ctx.file, ctx.lines, i));
    byTopic.set(value, list);
  }

  if (byTopic.size === 0) {
    const evidence = templateLines.map((i) => evidenceAt(ctx.file, ctx.lines, i));
    if (evidence.length === 0) return;
    const external = topicExternal('unresolved Kafka topic', true);
    acc.external({ ...external, id: 'topic-unknown', detector: 'kafka/producer', confidence: 'medium', evidence });
    acc.relation({
      sourceRef: ctx.unitRef,
      destRef: 'topic-unknown',
      direction: 'outbound',
      technology: 'Kafka',
      description: 'produces to a topic that could not be resolved',
      detector: 'kafka/producer',
      confidence: 'medium',
      evidence,
    });
    return;
  }

  for (const [topic, evidence] of [...byTopic.entries()].sort((a, b) => compareIds(a[0], b[0]))) {
    const unresolved = isUnresolved(topic);
    const external = topicExternal(topic, unresolved);
    const confidence: Confidence = unresolved ? 'medium' : 'high';
    acc.external({ ...external, detector: 'kafka/producer', confidence, evidence });
    acc.relation({
      sourceRef: ctx.unitRef,
      destRef: external.id,
      direction: 'outbound',
      technology: 'Kafka',
      description: `produces ${topic}`,
      detector: 'kafka/producer',
      confidence,
      evidence,
    });
  }
}

function detectFeign(ctx: JavaFile, acc: Accumulator): void {
  for (const i of ctx.code) {
    const trimmed = (ctx.lines[i] ?? '').trim();
    if (!/^@FeignClient\b/.test(trimmed)) continue;
    const text = windowText(ctx.lines, i, ANNOTATION_WINDOW);
    const named = /\b(?:name|value)\s*=\s*"([^"]*)"/.exec(text)?.[1];
    const positional = /@FeignClient\s*\(\s*"([^"]*)"/.exec(text)?.[1];
    const rawName = named ?? positional ?? ctx.className;
    const name = resolvePlaceholders(rawName, ctx.props);
    const url = /\burl\s*=\s*"([^"]*)"/.exec(text)?.[1];
    const evidence = [evidenceAt(ctx.file, ctx.lines, i)];
    const external = acc.external({
      id: `system-${slug(name)}`,
      name,
      subtype: 'system',
      technology: 'HTTP/Feign',
      unresolved: isUnresolved(name),
      detector: 'feign/client',
      confidence: 'high',
      evidence,
    });
    acc.relation({
      sourceRef: ctx.unitRef,
      destRef: external,
      direction: 'outbound',
      technology: 'HTTP/Feign',
      description: url ? `calls ${name} at ${resolvePlaceholders(url, ctx.props)}` : `calls ${name}`,
      detector: 'feign/client',
      confidence: 'high',
      evidence,
    });
    return;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** Hosts named by string literals (or resolvable placeholders) within the given line range. */
function hostsNear(ctx: JavaFile, from: number, to: number): { host: string; line: number }[] {
  const out: { host: string; line: number }[] = [];
  for (let i = Math.max(0, from); i <= Math.min(ctx.lines.length - 1, to); i += 1) {
    const line = ctx.lines[i] ?? '';
    if (isCommentLine(line.trim())) continue;
    for (const m of line.matchAll(/"([^"]*)"/g)) {
      const literal = resolvePlaceholders(m[1] ?? '', ctx.props);
      if (!/^https?:\/\//i.test(literal)) continue;
      const host = hostOf(literal);
      if (host && !host.includes('${')) out.push({ host, line: i });
    }
  }
  return out;
}

function detectHttpClient(ctx: JavaFile, acc: Accumulator): void {
  const clientLines = ctx.code.filter((i) => {
    const line = ctx.lines[i] ?? '';
    return /\b(?:RestTemplate|WebClient|RestClient)\b/.test(line) && !/^\s*import\b/.test(line);
  });
  if (clientLines.length === 0) return;

  const byHost = new Map<string, Evidence[]>();
  for (const i of clientLines) {
    const near = hostsNear(ctx, i - HTTP_URL_WINDOW, i + HTTP_URL_WINDOW);
    for (const { host, line } of near) {
      const list = byHost.get(host) ?? [];
      list.push(evidenceAt(ctx.file, ctx.lines, i), evidenceAt(ctx.file, ctx.lines, line));
      byHost.set(host, list);
    }
  }
  // Builder-style base URLs anywhere in the file are also strong hints.
  for (const i of ctx.code) {
    const line = ctx.lines[i] ?? '';
    const m = /\b(?:baseUrl|rootUri|uri)\s*\(\s*(?:"([^"]*)"|([A-Za-z_][\w.]*))/.exec(line);
    if (!m) continue;
    const value = resolveValue(ctx, m[1], m[2]);
    if (!value || !/^https?:\/\//i.test(value)) continue;
    const host = hostOf(value);
    if (!host || host.includes('${')) continue;
    const list = byHost.get(host) ?? [];
    list.push(evidenceAt(ctx.file, ctx.lines, i));
    byHost.set(host, list);
  }

  if (byHost.size === 0) {
    const evidence = clientLines.map((i) => evidenceAt(ctx.file, ctx.lines, i));
    acc.external({
      id: 'http-unknown',
      name: 'unresolved HTTP target',
      subtype: 'system',
      technology: 'HTTP',
      unresolved: true,
      detector: 'http/client',
      confidence: 'medium',
      evidence,
    });
    acc.relation({
      sourceRef: ctx.unitRef,
      destRef: 'http-unknown',
      direction: 'outbound',
      technology: 'HTTP',
      description: 'outbound HTTP call to a target that could not be resolved',
      detector: 'http/client',
      confidence: 'medium',
      evidence,
    });
    return;
  }

  for (const [host, evidence] of [...byHost.entries()].sort((a, b) => compareIds(a[0], b[0]))) {
    const id = `http-${slug(host)}`;
    acc.external({ id, name: host, subtype: 'system', technology: 'HTTP', detector: 'http/client', confidence: 'medium', evidence });
    acc.relation({
      sourceRef: ctx.unitRef,
      destRef: id,
      direction: 'outbound',
      technology: 'HTTP',
      description: `calls ${host}`,
      detector: 'http/client',
      confidence: 'medium',
      evidence,
    });
  }
}

function detectJdbc(ctx: JavaFile, moduleFacts: ModuleFacts | undefined, acc: Accumulator): void {
  const usage = ctx.code.filter((i) => {
    const line = ctx.lines[i] ?? '';
    return /\b(?:JdbcTemplate|NamedParameterJdbcTemplate|JdbcClient|DataSource)\b/.test(line) && !/^\s*import\b/.test(line);
  });
  if (usage.length === 0) return;
  const evidence = usage.map((i) => evidenceAt(ctx.file, ctx.lines, i));

  const databases = moduleFacts?.databases ?? [];
  if (databases.length === 0) {
    acc.external({ ...UNKNOWN_DATABASE, detector: 'jdbc/datasource', confidence: 'medium', evidence });
    acc.relation({
      sourceRef: ctx.unitRef,
      destRef: UNKNOWN_DATABASE.id,
      direction: 'outbound',
      technology: 'JDBC',
      description: 'JDBC access; no datasource URL found in this module',
      detector: 'jdbc/datasource',
      confidence: 'medium',
      evidence,
    });
    return;
  }
  // Cross-file association: the class uses JDBC, the module's config names the
  // database. Strong idiom, but not proof, hence `medium`.
  for (const db of databases) {
    acc.external({ ...db.external, detector: 'jdbc/datasource', confidence: 'medium', evidence: [...evidence, db.evidence] });
    acc.relation({
      sourceRef: ctx.unitRef,
      destRef: db.external.id,
      direction: 'outbound',
      technology: db.external.technology,
      description: `JDBC access to ${db.external.name}`,
      detector: 'jdbc/datasource',
      confidence: 'medium',
      evidence: [...evidence, db.evidence],
    });
  }
}

function detectTypedClient(
  ctx: JavaFile,
  acc: Accumulator,
  pattern: RegExp,
  detector: string,
  external: Pick<ExternalAcc, 'id' | 'name' | 'subtype' | 'technology'>,
  description: string,
): void {
  const usage = ctx.code.filter((i) => {
    const line = ctx.lines[i] ?? '';
    return pattern.test(line) && !/^\s*import\b/.test(line);
  });
  if (usage.length === 0) return;
  const evidence = usage.map((i) => evidenceAt(ctx.file, ctx.lines, i));
  acc.external({ ...external, detector, confidence: 'high', evidence });
  acc.relation({
    sourceRef: ctx.unitRef,
    destRef: external.id,
    direction: 'outbound',
    technology: external.technology,
    description,
    detector,
    confidence: 'high',
    evidence,
  });
}

const REDIS_TYPES = /\b(?:StringRedisTemplate|RedisTemplate|ReactiveRedisTemplate|ReactiveStringRedisTemplate|RedisConnectionFactory|LettuceConnectionFactory|JedisConnectionFactory)\b/;
const MONGO_TYPES = /\b(?:MongoTemplate|ReactiveMongoTemplate|MongoRepository|ReactiveMongoRepository|MongoClient|MongoOperations)\b/;

function scanJavaFile(ctx: JavaFile, moduleFacts: ModuleFacts | undefined, acc: Accumulator): void {
  detectComponents(ctx, acc);
  detectEntities(ctx, acc);
  detectKafkaListener(ctx, acc);
  detectKafkaProducer(ctx, acc);
  detectFeign(ctx, acc);
  detectHttpClient(ctx, acc);
  detectJdbc(ctx, moduleFacts, acc);
  detectTypedClient(ctx, acc, REDIS_TYPES, 'redis/client', REDIS_EXTERNAL, 'Redis client');
  detectTypedClient(ctx, acc, MONGO_TYPES, 'mongo/client', MONGO_EXTERNAL, 'MongoDB client');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

interface LoadedFile {
  readonly rel: string;
  readonly kind: FileKind;
  readonly lines: string[];
}

/**
 * Analyses a repository for Java/Spring architecture facts.
 *
 * Takes a `FileSource` rather than a path, which is what lets the identical
 * detectors run in the CLI (over a directory) and in the browser (over a
 * dropped folder, with no upload and no server). For the Node convenience
 * wrapper, see `scanJavaRepo` in `scan/node.ts`.
 */
export async function scanJava(
  source: FileSource,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const include = (options.include ?? []).map(normalizePrefix).filter((p) => p !== '');
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const discovered = await discover(source, include, maxFileBytes);

  const loaded: LoadedFile[] = [];
  for (const rel of discovered.files) {
    const kind = classify(rel);
    if (!kind) continue;
    const text = await source.read(rel);
    loaded.push({ rel, kind, lines: text.split(/\r?\n/) });
  }

  const acc = new Accumulator();

  // Pass 1: configuration per module, so Java detectors can resolve placeholders
  // and associate JDBC usage with a named database.
  const configByModule = new Map<string, ConfigMap>();
  for (const f of loaded) {
    if (f.kind !== 'config') continue;
    const module = moduleOf(f.rel);
    const config = configByModule.get(module) ?? new Map<string, ConfigEntry>();
    if (f.rel.endsWith('.properties')) parseProperties(f.rel, f.lines, config);
    else parseYaml(f.rel, f.lines, config);
    configByModule.set(module, config);
  }
  const moduleFacts = new Map<string, ModuleFacts>();
  for (const module of [...configByModule.keys()].sort(compareIds)) {
    const config = configByModule.get(module);
    if (config) moduleFacts.set(module, scanModuleConfig(module, config, acc));
  }

  // Pass 2: unit ids for Java files. A class name is the id unless two files
  // share one, in which case each is qualified by its module.
  const javaFiles = loaded.filter((f) => f.kind === 'java');
  const classNames = new Map<string, string>();
  const classSlugCount = new Map<string, number>();
  for (const f of javaFiles) {
    const code = codeLines(f.lines);
    const className = findClassName(f.lines, code, fileStem(f.rel));
    classNames.set(f.rel, className);
    const s = classSlug(className);
    classSlugCount.set(s, (classSlugCount.get(s) ?? 0) + 1);
  }
  const unitIds = new Map<string, string>();
  for (const f of javaFiles) {
    const className = classNames.get(f.rel) ?? fileStem(f.rel);
    const s = classSlug(className);
    const module = moduleOf(f.rel);
    unitIds.set(f.rel, (classSlugCount.get(s) ?? 0) > 1 ? `${slug(module) || 'root'}-${s}` : s);
  }

  // Pass 3: Java detectors.
  for (const f of javaFiles) {
    const module = moduleOf(f.rel);
    const code = codeLines(f.lines);
    const ctx: JavaFile = {
      file: f.rel,
      module,
      lines: f.lines,
      code,
      className: classNames.get(f.rel) ?? fileStem(f.rel),
      constants: collectConstants(f.lines, code),
      props: moduleFacts.get(module)?.props ?? new Map<string, string>(),
      unitRef: `unit:${f.rel}`,
    };
    scanJavaFile(ctx, moduleFacts.get(module), acc);
  }

  // Pass 4: build files and compose.
  for (const f of loaded) {
    if (f.kind === 'build') scanBuildFile(f.rel, f.lines, acc);
    else if (f.kind === 'compose') scanCompose(f.rel, f.lines, acc);
  }

  const resolveRef = (ref: string): string =>
    ref.startsWith('unit:') ? (unitIds.get(ref.slice('unit:'.length)) ?? classSlug(fileStem(ref))) : ref;

  const components: InferredComponent[] = acc.components.map((c) => ({
    id: unitIds.get(c.file) ?? classSlug(c.className),
    name: c.className,
    subtype: c.subtype,
    sourcePath: c.file,
    module: c.module,
    technology: c.technology,
    provenance: provenanceOf(c),
  }));

  const externals: InferredExternal[] = [...acc.externals.values()].map((e) => ({
    id: e.id,
    name: e.name,
    subtype: e.subtype,
    technology: e.technology,
    unresolved: e.unresolved ? true : undefined,
    provenance: provenanceOf(e),
  }));

  const relations: InferredRelation[] = [...acc.relations.values()].map((r) => {
    const sourceId = resolveRef(r.sourceRef);
    const destId = resolveRef(r.destRef);
    return {
      id: `${sourceId}->${destId}:${r.detector}`,
      sourceId,
      destId,
      direction: r.direction,
      technology: r.technology,
      description: r.description,
      provenance: provenanceOf(r),
    };
  });

  const signals: InferredSignal[] = acc.signals.map((s) => ({
    id: `entity-${classSlug(s.className)}`,
    kind: 'persistence',
    name: s.className,
    module: s.module,
    technology: s.technology,
    provenance: provenanceOf(s),
  }));

  return {
    components: sortBy(components, (c) => `${c.id}\u0000${c.sourcePath}`),
    externals: sortBy(externals, (e) => e.id),
    relations: sortBy(relations, (r) => r.id),
    signals: sortBy(signals, (s) => `${s.id}\u0000${s.module}`),
    files: discovered.files,
    skippedFiles: discovered.skipped,
  };
}

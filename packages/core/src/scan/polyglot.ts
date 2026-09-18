/**
 * Language-agnostic repository scanner.
 *
 * Rather than one hand-written scanner per language, detection is driven by
 * tables. Two observations make this work:
 *
 *  1. Almost every architectural dependency enters a codebase as a *named
 *     package* — `pg`, `ioredis`, `kafkajs`, `psycopg2`, `go-redis`,
 *     `StackExchange.Redis`. So one table mapping package names to
 *     infrastructure serves both import statements and dependency manifests,
 *     in every language, from the same rows.
 *  2. Frameworks announce entry points with a small set of recognisable
 *     markers — `@Controller`, `@app.get`, `http.HandleFunc`, `[ApiController]`.
 *
 * Adding a stack is therefore adding rows, not writing a scanner. What the
 * tables cannot do is understand semantics: a language-specific scanner (see
 * `java.ts`) can resolve a topic name from a constant, and the registry gives
 * those precedence.
 *
 * Determinism contract, as everywhere in scanning: files visited in sorted
 * order, ids derived from names in the code and never from host paths, every
 * output array sorted, evidence paths repo-relative POSIX.
 */

import type { Confidence, Evidence } from '../model/types.ts';
import { compareIds, slug, sortBy } from '../util/canonical.ts';
import {
  basenameOf,
  languageOf,
  DEFAULT_MAX_FILE_BYTES,
  isIgnoredPath,
  type FileSource,
} from './source.ts';
import type {
  ExternalSubtype,
  InferredComponent,
  InferredExternal,
  InferredRelation,
  InferredSignal,
  InferredProvenance,
  ScanResult,
} from './types.ts';
import type { ScannerOptions } from './registry.ts';

// ---------------------------------------------------------------------------
// Infrastructure table: package name -> what it means architecturally
// ---------------------------------------------------------------------------

interface Infrastructure {
  /** Display name of the dependency, e.g. `PostgreSQL`. */
  readonly name: string;
  readonly subtype: ExternalSubtype;
  readonly technology: string;
  /** `inbound` for things that push into the code, e.g. a consumed topic. */
  readonly direction?: 'outbound' | 'inbound';
}

/**
 * Package and import names, lowercased, mapped to infrastructure.
 *
 * Matched against manifest dependency keys and against import/require targets.
 * Keys are matched by exact value first, then as a prefix for scoped families
 * like `@aws-sdk/client-`.
 */
const KNOWN_DEPENDENCIES: Readonly<Record<string, Infrastructure>> = {
  // ---- relational databases
  pg: { name: 'PostgreSQL', subtype: 'database', technology: 'PostgreSQL' },
  'pg-promise': { name: 'PostgreSQL', subtype: 'database', technology: 'PostgreSQL' },
  postgres: { name: 'PostgreSQL', subtype: 'database', technology: 'PostgreSQL' },
  psycopg2: { name: 'PostgreSQL', subtype: 'database', technology: 'PostgreSQL' },
  'psycopg2-binary': { name: 'PostgreSQL', subtype: 'database', technology: 'PostgreSQL' },
  psycopg: { name: 'PostgreSQL', subtype: 'database', technology: 'PostgreSQL' },
  asyncpg: { name: 'PostgreSQL', subtype: 'database', technology: 'PostgreSQL' },
  'lib/pq': { name: 'PostgreSQL', subtype: 'database', technology: 'PostgreSQL' },
  pgx: { name: 'PostgreSQL', subtype: 'database', technology: 'PostgreSQL' },
  npgsql: { name: 'PostgreSQL', subtype: 'database', technology: 'PostgreSQL' },
  'sqlx-postgres': { name: 'PostgreSQL', subtype: 'database', technology: 'PostgreSQL' },
  mysql: { name: 'MySQL', subtype: 'database', technology: 'MySQL' },
  mysql2: { name: 'MySQL', subtype: 'database', technology: 'MySQL' },
  pymysql: { name: 'MySQL', subtype: 'database', technology: 'MySQL' },
  mysqlclient: { name: 'MySQL', subtype: 'database', technology: 'MySQL' },
  'go-sql-driver/mysql': { name: 'MySQL', subtype: 'database', technology: 'MySQL' },
  mssql: { name: 'SQL Server', subtype: 'database', technology: 'Microsoft SQL Server' },
  pyodbc: { name: 'SQL Server', subtype: 'database', technology: 'Microsoft SQL Server' },
  'microsoft.data.sqlclient': {
    name: 'SQL Server',
    subtype: 'database',
    technology: 'Microsoft SQL Server',
  },
  oracledb: { name: 'Oracle', subtype: 'database', technology: 'Oracle Database' },
  cx_oracle: { name: 'Oracle', subtype: 'database', technology: 'Oracle Database' },
  sqlite3: { name: 'SQLite', subtype: 'database', technology: 'SQLite' },
  'better-sqlite3': { name: 'SQLite', subtype: 'database', technology: 'SQLite' },
  cockroach: { name: 'CockroachDB', subtype: 'database', technology: 'CockroachDB' },

  // ---- ORMs, which imply a database even when the driver is indirect
  sequelize: { name: 'SQL database', subtype: 'database', technology: 'Sequelize ORM' },
  typeorm: { name: 'SQL database', subtype: 'database', technology: 'TypeORM' },
  'drizzle-orm': { name: 'SQL database', subtype: 'database', technology: 'Drizzle ORM' },
  '@prisma/client': { name: 'SQL database', subtype: 'database', technology: 'Prisma' },
  knex: { name: 'SQL database', subtype: 'database', technology: 'Knex' },
  sqlalchemy: { name: 'SQL database', subtype: 'database', technology: 'SQLAlchemy' },
  'django.db': { name: 'SQL database', subtype: 'database', technology: 'Django ORM' },
  gorm: { name: 'SQL database', subtype: 'database', technology: 'GORM' },
  'gorm.io/gorm': { name: 'SQL database', subtype: 'database', technology: 'GORM' },
  diesel: { name: 'SQL database', subtype: 'database', technology: 'Diesel' },
  'entityframeworkcore': { name: 'SQL database', subtype: 'database', technology: 'EF Core' },
  activerecord: { name: 'SQL database', subtype: 'database', technology: 'ActiveRecord' },
  hibernate: { name: 'SQL database', subtype: 'database', technology: 'Hibernate' },

  // ---- document and wide-column stores
  mongodb: { name: 'MongoDB', subtype: 'database', technology: 'MongoDB' },
  mongoose: { name: 'MongoDB', subtype: 'database', technology: 'MongoDB' },
  pymongo: { name: 'MongoDB', subtype: 'database', technology: 'MongoDB' },
  motor: { name: 'MongoDB', subtype: 'database', technology: 'MongoDB' },
  'mongo-driver': { name: 'MongoDB', subtype: 'database', technology: 'MongoDB' },
  'mongodb.driver': { name: 'MongoDB', subtype: 'database', technology: 'MongoDB' },
  cassandra: { name: 'Cassandra', subtype: 'database', technology: 'Apache Cassandra' },
  'cassandra-driver': { name: 'Cassandra', subtype: 'database', technology: 'Apache Cassandra' },
  'gocql/gocql': { name: 'Cassandra', subtype: 'database', technology: 'Apache Cassandra' },

  // ---- caches
  redis: { name: 'Redis', subtype: 'cache', technology: 'Redis' },
  ioredis: { name: 'Redis', subtype: 'cache', technology: 'Redis' },
  'go-redis/redis': { name: 'Redis', subtype: 'cache', technology: 'Redis' },
  'redis/go-redis': { name: 'Redis', subtype: 'cache', technology: 'Redis' },
  'stackexchange.redis': { name: 'Redis', subtype: 'cache', technology: 'Redis' },
  'redis-py': { name: 'Redis', subtype: 'cache', technology: 'Redis' },
  memcached: { name: 'Memcached', subtype: 'cache', technology: 'Memcached' },
  memjs: { name: 'Memcached', subtype: 'cache', technology: 'Memcached' },
  pymemcache: { name: 'Memcached', subtype: 'cache', technology: 'Memcached' },

  // ---- messaging
  kafkajs: { name: 'Kafka', subtype: 'broker', technology: 'Apache Kafka' },
  'node-rdkafka': { name: 'Kafka', subtype: 'broker', technology: 'Apache Kafka' },
  'confluent-kafka': { name: 'Kafka', subtype: 'broker', technology: 'Apache Kafka' },
  'confluent.kafka': { name: 'Kafka', subtype: 'broker', technology: 'Apache Kafka' },
  aiokafka: { name: 'Kafka', subtype: 'broker', technology: 'Apache Kafka' },
  'kafka-python': { name: 'Kafka', subtype: 'broker', technology: 'Apache Kafka' },
  'shopify/sarama': { name: 'Kafka', subtype: 'broker', technology: 'Apache Kafka' },
  'ibm/sarama': { name: 'Kafka', subtype: 'broker', technology: 'Apache Kafka' },
  'segmentio/kafka-go': { name: 'Kafka', subtype: 'broker', technology: 'Apache Kafka' },
  rdkafka: { name: 'Kafka', subtype: 'broker', technology: 'Apache Kafka' },
  amqplib: { name: 'RabbitMQ', subtype: 'broker', technology: 'RabbitMQ / AMQP' },
  pika: { name: 'RabbitMQ', subtype: 'broker', technology: 'RabbitMQ / AMQP' },
  'rabbitmq/amqp091-go': { name: 'RabbitMQ', subtype: 'broker', technology: 'RabbitMQ / AMQP' },
  bunny: { name: 'RabbitMQ', subtype: 'broker', technology: 'RabbitMQ / AMQP' },
  'rabbitmq.client': { name: 'RabbitMQ', subtype: 'broker', technology: 'RabbitMQ / AMQP' },
  nats: { name: 'NATS', subtype: 'broker', technology: 'NATS' },
  'nats-io/nats.go': { name: 'NATS', subtype: 'broker', technology: 'NATS' },
  bullmq: { name: 'Redis', subtype: 'cache', technology: 'BullMQ on Redis' },
  celery: { name: 'Celery broker', subtype: 'broker', technology: 'Celery' },
  sidekiq: { name: 'Redis', subtype: 'cache', technology: 'Sidekiq on Redis' },

  // ---- search and analytics
  '@elastic/elasticsearch': {
    name: 'Elasticsearch',
    subtype: 'database',
    technology: 'Elasticsearch',
  },
  elasticsearch: { name: 'Elasticsearch', subtype: 'database', technology: 'Elasticsearch' },
  opensearch: { name: 'OpenSearch', subtype: 'database', technology: 'OpenSearch' },
  'meilisearch': { name: 'Meilisearch', subtype: 'database', technology: 'Meilisearch' },
  clickhouse: { name: 'ClickHouse', subtype: 'database', technology: 'ClickHouse' },
  'clickhouse-driver': { name: 'ClickHouse', subtype: 'database', technology: 'ClickHouse' },
  influxdb: { name: 'InfluxDB', subtype: 'database', technology: 'InfluxDB' },
  'solr-client': { name: 'Solr', subtype: 'database', technology: 'Apache Solr' },
  pysolr: { name: 'Solr', subtype: 'database', technology: 'Apache Solr' },

  // ---- HTTP clients imply an outbound call to something
  axios: { name: 'HTTP dependency', subtype: 'system', technology: 'HTTP' },
  got: { name: 'HTTP dependency', subtype: 'system', technology: 'HTTP' },
  'node-fetch': { name: 'HTTP dependency', subtype: 'system', technology: 'HTTP' },
  superagent: { name: 'HTTP dependency', subtype: 'system', technology: 'HTTP' },
  requests: { name: 'HTTP dependency', subtype: 'system', technology: 'HTTP' },
  httpx: { name: 'HTTP dependency', subtype: 'system', technology: 'HTTP' },
  aiohttp: { name: 'HTTP dependency', subtype: 'system', technology: 'HTTP' },
  'urllib3': { name: 'HTTP dependency', subtype: 'system', technology: 'HTTP' },
  faraday: { name: 'HTTP dependency', subtype: 'system', technology: 'HTTP' },
  guzzlehttp: { name: 'HTTP dependency', subtype: 'system', technology: 'HTTP' },
  reqwest: { name: 'HTTP dependency', subtype: 'system', technology: 'HTTP' },

  // ---- gRPC
  '@grpc/grpc-js': { name: 'gRPC dependency', subtype: 'system', technology: 'gRPC' },
  grpcio: { name: 'gRPC dependency', subtype: 'system', technology: 'gRPC' },
  'google.golang.org/grpc': { name: 'gRPC dependency', subtype: 'system', technology: 'gRPC' },
  'grpc.net.client': { name: 'gRPC dependency', subtype: 'system', technology: 'gRPC' },
};

/** Scoped/prefixed package families, matched by prefix. */
const DEPENDENCY_PREFIXES: readonly { prefix: string; infra: Infrastructure }[] = [
  { prefix: '@aws-sdk/client-s3', infra: { name: 'Amazon S3', subtype: 'infrastructure', technology: 'AWS S3' } },
  { prefix: 'aws-sdk-go-v2/service/s3', infra: { name: 'Amazon S3', subtype: 'infrastructure', technology: 'AWS S3' } },
  { prefix: '@aws-sdk/client-dynamodb', infra: { name: 'DynamoDB', subtype: 'database', technology: 'AWS DynamoDB' } },
  { prefix: '@aws-sdk/client-sqs', infra: { name: 'Amazon SQS', subtype: 'broker', technology: 'AWS SQS' } },
  { prefix: '@aws-sdk/client-sns', infra: { name: 'Amazon SNS', subtype: 'broker', technology: 'AWS SNS' } },
  { prefix: '@aws-sdk/client-secretsmanager', infra: { name: 'Secrets Manager', subtype: 'infrastructure', technology: 'AWS Secrets Manager' } },
  { prefix: '@azure/storage-blob', infra: { name: 'Azure Blob Storage', subtype: 'infrastructure', technology: 'Azure Blob Storage' } },
  { prefix: '@azure/service-bus', infra: { name: 'Azure Service Bus', subtype: 'broker', technology: 'Azure Service Bus' } },
  { prefix: '@azure/cosmos', infra: { name: 'Cosmos DB', subtype: 'database', technology: 'Azure Cosmos DB' } },
  { prefix: '@google-cloud/pubsub', infra: { name: 'Cloud Pub/Sub', subtype: 'broker', technology: 'GCP Pub/Sub' } },
  { prefix: '@google-cloud/storage', infra: { name: 'Cloud Storage', subtype: 'infrastructure', technology: 'GCP Cloud Storage' } },
  { prefix: '@google-cloud/bigquery', infra: { name: 'BigQuery', subtype: 'database', technology: 'GCP BigQuery' } },
  { prefix: 'boto3', infra: { name: 'AWS', subtype: 'infrastructure', technology: 'AWS SDK' } },
  { prefix: 'google.cloud', infra: { name: 'Google Cloud', subtype: 'infrastructure', technology: 'GCP SDK' } },
  { prefix: 'azure.', infra: { name: 'Azure', subtype: 'infrastructure', technology: 'Azure SDK' } },
  { prefix: 'awssdk', infra: { name: 'AWS', subtype: 'infrastructure', technology: 'AWS SDK' } },
];

function lookupDependency(rawName: string): Infrastructure | undefined {
  const name = rawName.toLowerCase().replace(/^@types\//, '');
  const direct = KNOWN_DEPENDENCIES[name];
  if (direct) return direct;

  for (const entry of DEPENDENCY_PREFIXES) {
    if (name.startsWith(entry.prefix)) return entry.infra;
  }
  // Go module paths and .NET namespaces: try progressively shorter suffixes,
  // so `github.com/redis/go-redis/v9` still resolves.
  const segments = name.split(/[/.]/);
  for (let start = 0; start < segments.length; start += 1) {
    for (let end = segments.length; end > start; end -= 1) {
      const slashJoined = segments.slice(start, end).join('/');
      const hit = KNOWN_DEPENDENCIES[slashJoined];
      if (hit) return hit;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Framework markers: what makes a file an architectural component
// ---------------------------------------------------------------------------

interface FrameworkRule {
  readonly id: string;
  readonly confidence: Confidence;
  readonly languages: readonly string[];
  readonly pattern: RegExp;
  readonly subtype: string;
  readonly technology: string;
  /** Capture group holding the component name, when the marker provides one. */
  readonly nameGroup?: number;
}

const FRAMEWORK_RULES: readonly FrameworkRule[] = [
  // JavaScript / TypeScript
  { id: 'nest/controller', confidence: 'high', languages: ['javascript'], pattern: /@Controller\s*\(/, subtype: 'api', technology: 'NestJS' },
  { id: 'nest/injectable', confidence: 'high', languages: ['javascript'], pattern: /@Injectable\s*\(/, subtype: 'service', technology: 'NestJS' },
  { id: 'express/app', confidence: 'medium', languages: ['javascript'], pattern: /\b(?:express\s*\(\s*\)|Router\s*\(\s*\))/, subtype: 'api', technology: 'Express' },
  { id: 'fastify/app', confidence: 'medium', languages: ['javascript'], pattern: /\bfastify\s*\(/, subtype: 'api', technology: 'Fastify' },
  { id: 'koa/app', confidence: 'medium', languages: ['javascript'], pattern: /new\s+Koa\s*\(/, subtype: 'api', technology: 'Koa' },
  { id: 'graphql/server', confidence: 'medium', languages: ['javascript'], pattern: /new\s+ApolloServer\s*\(|buildSchema\s*\(/, subtype: 'api', technology: 'GraphQL' },

  // Python
  { id: 'fastapi/app', confidence: 'high', languages: ['python'], pattern: /\bFastAPI\s*\(/, subtype: 'api', technology: 'FastAPI' },
  { id: 'flask/app', confidence: 'high', languages: ['python'], pattern: /\bFlask\s*\(\s*__name__/, subtype: 'api', technology: 'Flask' },
  { id: 'django/view', confidence: 'medium', languages: ['python'], pattern: /\bclass\s+(\w+)\s*\(\s*(?:APIView|ViewSet|ModelViewSet|generics\.)/, subtype: 'api', technology: 'Django REST', nameGroup: 1 },
  { id: 'celery/worker', confidence: 'high', languages: ['python'], pattern: /@(?:app|celery)\.task\b|Celery\s*\(/, subtype: 'service', technology: 'Celery' },

  // Go
  { id: 'go/http-handler', confidence: 'medium', languages: ['go'], pattern: /http\.(?:HandleFunc|Handle)\s*\(|http\.ListenAndServe\s*\(/, subtype: 'api', technology: 'net/http' },
  { id: 'gin/router', confidence: 'high', languages: ['go'], pattern: /gin\.(?:Default|New)\s*\(/, subtype: 'api', technology: 'Gin' },
  { id: 'echo/router', confidence: 'high', languages: ['go'], pattern: /echo\.New\s*\(/, subtype: 'api', technology: 'Echo' },
  { id: 'fiber/router', confidence: 'high', languages: ['go'], pattern: /fiber\.New\s*\(/, subtype: 'api', technology: 'Fiber' },

  // .NET
  { id: 'aspnet/controller', confidence: 'high', languages: ['dotnet'], pattern: /\[ApiController\]|\[Route\s*\(/, subtype: 'api', technology: 'ASP.NET Core' },
  { id: 'aspnet/minimal-api', confidence: 'medium', languages: ['dotnet'], pattern: /app\.Map(?:Get|Post|Put|Delete)\s*\(/, subtype: 'api', technology: 'ASP.NET Core' },

  // Ruby, PHP, Rust
  { id: 'rails/controller', confidence: 'high', languages: ['ruby'], pattern: /class\s+(\w+)\s*<\s*(?:ApplicationController|ActionController)/, subtype: 'api', technology: 'Rails', nameGroup: 1 },
  { id: 'laravel/controller', confidence: 'high', languages: ['php'], pattern: /class\s+(\w+)\s+extends\s+Controller\b/, subtype: 'api', technology: 'Laravel', nameGroup: 1 },
  { id: 'axum/router', confidence: 'high', languages: ['rust'], pattern: /Router::new\s*\(/, subtype: 'api', technology: 'Axum' },
  { id: 'actix/server', confidence: 'high', languages: ['rust'], pattern: /HttpServer::new\s*\(/, subtype: 'api', technology: 'Actix Web' },
];

/** Import/require forms per language, each capturing the package name. */
const IMPORT_PATTERNS: readonly RegExp[] = [
  /(?:^|\s)import\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
  /(?:^|\s)from\s+([\w.]+)\s+import\b/,
  /(?:^|\s)import\s+([\w.]+)(?:\s+as\s+\w+)?\s*$/,
  /(?:^|\s)use\s+([\w:]+)/,
  /(?:^|\s)using\s+([\w.]+)\s*;/,
  /^\s*"?([\w.\-/]+)"?\s+v[\d]/,
  /(?:^|\s)require\s+['"]([^'"]+)['"]/,
];

/** Topic, queue and stream names, so messaging targets get real identities. */
const TOPIC_PATTERNS: readonly RegExp[] = [
  /\btopic\s*[:=]\s*['"]([\w.\-]+)['"]/i,
  /\btopics\s*[:=]\s*\[?\s*['"]([\w.\-]+)['"]/i,
  /\bsubscribe\s*\(\s*\{?\s*topic\s*:\s*['"]([\w.\-]+)['"]/i,
  /\b(?:queue|queue_name|routing_key)\s*[:=]\s*['"]([\w.\-]+)['"]/i,
  /\bQueueUrl\s*[:=]\s*['"][^'"]*\/([\w.\-]+)['"]/,
  /\bsend\s*\(\s*['"]([\w.\-]+)['"]/,
];

const URL_PATTERN = /['"]https?:\/\/([a-z0-9.\-]+(?::\d+)?)[^'"]*['"]/i;
const JDBC_URL_PATTERN = /(?:jdbc:)?(postgresql|postgres|mysql|mariadb|oracle|sqlserver|mongodb|redis):\/\/([^\s'"]+)/i;

const COMMENT_PREFIXES = ['//', '*', '#', '--', '<!--', '/*'];

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const SNIPPET_MAX = 160;

export async function scanPolyglot(
  source: FileSource,
  options: ScannerOptions = {},
): Promise<ScanResult> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const include = (options.include ?? [])
    .map((prefix) => prefix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter((prefix) => prefix !== '');

  const components = new Map<string, InferredComponent>();
  const externals = new Map<string, InferredExternal>();
  const relations = new Map<string, InferredRelation>();
  const signals = new Map<string, InferredSignal>();
  const files: string[] = [];
  const skippedFiles: string[] = [];

  const refs = await source.list();

  for (const ref of refs) {
    const path = ref.path;
    if (isIgnoredPath(path)) continue;
    if (include.length > 0 && !include.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      continue;
    }
    // The JVM scanner owns Java and Kotlin; skipping them here avoids two
    // detectors racing to describe the same class with different confidence.
    const language = languageOf(path);
    if (language === 'jvm' && !isManifest(path)) continue;

    if (ref.size > maxFileBytes) {
      skippedFiles.push(path);
      continue;
    }

    const text = await source.read(path);
    if (text === '') {
      files.push(path);
      continue;
    }
    files.push(path);
    const lines = text.split(/\r?\n/);
    const module = moduleOf(path);

    const record = {
      external: (infra: Infrastructure, detector: string, confidence: Confidence, evidence: Evidence, targetName?: string, unresolved?: boolean): string => {
        const name = targetName ?? infra.name;
        const id = externalId(infra.subtype, name);
        const existing = externals.get(id);
        if (existing) {
          externals.set(id, {
            ...existing,
            unresolved: existing.unresolved && (unresolved ?? false),
            provenance: mergeProvenance(existing.provenance, detector, confidence, evidence),
          });
        } else {
          externals.set(id, {
            id,
            name,
            subtype: infra.subtype,
            technology: infra.technology,
            unresolved: unresolved ?? false,
            provenance: { source: 'inferred', detector, confidence, evidence: [evidence] },
          });
        }
        return id;
      },
      relation: (sourceId: string, destId: string, direction: 'outbound' | 'inbound', detector: string, confidence: Confidence, evidence: Evidence, technology?: string, description?: string): void => {
        const id = `${sourceId}->${destId}:${detector}`;
        const existing = relations.get(id);
        if (existing) {
          relations.set(id, {
            ...existing,
            provenance: mergeProvenance(existing.provenance, detector, confidence, evidence),
          });
          return;
        }
        relations.set(id, {
          id,
          sourceId,
          destId,
          direction,
          technology,
          description,
          provenance: { source: 'inferred', detector, confidence, evidence: [evidence] },
        });
      },
    };

    const moduleComponentId = moduleId(module);

    if (isManifest(path)) {
      scanManifest(path, lines, module, moduleComponentId, record);
      continue;
    }
    if (isInfra(path)) {
      scanInfra(path, lines, module, moduleComponentId, record, signals);
      continue;
    }
    if (!language) continue;

    // --- framework markers -> components
    for (const rule of FRAMEWORK_RULES) {
      if (!rule.languages.includes(language)) continue;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] as string;
        if (isComment(line)) continue;
        const match = rule.pattern.exec(line);
        if (!match) continue;

        const name =
          (rule.nameGroup !== undefined ? match[rule.nameGroup] : undefined) ??
          nearbyClassName(lines, index) ??
          fileBaseName(path);
        const id = slug(splitCamel(name)) || slug(fileBaseName(path));
        if (!components.has(id)) {
          components.set(id, {
            id,
            name,
            subtype: rule.subtype,
            sourcePath: path,
            module,
            technology: rule.technology,
            provenance: {
              source: 'inferred',
              detector: rule.id,
              confidence: rule.confidence,
              evidence: [evidenceAt(path, index, line)],
            },
          });
        }
        break; // one component per rule per file is enough
      }
    }

    // --- imports -> infrastructure dependencies
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] as string;
      if (isComment(line)) continue;

      for (const pattern of IMPORT_PATTERNS) {
        const match = pattern.exec(line);
        const packageName = match?.[1];
        if (!packageName) continue;
        const infra = lookupDependency(packageName);
        if (!infra) continue;

        const evidence = evidenceAt(path, index, line);
        // Messaging: try to name the actual topic somewhere in this file.
        let targetName: string | undefined;
        let unresolved = false;
        if (infra.subtype === 'broker' || infra.subtype === 'topic') {
          const topic = findTopicName(lines);
          if (topic) targetName = topic;
        } else if (infra.subtype === 'system') {
          const host = findHost(lines);
          if (host) targetName = host;
          else unresolved = true;
        }

        const subtype: ExternalSubtype =
          (infra.subtype === 'broker' || infra.subtype === 'topic') && targetName ? 'topic' : infra.subtype;
        const externalKey = record.external(
          { ...infra, subtype },
          `dep/${slug(packageName)}`,
          infra.subtype === 'system' && unresolved ? 'low' : 'medium',
          evidence,
          targetName,
          unresolved,
        );
        record.relation(
          moduleComponentId,
          externalKey,
          infra.direction ?? 'outbound',
          `dep/${slug(packageName)}`,
          infra.subtype === 'system' && unresolved ? 'low' : 'medium',
          evidence,
          infra.technology,
        );
        break;
      }

      // --- explicit connection URLs are the strongest signal available
      const urlMatch = JDBC_URL_PATTERN.exec(line);
      if (urlMatch) {
        const engine = (urlMatch[1] ?? '').toLowerCase();
        const infra = engineInfrastructure(engine);
        if (infra) {
          const evidence = evidenceAt(path, index, line);
          const dbName = databaseNameFromUrl(urlMatch[2] ?? '');
          const key = record.external(infra, 'config/connection-url', 'high', evidence, dbName ? `${infra.name} ${dbName}` : undefined);
          record.relation(moduleComponentId, key, 'outbound', 'config/connection-url', 'high', evidence, infra.technology);
        }
      }
    }
  }

  return {
    components: sortBy([...components.values()], (item) => item.id),
    externals: sortBy([...externals.values()], (item) => item.id),
    relations: sortBy([...relations.values()], (item) => item.id),
    signals: sortBy([...signals.values()], (item) => item.id),
    files: files.sort(compareIds),
    skippedFiles: skippedFiles.sort(compareIds),
  };
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

interface Recorder {
  external(
    infra: Infrastructure,
    detector: string,
    confidence: Confidence,
    evidence: Evidence,
    targetName?: string,
    unresolved?: boolean,
  ): string;
  relation(
    sourceId: string,
    destId: string,
    direction: 'outbound' | 'inbound',
    detector: string,
    confidence: Confidence,
    evidence: Evidence,
    technology?: string,
    description?: string,
  ): void;
}

const MANIFEST_BASENAMES = new Set([
  'package.json',
  'requirements.txt',
  'requirements-dev.txt',
  'pyproject.toml',
  'pipfile',
  'go.mod',
  'cargo.toml',
  'gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
]);

function isManifest(path: string): boolean {
  const base = basenameOf(path).toLowerCase();
  return MANIFEST_BASENAMES.has(base) || base.endsWith('.csproj') || base.endsWith('.fsproj');
}

/**
 * Dependency manifests are the highest-signal, lowest-effort source of truth
 * about infrastructure: a repository that depends on `ioredis` uses Redis,
 * whatever the code looks like. They are also uniform enough that one loose
 * line scan covers every ecosystem.
 */
function scanManifest(
  path: string,
  lines: readonly string[],
  module: string,
  moduleComponentId: string,
  record: Recorder,
): void {
  void module;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (isComment(line)) continue;

    // Covers `"pg": "^8"`, `psycopg2==2.9`, `require github.com/x/y v1`,
    // `gem "redis"`, `<PackageReference Include="StackExchange.Redis" .../>`,
    // and `implementation 'org.postgresql:postgresql'`.
    const candidates = [
      /^\s*"([^"]+)"\s*:/,
      /^\s*([A-Za-z0-9_.\-]+)\s*(?:[=<>~!]=|@)/,
      /^\s*([A-Za-z0-9_.\-/]+)\s+v?\d+\./,
      /gem\s+['"]([^'"]+)['"]/,
      /Include\s*=\s*"([^"]+)"/,
      /['"]([a-z0-9_.\-]+:[a-z0-9_.\-]+)(?::[^'"]*)?['"]/i,
      /^\s*([A-Za-z0-9_.\-]+)\s*=\s*['"]/,
    ];

    for (const pattern of candidates) {
      const match = pattern.exec(line);
      const raw = match?.[1];
      if (!raw) continue;
      // Maven/Gradle coordinates: the artefact id carries the meaning.
      const name = raw.includes(':') ? (raw.split(':').pop() as string) : raw;
      const infra = lookupDependency(name);
      if (!infra) continue;

      const evidence = evidenceAt(path, index, line);
      const unresolved = infra.subtype === 'system';
      const key = record.external(infra, `manifest/${slug(name)}`, 'medium', evidence, undefined, unresolved);
      record.relation(moduleComponentId, key, infra.direction ?? 'outbound', `manifest/${slug(name)}`, 'medium', evidence, infra.technology);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Containers and infrastructure as code
// ---------------------------------------------------------------------------

/** Well-known container images, matched as a prefix of the image reference. */
const IMAGE_MAP: readonly { match: string; infra: Infrastructure }[] = [
  { match: 'postgres', infra: { name: 'PostgreSQL', subtype: 'database', technology: 'PostgreSQL' } },
  { match: 'mysql', infra: { name: 'MySQL', subtype: 'database', technology: 'MySQL' } },
  { match: 'mariadb', infra: { name: 'MariaDB', subtype: 'database', technology: 'MariaDB' } },
  { match: 'mongo', infra: { name: 'MongoDB', subtype: 'database', technology: 'MongoDB' } },
  { match: 'redis', infra: { name: 'Redis', subtype: 'cache', technology: 'Redis' } },
  { match: 'memcached', infra: { name: 'Memcached', subtype: 'cache', technology: 'Memcached' } },
  { match: 'kafka', infra: { name: 'Kafka', subtype: 'broker', technology: 'Apache Kafka' } },
  { match: 'zookeeper', infra: { name: 'ZooKeeper', subtype: 'infrastructure', technology: 'Apache ZooKeeper' } },
  { match: 'rabbitmq', infra: { name: 'RabbitMQ', subtype: 'broker', technology: 'RabbitMQ' } },
  { match: 'nats', infra: { name: 'NATS', subtype: 'broker', technology: 'NATS' } },
  { match: 'elasticsearch', infra: { name: 'Elasticsearch', subtype: 'database', technology: 'Elasticsearch' } },
  { match: 'opensearch', infra: { name: 'OpenSearch', subtype: 'database', technology: 'OpenSearch' } },
  { match: 'clickhouse', infra: { name: 'ClickHouse', subtype: 'database', technology: 'ClickHouse' } },
  { match: 'nginx', infra: { name: 'nginx', subtype: 'proxy', technology: 'nginx' } },
  { match: 'traefik', infra: { name: 'Traefik', subtype: 'proxy', technology: 'Traefik' } },
  { match: 'envoyproxy', infra: { name: 'Envoy', subtype: 'proxy', technology: 'Envoy' } },
  { match: 'haproxy', infra: { name: 'HAProxy', subtype: 'proxy', technology: 'HAProxy' } },
  { match: 'minio', infra: { name: 'MinIO', subtype: 'infrastructure', technology: 'MinIO' } },
  { match: 'localstack', infra: { name: 'LocalStack', subtype: 'infrastructure', technology: 'LocalStack' } },
  { match: 'vault', infra: { name: 'Vault', subtype: 'infrastructure', technology: 'HashiCorp Vault' } },
  { match: 'prometheus', infra: { name: 'Prometheus', subtype: 'infrastructure', technology: 'Prometheus' } },
  { match: 'grafana', infra: { name: 'Grafana', subtype: 'infrastructure', technology: 'Grafana' } },
  { match: 'jaeger', infra: { name: 'Jaeger', subtype: 'infrastructure', technology: 'Jaeger' } },
  { match: 'keycloak', infra: { name: 'Keycloak', subtype: 'system', technology: 'Keycloak' } },
];

/** Terraform resource type prefixes worth surfacing. */
const TERRAFORM_MAP: readonly { match: string; infra: Infrastructure }[] = [
  { match: 'aws_db_instance', infra: { name: 'Amazon RDS', subtype: 'database', technology: 'AWS RDS' } },
  { match: 'aws_rds_cluster', infra: { name: 'Amazon Aurora', subtype: 'database', technology: 'AWS Aurora' } },
  { match: 'aws_dynamodb_table', infra: { name: 'DynamoDB', subtype: 'database', technology: 'AWS DynamoDB' } },
  { match: 'aws_elasticache', infra: { name: 'ElastiCache', subtype: 'cache', technology: 'AWS ElastiCache' } },
  { match: 'aws_s3_bucket', infra: { name: 'Amazon S3', subtype: 'infrastructure', technology: 'AWS S3' } },
  { match: 'aws_sqs_queue', infra: { name: 'Amazon SQS', subtype: 'broker', technology: 'AWS SQS' } },
  { match: 'aws_sns_topic', infra: { name: 'Amazon SNS', subtype: 'broker', technology: 'AWS SNS' } },
  { match: 'aws_msk_cluster', infra: { name: 'Amazon MSK', subtype: 'broker', technology: 'AWS MSK' } },
  { match: 'aws_lb', infra: { name: 'Load balancer', subtype: 'proxy', technology: 'AWS ELB' } },
  { match: 'aws_eks_cluster', infra: { name: 'EKS', subtype: 'infrastructure', technology: 'AWS EKS' } },
  { match: 'aws_lambda_function', infra: { name: 'Lambda', subtype: 'system', technology: 'AWS Lambda' } },
  { match: 'google_sql_database', infra: { name: 'Cloud SQL', subtype: 'database', technology: 'GCP Cloud SQL' } },
  { match: 'google_pubsub_topic', infra: { name: 'Cloud Pub/Sub', subtype: 'broker', technology: 'GCP Pub/Sub' } },
  { match: 'azurerm_postgresql', infra: { name: 'Azure PostgreSQL', subtype: 'database', technology: 'Azure Database for PostgreSQL' } },
  { match: 'azurerm_servicebus', infra: { name: 'Azure Service Bus', subtype: 'broker', technology: 'Azure Service Bus' } },
];

function isInfra(path: string): boolean {
  const base = basenameOf(path).toLowerCase();
  if (base.startsWith('dockerfile') || base === 'containerfile') return true;
  if (/^docker-compose(\.[\w-]+)?\.ya?ml$/.test(base)) return true;
  if (base === 'chart.yaml' || base === 'values.yaml' || base === 'skaffold.yaml') return true;
  if (base.endsWith('.tf') || base.endsWith('.tfvars') || base.endsWith('.hcl')) return true;
  if (base.endsWith('.yml') || base.endsWith('.yaml')) return true; // possible k8s manifest
  return false;
}

function scanInfra(
  path: string,
  lines: readonly string[],
  module: string,
  moduleComponentId: string,
  record: Recorder,
  signals: Map<string, InferredSignal>,
): void {
  void signals;
  const base = basenameOf(path).toLowerCase();
  const isTerraform = base.endsWith('.tf') || base.endsWith('.tfvars') || base.endsWith('.hcl');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (isComment(line)) continue;

    if (isTerraform) {
      const match = /resource\s+"([a-z0-9_]+)"/i.exec(line);
      const type = match?.[1];
      if (type) {
        const entry = TERRAFORM_MAP.find((candidate) => type.startsWith(candidate.match));
        if (entry) {
          const evidence = evidenceAt(path, index, line);
          const key = record.external(entry.infra, 'terraform/resource', 'high', evidence);
          record.relation(moduleComponentId, key, 'outbound', 'terraform/resource', 'high', evidence, entry.infra.technology);
        }
      }
      continue;
    }

    // `image: postgres:16`, `FROM redis:7`
    const imageMatch = /(?:^\s*image\s*:\s*|^\s*FROM\s+)["']?([\w./\-]+)(?::[\w.\-]+)?["']?/i.exec(line);
    const image = imageMatch?.[1];
    if (image) {
      const bare = (image.split('/').pop() ?? image).toLowerCase();
      const entry = IMAGE_MAP.find((candidate) => bare.startsWith(candidate.match));
      if (entry) {
        const evidence = evidenceAt(path, index, line);
        const detector = base.startsWith('dockerfile') ? 'docker/from' : 'compose/image';
        const key = record.external(entry.infra, detector, 'medium', evidence);
        record.relation(moduleComponentId, key, 'outbound', detector, 'medium', evidence, entry.infra.technology);
      }
    }

    // Connection strings in Kubernetes or Compose environment blocks.
    const urlMatch = JDBC_URL_PATTERN.exec(line);
    if (urlMatch) {
      const infra = engineInfrastructure((urlMatch[1] ?? '').toLowerCase());
      if (infra) {
        const evidence = evidenceAt(path, index, line);
        const key = record.external(infra, 'config/connection-url', 'high', evidence);
        record.relation(moduleComponentId, key, 'outbound', 'config/connection-url', 'high', evidence, infra.technology);
      }
    }
  }
  void module;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function engineInfrastructure(engine: string): Infrastructure | undefined {
  switch (engine) {
    case 'postgres':
    case 'postgresql':
      return { name: 'PostgreSQL', subtype: 'database', technology: 'PostgreSQL' };
    case 'mysql':
    case 'mariadb':
      return { name: 'MySQL', subtype: 'database', technology: 'MySQL' };
    case 'oracle':
      return { name: 'Oracle', subtype: 'database', technology: 'Oracle Database' };
    case 'sqlserver':
      return { name: 'SQL Server', subtype: 'database', technology: 'Microsoft SQL Server' };
    case 'mongodb':
      return { name: 'MongoDB', subtype: 'database', technology: 'MongoDB' };
    case 'redis':
      return { name: 'Redis', subtype: 'cache', technology: 'Redis' };
    default:
      return undefined;
  }
}

function databaseNameFromUrl(rest: string): string | undefined {
  const path = rest.split(/[?#]/)[0] ?? '';
  const segments = path.split('/').filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  if (!last || last.includes(':') || last.includes('@')) return undefined;
  return last;
}

function findTopicName(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    if (isComment(line)) continue;
    for (const pattern of TOPIC_PATTERNS) {
      const match = pattern.exec(line);
      if (match?.[1]) return match[1];
    }
  }
  return undefined;
}

function findHost(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    if (isComment(line)) continue;
    const match = URL_PATTERN.exec(line);
    const host = match?.[1];
    // Localhost tells us nothing about the architecture.
    if (host && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(host)) return host;
  }
  return undefined;
}

/** The nearest class/struct/function name at or above `index`. */
function nearbyClassName(lines: readonly string[], index: number): string | undefined {
  for (let i = index; i < Math.min(lines.length, index + 6); i += 1) {
    const match = /\b(?:class|struct|interface|func|def|type)\s+([A-Za-z_]\w*)/.exec(lines[i] as string);
    if (match?.[1]) return match[1];
  }
  for (let i = index; i >= Math.max(0, index - 6); i -= 1) {
    const match = /\b(?:class|struct|interface|func|def|type)\s+([A-Za-z_]\w*)/.exec(lines[i] as string);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function fileBaseName(path: string): string {
  const base = basenameOf(path);
  const dot = base.indexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function isComment(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  return COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function evidenceAt(path: string, index: number, line: string): Evidence {
  return {
    file: path,
    line: index + 1,
    snippet: line.trim().slice(0, SNIPPET_MAX),
  };
}

/**
 * Merges a second sighting into existing provenance: keeps the highest
 * confidence seen, accumulates evidence, and caps the list so a dependency
 * used in two hundred files does not produce a two-hundred-line report.
 */
function mergeProvenance(
  existing: InferredProvenance,
  detector: string,
  confidence: Confidence,
  evidence: Evidence,
): InferredProvenance {
  const order = { low: 0, medium: 1, high: 2 } as const;
  const best = order[confidence] > order[existing.confidence] ? confidence : existing.confidence;
  const combined = [...existing.evidence, evidence]
    .filter(
      (item, position, all) =>
        all.findIndex((other) => other.file === item.file && other.line === item.line) === position,
    )
    .sort((a, b) => compareIds(`${a.file}:${String(a.line).padStart(6, '0')}`, `${b.file}:${String(b.line).padStart(6, '0')}`))
    .slice(0, 8);

  return {
    source: 'inferred',
    detector: order[confidence] > order[existing.confidence] ? detector : existing.detector,
    confidence: best,
    evidence: combined,
  };
}

function externalId(subtype: ExternalSubtype, name: string): string {
  return `${subtype}-${slug(name) || 'unknown'}`;
}

/**
 * The build module a file belongs to: everything before `/src/`, else the
 * file's directory. Matches the Java scanner so both attribute facts to the
 * same module and drift can bind them with one `source` path.
 */
function moduleOf(path: string): string {
  const index = path.indexOf('/src/');
  if (index >= 0) return path.slice(0, index);
  if (path.startsWith('src/')) return '';
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function moduleId(module: string): string {
  return `module-${slug(module) || 'root'}`;
}

function splitCamel(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

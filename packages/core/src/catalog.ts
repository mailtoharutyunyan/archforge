/**
 * The authoring palette.
 *
 * A freeform tool's palette offers shapes: rectangle, ellipse, cylinder. You
 * drag one out and then you have a picture of a cylinder, which means nothing
 * to anything. This palette offers *meaning*: dragging "PostgreSQL" produces a
 * database element with its technology set, so it renders with the right icon,
 * participates in rules, appears in the technology inventory, and can be drift
 * checked against real code. The shape is a consequence, not the point.
 *
 * Entries are data. Adding a technology is one row, and it immediately gains
 * an icon (via the resolver's alias table) and search coverage.
 */

export interface PaletteEntry {
  /** Stable id, used as a drag payload and in tests. */
  readonly id: string;
  readonly label: string;
  /** DSL keyword to emit. Structural kind follows from where it is dropped. */
  readonly keyword: string;
  /** Written as `technology "..."` when present. Also drives icon resolution. */
  readonly technology?: string;
  readonly group: string;
  /** Extra search terms that are not in the label. */
  readonly search?: readonly string[];
}

export const PALETTE_GROUPS: readonly string[] = [
  'Building blocks',
  'Applications',
  'Languages & frameworks',
  'Data stores',
  'Messaging',
  'Infrastructure',
  'Cloud',
  'Observability',
  'Third parties',
];

/** Structural building blocks: no technology, just a kind. */
const BUILDING_BLOCKS: readonly PaletteEntry[] = [
  { id: 'person', label: 'Person', keyword: 'person', group: 'Building blocks', search: ['actor', 'user', 'customer'] },
  { id: 'system', label: 'System', keyword: 'system', group: 'Building blocks', search: ['software system'] },
  { id: 'container', label: 'Container', keyword: 'container', group: 'Building blocks', search: ['service', 'app'] },
  { id: 'component', label: 'Component', keyword: 'component', group: 'Building blocks', search: ['class', 'module'] },
  { id: 'api', label: 'API', keyword: 'api', group: 'Building blocks', search: ['rest', 'endpoint'] },
  { id: 'service', label: 'Service', keyword: 'service', group: 'Building blocks', search: ['worker'] },
  { id: 'database', label: 'Database', keyword: 'database', group: 'Building blocks', search: ['db', 'store'] },
  { id: 'cache', label: 'Cache', keyword: 'cache', group: 'Building blocks' },
  { id: 'queue', label: 'Queue', keyword: 'queue', group: 'Building blocks' },
  { id: 'topic', label: 'Topic', keyword: 'topic', group: 'Building blocks', search: ['stream', 'event'] },
  { id: 'function', label: 'Function', keyword: 'function', group: 'Building blocks', search: ['lambda', 'serverless'] },
  { id: 'deployment-node', label: 'Deployment', keyword: 'deploymentNode', group: 'Building blocks', search: ['host', 'vm', 'cluster'] },
  { id: 'infrastructure-node', label: 'Infra node', keyword: 'infrastructureNode', group: 'Building blocks', search: ['managed'] },
];

const APPLICATIONS: readonly PaletteEntry[] = [
  { id: 'web-app', label: 'React web app', keyword: 'browser', technology: 'TypeScript / React', group: 'Applications' },
  { id: 'spa', label: 'Vue app', keyword: 'browser', technology: 'TypeScript / Vue', group: 'Applications' },
  { id: 'next', label: 'Next.js app', keyword: 'browser', technology: 'TypeScript / Next.js', group: 'Applications', search: ['ssr'] },
  { id: 'angular', label: 'Angular app', keyword: 'browser', technology: 'TypeScript / Angular', group: 'Applications' },
  { id: 'ios', label: 'iOS app', keyword: 'mobileApp', technology: 'Swift / SwiftUI', group: 'Applications', search: ['apple', 'mobile'] },
  { id: 'android', label: 'Android app', keyword: 'mobileApp', technology: 'Kotlin / Compose', group: 'Applications', search: ['mobile'] },
  { id: 'flutter', label: 'Flutter app', keyword: 'mobileApp', technology: 'Dart / Flutter', group: 'Applications', search: ['mobile', 'cross platform'] },
  { id: 'cli', label: 'CLI', keyword: 'container', technology: 'Command line', group: 'Applications', search: ['terminal'] },
];

const LANGUAGES: readonly PaletteEntry[] = [
  { id: 'spring', label: 'Spring Boot', keyword: 'container', technology: 'Java 21 / Spring Boot', group: 'Languages & frameworks', search: ['java', 'jvm'] },
  { id: 'ktor', label: 'Kotlin / Ktor', keyword: 'container', technology: 'Kotlin / Ktor', group: 'Languages & frameworks', search: ['jvm'] },
  { id: 'nest', label: 'NestJS', keyword: 'container', technology: 'Node 22 / NestJS', group: 'Languages & frameworks', search: ['node', 'typescript'] },
  { id: 'express', label: 'Express', keyword: 'container', technology: 'Node 22 / Express', group: 'Languages & frameworks', search: ['node'] },
  { id: 'fastify', label: 'Fastify', keyword: 'container', technology: 'Node 22 / Fastify', group: 'Languages & frameworks', search: ['node'] },
  { id: 'fastapi', label: 'FastAPI', keyword: 'container', technology: 'Python 3.12 / FastAPI', group: 'Languages & frameworks', search: ['python'] },
  { id: 'django', label: 'Django', keyword: 'container', technology: 'Python 3.12 / Django', group: 'Languages & frameworks', search: ['python'] },
  { id: 'flask', label: 'Flask', keyword: 'container', technology: 'Python 3.12 / Flask', group: 'Languages & frameworks', search: ['python'] },
  { id: 'go', label: 'Go', keyword: 'container', technology: 'Go 1.23', group: 'Languages & frameworks', search: ['golang'] },
  { id: 'rust', label: 'Rust', keyword: 'container', technology: 'Rust', group: 'Languages & frameworks', search: ['axum', 'actix'] },
  { id: 'dotnet', label: 'ASP.NET', keyword: 'container', technology: '.NET 9 / ASP.NET Core', group: 'Languages & frameworks', search: ['csharp', 'c#'] },
  { id: 'rails', label: 'Ruby on Rails', keyword: 'container', technology: 'Ruby on Rails', group: 'Languages & frameworks', search: ['ruby'] },
  { id: 'laravel', label: 'Laravel', keyword: 'container', technology: 'PHP / Laravel', group: 'Languages & frameworks', search: ['php'] },
  { id: 'graphql', label: 'GraphQL API', keyword: 'api', technology: 'GraphQL', group: 'Languages & frameworks', search: ['apollo', 'bff'] },
  { id: 'grpc', label: 'gRPC service', keyword: 'api', technology: 'gRPC', group: 'Languages & frameworks', search: ['protobuf'] },
  { id: 'spark', label: 'Spark job', keyword: 'service', technology: 'Scala / Apache Spark', group: 'Languages & frameworks', search: ['batch', 'etl'] },
  { id: 'airflow', label: 'Airflow DAG', keyword: 'service', technology: 'Python / Airflow', group: 'Languages & frameworks', search: ['scheduler', 'batch'] },
];

const DATA_STORES: readonly PaletteEntry[] = [
  { id: 'postgres', label: 'PostgreSQL', keyword: 'database', technology: 'PostgreSQL 16', group: 'Data stores', search: ['postgres', 'sql', 'rdbms'] },
  { id: 'mysql', label: 'MySQL', keyword: 'database', technology: 'MySQL 8', group: 'Data stores', search: ['sql'] },
  { id: 'mariadb', label: 'MariaDB', keyword: 'database', technology: 'MariaDB', group: 'Data stores', search: ['sql'] },
  { id: 'sqlserver', label: 'SQL Server', keyword: 'database', technology: 'Microsoft SQL Server', group: 'Data stores', search: ['mssql'] },
  { id: 'oracle', label: 'Oracle', keyword: 'database', technology: 'Oracle Database', group: 'Data stores' },
  { id: 'sqlite', label: 'SQLite', keyword: 'database', technology: 'SQLite', group: 'Data stores', search: ['embedded'] },
  { id: 'mongodb', label: 'MongoDB', keyword: 'database', technology: 'MongoDB 7', group: 'Data stores', search: ['document', 'nosql'] },
  { id: 'cassandra', label: 'Cassandra', keyword: 'database', technology: 'Apache Cassandra', group: 'Data stores', search: ['wide column'] },
  { id: 'neo4j', label: 'Neo4j', keyword: 'database', technology: 'Neo4j', group: 'Data stores', search: ['graph'] },
  { id: 'redis', label: 'Redis', keyword: 'cache', technology: 'Redis 7', group: 'Data stores', search: ['cache', 'kv'] },
  { id: 'memcached', label: 'Memcached', keyword: 'cache', technology: 'Memcached', group: 'Data stores' },
  { id: 'elasticsearch', label: 'Elasticsearch', keyword: 'database', technology: 'Elasticsearch 8', group: 'Data stores', search: ['search', 'index'] },
  { id: 'opensearch', label: 'OpenSearch', keyword: 'database', technology: 'OpenSearch', group: 'Data stores', search: ['search'] },
  { id: 'solr', label: 'Apache Solr', keyword: 'database', technology: 'Apache Solr', group: 'Data stores', search: ['search'] },
  { id: 'clickhouse', label: 'ClickHouse', keyword: 'database', technology: 'ClickHouse', group: 'Data stores', search: ['olap', 'analytics'] },
  { id: 'influxdb', label: 'InfluxDB', keyword: 'database', technology: 'InfluxDB', group: 'Data stores', search: ['timeseries', 'metrics'] },
  { id: 'snowflake', label: 'Snowflake', keyword: 'database', technology: 'Snowflake', group: 'Data stores', search: ['warehouse'] },
  { id: 'bigquery', label: 'BigQuery', keyword: 'database', technology: 'GCP BigQuery', group: 'Data stores', search: ['warehouse', 'google'] },
  { id: 'dynamodb', label: 'DynamoDB', keyword: 'database', technology: 'AWS DynamoDB', group: 'Data stores', search: ['aws', 'nosql'] },
  { id: 's3', label: 'Object storage', keyword: 'database', technology: 'AWS S3', group: 'Data stores', search: ['s3', 'bucket', 'blob'] },
];

const MESSAGING: readonly PaletteEntry[] = [
  { id: 'kafka', label: 'Kafka topic', keyword: 'topic', technology: 'Apache Kafka', group: 'Messaging', search: ['stream', 'event'] },
  { id: 'rabbitmq', label: 'RabbitMQ queue', keyword: 'queue', technology: 'RabbitMQ', group: 'Messaging', search: ['amqp'] },
  { id: 'nats', label: 'NATS subject', keyword: 'topic', technology: 'NATS', group: 'Messaging' },
  { id: 'pulsar', label: 'Pulsar topic', keyword: 'topic', technology: 'Apache Pulsar', group: 'Messaging' },
  { id: 'sqs', label: 'Amazon SQS', keyword: 'queue', technology: 'AWS SQS', group: 'Messaging', search: ['aws'] },
  { id: 'sns', label: 'Amazon SNS', keyword: 'topic', technology: 'AWS SNS', group: 'Messaging', search: ['aws', 'pubsub'] },
  { id: 'pubsub', label: 'Pub/Sub', keyword: 'topic', technology: 'GCP Pub/Sub', group: 'Messaging', search: ['google'] },
  { id: 'servicebus', label: 'Azure Svc Bus', keyword: 'queue', technology: 'Azure Service Bus', group: 'Messaging' },
  { id: 'eventbridge', label: 'EventBridge', keyword: 'topic', technology: 'AWS EventBridge', group: 'Messaging', search: ['aws', 'events'] },
];

const INFRASTRUCTURE: readonly PaletteEntry[] = [
  { id: 'nginx', label: 'nginx', keyword: 'service', technology: 'nginx', group: 'Infrastructure', search: ['proxy', 'ingress', 'web server'] },
  { id: 'envoy', label: 'Envoy', keyword: 'service', technology: 'Envoy', group: 'Infrastructure', search: ['proxy', 'mesh'] },
  { id: 'traefik', label: 'Traefik', keyword: 'service', technology: 'Traefik', group: 'Infrastructure', search: ['proxy', 'ingress'] },
  { id: 'haproxy', label: 'HAProxy', keyword: 'service', technology: 'HAProxy', group: 'Infrastructure', search: ['load balancer'] },
  { id: 'kubernetes', label: 'Kubernetes', keyword: 'deploymentNode', technology: 'Kubernetes', group: 'Infrastructure', search: ['k8s', 'eks', 'gke', 'aks'] },
  { id: 'docker', label: 'Docker host', keyword: 'deploymentNode', technology: 'Docker', group: 'Infrastructure', search: ['container'] },
  { id: 'terraform', label: 'Terraform', keyword: 'service', technology: 'Terraform', group: 'Infrastructure', search: ['iac'] },
  { id: 'vault', label: 'Vault', keyword: 'service', technology: 'HashiCorp Vault', group: 'Infrastructure', search: ['secrets'] },
  { id: 'keycloak', label: 'Keycloak', keyword: 'system', technology: 'Keycloak', group: 'Infrastructure', search: ['identity', 'sso', 'oidc'] },
  { id: 'cdn', label: 'CDN', keyword: 'service', technology: 'AWS CloudFront', group: 'Infrastructure', search: ['edge', 'cloudflare'] },
];

const CLOUD: readonly PaletteEntry[] = [
  { id: 'lambda', label: 'AWS Lambda', keyword: 'function', technology: 'AWS Lambda', group: 'Cloud', search: ['serverless'] },
  { id: 'eks', label: 'Amazon EKS', keyword: 'deploymentNode', technology: 'AWS EKS', group: 'Cloud', search: ['kubernetes'] },
  { id: 'ec2', label: 'Amazon EC2', keyword: 'deploymentNode', technology: 'AWS EC2', group: 'Cloud', search: ['vm', 'instance'] },
  { id: 'rds', label: 'Amazon RDS', keyword: 'infrastructureNode', technology: 'AWS RDS', group: 'Cloud', search: ['managed database'] },
  { id: 'elasticache', label: 'ElastiCache', keyword: 'infrastructureNode', technology: 'AWS ElastiCache', group: 'Cloud', search: ['redis'] },
  { id: 'alb', label: 'Load balancer', keyword: 'infrastructureNode', technology: 'AWS ALB', group: 'Cloud', search: ['elb', 'alb'] },
  { id: 'azure-functions', label: 'Azure Functions', keyword: 'function', technology: 'Azure Functions', group: 'Cloud', search: ['serverless'] },
  { id: 'cosmosdb', label: 'Cosmos DB', keyword: 'database', technology: 'Azure Cosmos DB', group: 'Cloud', search: ['azure'] },
  { id: 'cloudrun', label: 'Cloud Run', keyword: 'deploymentNode', technology: 'GCP Cloud Run', group: 'Cloud', search: ['google', 'serverless'] },
  { id: 'gke', label: 'GKE', keyword: 'deploymentNode', technology: 'GCP GKE', group: 'Cloud', search: ['google', 'kubernetes'] },
];

const OBSERVABILITY: readonly PaletteEntry[] = [
  { id: 'prometheus', label: 'Prometheus', keyword: 'service', technology: 'Prometheus', group: 'Observability', search: ['metrics'] },
  { id: 'grafana', label: 'Grafana', keyword: 'browser', technology: 'Grafana', group: 'Observability', search: ['dashboards'] },
  { id: 'jaeger', label: 'Jaeger', keyword: 'service', technology: 'Jaeger', group: 'Observability', search: ['tracing'] },
  { id: 'opentelemetry', label: 'OpenTelemetry', keyword: 'service', technology: 'OpenTelemetry', group: 'Observability', search: ['otel', 'tracing'] },
  { id: 'datadog', label: 'Datadog', keyword: 'system', technology: 'Datadog', group: 'Observability', search: ['monitoring'] },
  { id: 'sentry', label: 'Sentry', keyword: 'system', technology: 'Sentry', group: 'Observability', search: ['errors'] },
];

const THIRD_PARTIES: readonly PaletteEntry[] = [
  { id: 'stripe', label: 'Stripe', keyword: 'system', technology: 'Stripe', group: 'Third parties', search: ['payments'] },
  { id: 'auth0', label: 'Auth0', keyword: 'system', technology: 'Auth0', group: 'Third parties', search: ['identity', 'login'] },
  { id: 'okta', label: 'Okta', keyword: 'system', technology: 'Okta', group: 'Third parties', search: ['identity', 'sso'] },
  { id: 'sendgrid', label: 'SendGrid', keyword: 'system', technology: 'SendGrid', group: 'Third parties', search: ['email'] },
  { id: 'twilio', label: 'Twilio', keyword: 'system', technology: 'Twilio', group: 'Third parties', search: ['sms'] },
  { id: 'github', label: 'GitHub', keyword: 'system', technology: 'GitHub', group: 'Third parties', search: ['git', 'ci'] },
  { id: 'gitlab', label: 'GitLab', keyword: 'system', technology: 'GitLab', group: 'Third parties', search: ['git', 'ci'] },
  { id: 'salesforce', label: 'Salesforce', keyword: 'system', technology: 'Salesforce', group: 'Third parties', search: ['crm'] },
  { id: 'shopify', label: 'Shopify', keyword: 'system', technology: 'Shopify', group: 'Third parties', search: ['commerce'] },
  { id: 'slack', label: 'Slack', keyword: 'system', technology: 'Slack', group: 'Third parties', search: ['chat'] },
];

export const PALETTE: readonly PaletteEntry[] = [
  ...BUILDING_BLOCKS,
  ...APPLICATIONS,
  ...LANGUAGES,
  ...DATA_STORES,
  ...MESSAGING,
  ...INFRASTRUCTURE,
  ...CLOUD,
  ...OBSERVABILITY,
  ...THIRD_PARTIES,
];

export function paletteEntry(id: string): PaletteEntry | undefined {
  return PALETTE.find((entry) => entry.id === id);
}

/**
 * Searches the palette. Ranking is deliberate: a label that starts with the
 * query beats one that merely contains it, which beats a match on a hidden
 * search term. Ties break on label so results never reorder between calls.
 */
export function searchPalette(query: string): PaletteEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...PALETTE];

  const scored: { entry: PaletteEntry; score: number }[] = [];

  for (const entry of PALETTE) {
    const label = entry.label.toLowerCase();
    const technology = (entry.technology ?? '').toLowerCase();
    let score = -1;

    if (label === needle) score = 0;
    else if (label.startsWith(needle)) score = 1;
    else if (label.includes(needle)) score = 2;
    else if (technology.includes(needle)) score = 3;
    else if (entry.search?.some((term) => term.includes(needle))) score = 4;
    else if (entry.keyword.toLowerCase().includes(needle)) score = 5;

    if (score >= 0) scored.push({ entry, score });
  }

  scored.sort((a, b) =>
    a.score !== b.score ? a.score - b.score : a.entry.label < b.entry.label ? -1 : 1,
  );
  return scored.map((item) => item.entry);
}

/** Entries grouped for display, in `PALETTE_GROUPS` order, empties dropped. */
export function paletteByGroup(
  entries: readonly PaletteEntry[] = PALETTE,
): { group: string; entries: PaletteEntry[] }[] {
  return PALETTE_GROUPS.map((group) => ({
    group,
    entries: entries.filter((entry) => entry.group === group),
  })).filter((section) => section.entries.length > 0);
}

/**
 * Icons: an offline registry plus a deterministic resolver.
 *
 * Nothing in this module touches the network or the filesystem. Vendored packs
 * are inlined by `tools/fetch-icons.mjs` into `icons.data.ts`; the built-in
 * glyphs below are hand-drawn and ship in git. Resolution order and pack
 * priority are documented in docs/ICONS.md and never depend on object key
 * order, so the same query always yields the same icon.
 */

import { compareIds } from '../util/canonical.ts';
import { VENDORED_ICONS } from './icons.data.ts';

export interface IconDef {
  /** e.g. 'simpleicons:postgresql' */
  readonly id: string;
  /** 'builtin' | 'simpleicons' | 'devicon' | 'kubernetes' | 'aws' | 'azure' | 'gcp' | 'lucide' | 'tabler' */
  readonly pack: string;
  readonly title: string;
  /** e.g. '0 0 24 24' */
  readonly viewBox: string;
  /** Raw inner SVG markup, no `<svg>` wrapper, no width/height. */
  readonly body: string;
  /** true => the body only references `currentColor`, so the renderer may recolour it. */
  readonly monochrome: boolean;
  /** SPDX id or short license name. */
  readonly license: string;
  /** Upstream URL. */
  readonly source?: string;
}

export interface IconQuery {
  /** ElementKind */
  readonly kind: string;
  readonly subtype?: string;
  readonly technology?: string;
  readonly tags?: readonly string[];
  /** Value of the DSL `icon "..."` property; wins outright when it matches. */
  readonly explicit?: string;
}

/**
 * Fixed pack priority. When a bare name exists in several packs, the first
 * pack in this list wins. Cloud packs are declared but not pre-vendored (see
 * assets/icons/README.md); they only ever match if the user has added files.
 *
 * Devicon leads deliberately: its icons carry their own brand colours, so a
 * PostgreSQL node shows the actual blue elephant rather than a white
 * silhouette. Simple Icons are single-path monochrome marks — excellent
 * coverage, but they have to be tinted, which loses the instant recognition
 * that makes a technology logo useful on a diagram in the first place. So
 * colour first, coverage second.
 */
export const PACK_PRIORITY: readonly string[] = [
  'devicon',
  'kubernetes',
  'aws',
  'azure',
  'gcp',
  'simpleicons',
  'lucide',
  'tabler',
  'builtin',
];

interface PackMeta {
  readonly name: string;
  readonly license: string;
  readonly url: string;
}

const PACK_META: readonly PackMeta[] = [
  { name: 'simpleicons', license: 'CC0-1.0', url: 'https://github.com/simple-icons/simple-icons' },
  { name: 'devicon', license: 'MIT', url: 'https://github.com/devicons/devicon' },
  {
    name: 'kubernetes',
    license: 'Apache-2.0',
    url: 'https://github.com/kubernetes/community/tree/master/icons',
  },
  {
    name: 'aws',
    license: 'AWS Architecture Icons terms; not redistributed',
    url: 'https://aws.amazon.com/architecture/icons/',
  },
  {
    name: 'azure',
    license: 'Microsoft Azure architecture icons terms; not redistributed',
    url: 'https://learn.microsoft.com/en-us/azure/architecture/icons/',
  },
  {
    name: 'gcp',
    license: 'Google Cloud architecture icons terms; not redistributed',
    url: 'https://cloud.google.com/icons',
  },
  { name: 'lucide', license: 'ISC', url: 'https://github.com/lucide-icons/lucide' },
  { name: 'tabler', license: 'MIT', url: 'https://github.com/tabler/tabler-icons' },
  { name: 'builtin', license: 'CC0-1.0', url: 'packages/core/src/render/icons.ts' },
];

// ---------------------------------------------------------------------------
// Built-in glyphs: 24x24, 2px stroke, round caps and joins, `currentColor`.
// One coherent hand-drawn family; the tool's default visual language.
// ---------------------------------------------------------------------------

export const BUILTIN_GLYPH_NAMES = [
  'person',
  'system',
  'container',
  'component',
  'database',
  'queue',
  'topic',
  'cache',
  'api',
  'service',
  'browser',
  'mobileApp',
  'function',
  'deploymentNode',
  'infrastructureNode',
  'external',
  'unknown',
] as const;

export type BuiltinGlyphName = (typeof BUILTIN_GLYPH_NAMES)[number];

const STROKE_ATTRS =
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

function glyph(name: BuiltinGlyphName, title: string, shapes: string): IconDef {
  return {
    id: `builtin:${name}`,
    pack: 'builtin',
    title,
    viewBox: '0 0 24 24',
    body: `<g ${STROKE_ATTRS}>${shapes}</g>`,
    monochrome: true,
    license: 'CC0-1.0',
  };
}

const BUILTIN_GLYPHS: Readonly<Record<BuiltinGlyphName, IconDef>> = {
  // Head and shoulders.
  person: glyph(
    'person',
    'Person',
    '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v1"/>',
  ),
  // Four tiles: a system is a set of parts.
  system: glyph(
    'system',
    'Software system',
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
      '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  ),
  // Isometric cube.
  container: glyph(
    'container',
    'Container',
    '<path d="M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5z"/><path d="M3.5 7.25L12 12l8.5-4.75M12 12v9.5"/>',
  ),
  // UML component: a box with two tabs on the left edge.
  component: glyph(
    'component',
    'Component',
    '<rect x="6" y="4" width="15" height="16" rx="2"/>' +
      '<rect x="3" y="8" width="7" height="3" rx="1"/><rect x="3" y="13" width="7" height="3" rx="1"/>',
  ),
  // Cylinder.
  database: glyph(
    'database',
    'Database',
    '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/>' +
      '<path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
  ),
  // Three slots feeding an arrow: first in, first out.
  queue: glyph(
    'queue',
    'Queue',
    '<rect x="2" y="8" width="15" height="8" rx="1.5"/><path d="M7 8v8M12 8v8"/><path d="M19 12h3M20 10l2 2-2 2"/>',
  ),
  // Broadcast: a source with concentric waves either side.
  topic: glyph(
    'topic',
    'Topic',
    '<circle cx="12" cy="12" r="2"/>' +
      '<path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  ),
  // A chip with a bolt: fast memory.
  cache: glyph(
    'cache',
    'Cache',
    '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M14 7l-4.5 6h4.5l-2 4"/>',
  ),
  // Curly braces: a contract.
  api: glyph(
    'api',
    'API',
    '<path d="M9 4c-2 0-3 1-3 3v2.5c0 1.5-1 2.5-2.5 2.5C5 12 6 13 6 14.5V17c0 2 1 3 3 3"/>' +
      '<path d="M15 4c2 0 3 1 3 3v2.5c0 1.5 1 2.5 2.5 2.5-1.5 0-2.5 1-2.5 2.5V17c0 2-1 3-3 3"/>',
  ),
  // Six-tooth gear (computed on the 24 grid) with a hub.
  service: glyph(
    'service',
    'Service',
    '<path d="M21.82 10.09L21.82 13.91L19.31 14.09L17.47 17.28L18.56 19.55L15.26 21.46L13.84 19.37L10.16 19.37' +
      'L8.74 21.46L5.44 19.55L6.53 17.28L4.69 14.09L2.18 13.91L2.18 10.09L4.69 9.91L6.53 6.72L5.44 4.45L8.74 2.54' +
      'L10.16 4.63L13.84 4.63L15.26 2.54L18.56 4.45L17.47 6.72L19.31 9.91Z"/><circle cx="12" cy="12" r="3"/>',
  ),
  // Window with a title bar and two dots.
  browser: glyph(
    'browser',
    'Web browser',
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M6.5 6.5h.01M9.5 6.5h.01"/>',
  ),
  // Phone with a home dot.
  mobileApp: glyph(
    'mobileApp',
    'Mobile app',
    '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M12 18h.01"/>',
  ),
  // Lambda.
  function: glyph(
    'function',
    'Function',
    '<path d="M6 4h2.6c1 0 1.7.5 2.1 1.4L17 20h1"/><path d="M12.6 11.6L8 20"/>',
  ),
  // Two rack units with status LEDs.
  deploymentNode: glyph(
    'deploymentNode',
    'Deployment node',
    '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/>' +
      '<path d="M7 7h.01M7 17h.01"/>',
  ),
  // Cloud.
  infrastructureNode: glyph(
    'infrastructureNode',
    'Infrastructure node',
    '<path d="M7 19h10.5a4.5 4.5 0 0 0 .6-8.96A6.5 6.5 0 0 0 5.7 11.2 4 4 0 0 0 7 19z"/>',
  ),
  // Box with an arrow leaving it.
  external: glyph(
    'external',
    'External',
    '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  ),
  // Circle with a question mark.
  unknown: glyph(
    'unknown',
    'Unknown',
    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01"/>',
  ),
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const ALL_ICONS: readonly IconDef[] = [
  ...VENDORED_ICONS,
  ...BUILTIN_GLYPH_NAMES.map((name) => BUILTIN_GLYPHS[name]),
].sort((a, b) => compareIds(a.id, b.id));

const BY_ID: ReadonlyMap<string, IconDef> = new Map(ALL_ICONS.map((icon) => [icon.id, icon]));

export function getIcon(id: string): IconDef | undefined {
  return BY_ID.get(id);
}

/** Every icon in the registry, sorted by id. */
export function listIcons(): readonly IconDef[] {
  return ALL_ICONS;
}

export const ICON_PACKS: readonly { name: string; license: string; url: string; count: number }[] =
  PACK_PRIORITY.map((name) => {
    const meta = PACK_META.find((p) => p.name === name);
    return {
      name,
      license: meta?.license ?? 'unknown',
      url: meta?.url ?? '',
      count: ALL_ICONS.filter((icon) => icon.pack === name).length,
    };
  });

// ---------------------------------------------------------------------------
// Alias table: normalised token -> candidate ids in preference order. The
// first candidate that exists in the registry wins, so entries may name
// icons from packs that are not vendored (aws/azure/gcp) and still degrade
// to a generic or built-in glyph.
// ---------------------------------------------------------------------------

const DB: readonly string[] = ['lucide:database', 'tabler:database', 'builtin:database'];
const STORAGE: readonly string[] = ['lucide:hard-drive', 'builtin:database'];
const K8S: readonly string[] = ['simpleicons:kubernetes', 'devicon:kubernetes'];
const GLOBE: readonly string[] = ['lucide:globe', 'tabler:world', 'builtin:infrastructureNode'];
const SERVER: readonly string[] = ['lucide:server', 'tabler:server', 'builtin:deploymentNode'];

const TECH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  // Databases and storage
  postgres: ['simpleicons:postgresql', 'devicon:postgresql', ...DB],
  postgresql: ['simpleicons:postgresql', 'devicon:postgresql', ...DB],
  pg: ['simpleicons:postgresql', 'devicon:postgresql', ...DB],
  psql: ['simpleicons:postgresql', 'devicon:postgresql', ...DB],
  mysql: ['simpleicons:mysql', 'devicon:mysql', ...DB],
  mariadb: ['simpleicons:mariadb', 'devicon:mariadb', ...DB],
  sqlite: ['simpleicons:sqlite', 'devicon:sqlite', ...DB],
  oracle: ['devicon:oracle', ...DB],
  mssql: ['builtin:database'],
  sqlserver: ['builtin:database'],
  mongodb: ['simpleicons:mongodb', 'devicon:mongodb', ...DB],
  mongo: ['simpleicons:mongodb', 'devicon:mongodb', ...DB],
  cassandra: ['simpleicons:apachecassandra', 'devicon:cassandra', ...DB],
  apachecassandra: ['simpleicons:apachecassandra', 'devicon:cassandra', ...DB],
  neo4j: ['simpleicons:neo4j', 'devicon:neo4j', ...DB],
  couchdb: ['devicon:couchdb', ...DB],
  couchbase: ['simpleicons:couchbase', ...DB],
  clickhouse: ['simpleicons:clickhouse', ...DB],
  influxdb: ['simpleicons:influxdb', ...DB],
  snowflake: ['simpleicons:snowflake', ...DB],
  redis: ['simpleicons:redis', 'devicon:redis', 'builtin:cache'],
  memcached: ['builtin:cache'],
  hazelcast: ['builtin:cache'],
  elasticsearch: ['simpleicons:elasticsearch', 'devicon:elasticsearch', 'lucide:search', 'tabler:search'],
  elastic: ['simpleicons:elasticsearch', 'devicon:elasticsearch', 'lucide:search', 'tabler:search'],
  opensearch: ['lucide:search', 'tabler:search'],
  kibana: ['simpleicons:kibana'],
  minio: ['simpleicons:minio', ...STORAGE],
  // Messaging
  kafka: ['simpleicons:apachekafka', 'devicon:apachekafka', 'builtin:topic'],
  apachekafka: ['simpleicons:apachekafka', 'devicon:apachekafka', 'builtin:topic'],
  rabbitmq: ['simpleicons:rabbitmq', 'devicon:rabbitmq', 'builtin:queue'],
  rabbit: ['simpleicons:rabbitmq', 'devicon:rabbitmq', 'builtin:queue'],
  amqp: ['simpleicons:rabbitmq', 'builtin:queue'],
  nats: ['simpleicons:natsdotio', 'builtin:topic'],
  pulsar: ['simpleicons:apachepulsar', 'builtin:topic'],
  apachepulsar: ['simpleicons:apachepulsar', 'builtin:topic'],
  mqtt: ['builtin:topic'],
  jms: ['builtin:queue'],
  // Languages and runtimes
  java: ['simpleicons:openjdk', 'devicon:java'],
  openjdk: ['simpleicons:openjdk', 'devicon:java'],
  jdk: ['simpleicons:openjdk', 'devicon:java'],
  jvm: ['simpleicons:openjdk', 'devicon:java'],
  kotlin: ['simpleicons:kotlin', 'devicon:kotlin'],
  scala: ['simpleicons:scala', 'devicon:scala'],
  node: ['simpleicons:nodedotjs', 'devicon:nodejs'],
  nodejs: ['simpleicons:nodedotjs', 'devicon:nodejs'],
  nodedotjs: ['simpleicons:nodedotjs', 'devicon:nodejs'],
  typescript: ['simpleicons:typescript', 'devicon:typescript'],
  ts: ['simpleicons:typescript', 'devicon:typescript'],
  javascript: ['simpleicons:javascript', 'devicon:javascript'],
  js: ['simpleicons:javascript', 'devicon:javascript'],
  python: ['simpleicons:python', 'devicon:python'],
  py: ['simpleicons:python', 'devicon:python'],
  go: ['simpleicons:go', 'devicon:go'],
  golang: ['simpleicons:go', 'devicon:go'],
  rust: ['simpleicons:rust', 'devicon:rust'],
  dotnet: ['simpleicons:dotnet', 'devicon:dot-net'],
  net: ['simpleicons:dotnet', 'devicon:dot-net'],
  aspnet: ['simpleicons:dotnet', 'devicon:dot-net'],
  aspnetcore: ['simpleicons:dotnet', 'devicon:dot-net'],
  csharp: ['devicon:csharp', 'simpleicons:dotnet'],
  cplusplus: ['devicon:cplusplus'],
  php: ['simpleicons:php', 'devicon:php'],
  ruby: ['simpleicons:ruby', 'devicon:ruby'],
  rails: ['simpleicons:rubyonrails', 'simpleicons:ruby'],
  rubyonrails: ['simpleicons:rubyonrails', 'simpleicons:ruby'],
  swift: ['simpleicons:swift', 'devicon:swift', 'builtin:mobileApp'],
  dart: ['simpleicons:dart', 'devicon:dart'],
  flutter: ['simpleicons:flutter', 'devicon:flutter', 'builtin:mobileApp'],
  elixir: ['simpleicons:elixir'],
  phoenix: ['simpleicons:phoenixframework'],
  // Frameworks
  spring: ['simpleicons:spring', 'devicon:spring'],
  springboot: ['simpleicons:springboot', 'devicon:spring'],
  springframework: ['simpleicons:spring', 'devicon:spring'],
  springcloud: ['simpleicons:spring', 'devicon:spring'],
  react: ['simpleicons:react', 'devicon:react', 'builtin:browser'],
  reactjs: ['simpleicons:react', 'devicon:react', 'builtin:browser'],
  reactnative: ['simpleicons:react', 'devicon:react', 'builtin:mobileApp'],
  angular: ['simpleicons:angular', 'devicon:angularjs', 'builtin:browser'],
  vue: ['simpleicons:vuedotjs', 'devicon:vuejs', 'builtin:browser'],
  vuejs: ['simpleicons:vuedotjs', 'devicon:vuejs', 'builtin:browser'],
  svelte: ['simpleicons:svelte', 'builtin:browser'],
  next: ['simpleicons:nextdotjs', 'devicon:nextjs'],
  nextjs: ['simpleicons:nextdotjs', 'devicon:nextjs'],
  express: ['simpleicons:express', 'devicon:express'],
  expressjs: ['simpleicons:express', 'devicon:express'],
  nestjs: ['simpleicons:nestjs', 'devicon:nestjs'],
  django: ['simpleicons:django'],
  fastapi: ['simpleicons:fastapi', 'devicon:fastapi'],
  flask: ['simpleicons:flask', 'devicon:flask'],
  laravel: ['simpleicons:laravel'],
  graphql: ['simpleicons:graphql', 'devicon:graphql', 'builtin:api'],
  grpc: ['builtin:api'],
  rest: ['builtin:api'],
  restapi: ['builtin:api'],
  openapi: ['simpleicons:openapiinitiative', 'builtin:api'],
  swagger: ['simpleicons:swagger', 'builtin:api'],
  websocket: ['lucide:radio', 'builtin:api'],
  websockets: ['lucide:radio', 'builtin:api'],
  socketio: ['simpleicons:socketdotio', 'lucide:radio'],
  // Containers and orchestration
  docker: ['simpleicons:docker', 'devicon:docker', 'tabler:brand-docker', 'builtin:container'],
  kubernetes: [...K8S, 'builtin:deploymentNode'],
  k8s: [...K8S, 'builtin:deploymentNode'],
  helm: ['simpleicons:helm', 'devicon:helm'],
  istio: ['simpleicons:istio'],
  envoy: ['simpleicons:envoyproxy'],
  envoyproxy: ['simpleicons:envoyproxy'],
  nginx: ['simpleicons:nginx', 'devicon:nginx'],
  apache: ['simpleicons:apache'],
  httpd: ['simpleicons:apache'],
  haproxy: ['lucide:network', 'tabler:network'],
  traefik: ['lucide:network', 'tabler:network'],
  loadbalancer: ['lucide:network', 'tabler:network'],
  terraform: ['simpleicons:terraform', 'devicon:terraform'],
  ansible: ['devicon:ansible'],
  vagrant: ['devicon:vagrant'],
  linux: ['simpleicons:linux', 'devicon:linux'],
  ubuntu: ['simpleicons:ubuntu', 'devicon:ubuntu'],
  debian: ['simpleicons:debian', 'devicon:debian'],
  // Delivery and observability
  git: ['simpleicons:git', 'devicon:git', 'lucide:git-branch', 'tabler:git-branch'],
  github: ['simpleicons:github', 'devicon:github'],
  githubactions: ['simpleicons:githubactions', 'simpleicons:github'],
  gitlab: ['simpleicons:gitlab', 'devicon:gitlab'],
  bitbucket: ['devicon:bitbucket'],
  jenkins: ['simpleicons:jenkins', 'devicon:jenkins'],
  argo: ['simpleicons:argo', 'devicon:argocd'],
  argocd: ['simpleicons:argo', 'devicon:argocd'],
  grafana: ['simpleicons:grafana', 'devicon:grafana'],
  prometheus: ['simpleicons:prometheus', 'devicon:prometheus'],
  opentelemetry: ['simpleicons:opentelemetry', 'lucide:activity'],
  otel: ['simpleicons:opentelemetry', 'lucide:activity'],
  jaeger: ['simpleicons:jaeger', 'lucide:activity'],
  datadog: ['simpleicons:datadog', 'lucide:activity'],
  sentry: ['simpleicons:sentry'],
  splunk: ['simpleicons:splunk'],
  pagerduty: ['simpleicons:pagerduty', 'lucide:bell'],
  temporal: ['simpleicons:temporal', 'lucide:workflow'],
  airflow: ['simpleicons:apacheairflow', 'lucide:workflow'],
  apacheairflow: ['simpleicons:apacheairflow', 'lucide:workflow'],
  spark: ['simpleicons:apachespark', 'devicon:apachespark'],
  apachespark: ['simpleicons:apachespark', 'devicon:apachespark'],
  hadoop: ['simpleicons:apachehadoop', 'devicon:hadoop'],
  // Identity and third parties
  keycloak: ['simpleicons:keycloak', 'lucide:key', 'tabler:key'],
  auth0: ['simpleicons:auth0', 'lucide:key', 'tabler:key'],
  oauth: ['lucide:key', 'tabler:key'],
  oauth2: ['lucide:key', 'tabler:key'],
  oidc: ['lucide:key', 'tabler:key'],
  openidconnect: ['lucide:key', 'tabler:key'],
  jwt: ['simpleicons:jsonwebtokens', 'lucide:key', 'tabler:key'],
  saml: ['lucide:key', 'tabler:key'],
  ldap: ['lucide:users', 'tabler:users'],
  activedirectory: ['lucide:users', 'tabler:users'],
  vault: ['simpleicons:vault', 'lucide:lock', 'tabler:lock'],
  consul: ['simpleicons:consul', 'lucide:network'],
  stripe: ['simpleicons:stripe'],
  firebase: ['simpleicons:firebase', 'devicon:firebase'],
  supabase: ['simpleicons:supabase', 'devicon:supabase'],
  vercel: ['simpleicons:vercel'],
  cloudflare: ['simpleicons:cloudflare', ...GLOBE],
  smtp: ['lucide:mail', 'tabler:mail'],
  email: ['lucide:mail', 'tabler:mail'],
  imap: ['lucide:mail', 'tabler:mail'],
  cdn: GLOBE,
  dns: GLOBE,
  vpn: ['lucide:shield', 'tabler:shield'],
  firewall: ['lucide:shield', 'tabler:shield'],
  waf: ['lucide:shield', 'tabler:shield'],
  // AWS: official icons are not redistributable, so these degrade to generic glyphs.
  aws: ['aws:aws', 'builtin:infrastructureNode'],
  amazonwebservices: ['aws:aws', 'builtin:infrastructureNode'],
  s3: ['aws:s3', ...STORAGE],
  amazons3: ['aws:s3', ...STORAGE],
  rds: ['aws:rds', ...DB],
  aurora: ['aws:aurora', ...DB],
  lambda: ['aws:lambda', 'builtin:function'],
  awslambda: ['aws:lambda', 'builtin:function'],
  dynamodb: ['aws:dynamodb', ...DB],
  sqs: ['aws:sqs', 'builtin:queue'],
  sns: ['aws:sns', 'builtin:topic'],
  kinesis: ['aws:kinesis', 'builtin:topic'],
  eventbridge: ['aws:eventbridge', 'builtin:topic'],
  eks: ['aws:eks', ...K8S, 'builtin:deploymentNode'],
  ecs: ['aws:ecs', 'builtin:container'],
  fargate: ['aws:fargate', 'builtin:container'],
  ec2: ['aws:ec2', ...SERVER],
  cloudfront: ['aws:cloudfront', ...GLOBE],
  route53: ['aws:route53', ...GLOBE],
  apigateway: ['aws:apigateway', 'builtin:api'],
  elasticache: ['aws:elasticache', 'builtin:cache'],
  cloudwatch: ['aws:cloudwatch', 'lucide:activity'],
  iam: ['aws:iam', 'lucide:key'],
  cognito: ['aws:cognito', 'lucide:users'],
  // Azure
  azure: ['azure:azure', 'devicon:azure', 'builtin:infrastructureNode'],
  microsoftazure: ['azure:azure', 'devicon:azure', 'builtin:infrastructureNode'],
  azurefunctions: ['azure:functions', 'builtin:function'],
  functions: ['azure:functions', 'builtin:function'],
  cosmosdb: ['azure:cosmosdb', ...DB],
  cosmos: ['azure:cosmosdb', ...DB],
  aks: ['azure:aks', ...K8S, 'builtin:deploymentNode'],
  servicebus: ['azure:servicebus', 'builtin:queue'],
  eventhubs: ['azure:eventhubs', 'builtin:topic'],
  eventhub: ['azure:eventhubs', 'builtin:topic'],
  blobstorage: ['azure:blobstorage', ...STORAGE],
  blob: ['azure:blobstorage', ...STORAGE],
  azuresql: ['azure:sqldatabase', ...DB],
  keyvault: ['azure:keyvault', 'lucide:key', 'tabler:key'],
  appservice: ['azure:appservice', ...GLOBE],
  apimanagement: ['azure:apimanagement', 'builtin:api'],
  // GCP
  gcp: ['gcp:googlecloud', 'simpleicons:googlecloud', 'devicon:googlecloud', 'builtin:infrastructureNode'],
  googlecloud: ['gcp:googlecloud', 'simpleicons:googlecloud', 'devicon:googlecloud', 'builtin:infrastructureNode'],
  gke: ['gcp:gke', ...K8S, 'builtin:deploymentNode'],
  bigquery: ['gcp:bigquery', 'simpleicons:googlebigquery', ...DB],
  googlebigquery: ['gcp:bigquery', 'simpleicons:googlebigquery', ...DB],
  pubsub: ['gcp:pubsub', 'simpleicons:googlepubsub', 'builtin:topic'],
  googlepubsub: ['gcp:pubsub', 'simpleicons:googlepubsub', 'builtin:topic'],
  cloudrun: ['gcp:cloudrun', 'builtin:container'],
  cloudsql: ['gcp:cloudsql', ...DB],
  cloudstorage: ['gcp:cloudstorage', 'simpleicons:googlecloudstorage', ...STORAGE],
  gcs: ['gcp:cloudstorage', 'simpleicons:googlecloudstorage', ...STORAGE],
  cloudfunctions: ['gcp:cloudfunctions', 'builtin:function'],
  spanner: ['gcp:spanner', ...DB],
  firestore: ['gcp:firestore', 'simpleicons:firebase', ...DB],
  dataflow: ['gcp:dataflow', 'lucide:workflow'],
};

/** Subtype synonyms -> canonical subtype name (looked up as a bare name, then as a glyph). */
const SUBTYPE_SYNONYMS: Readonly<Record<string, BuiltinGlyphName>> = {
  db: 'database',
  database: 'database',
  rdbms: 'database',
  sql: 'database',
  nosql: 'database',
  datastore: 'database',
  storage: 'database',
  bucket: 'database',
  queue: 'queue',
  mq: 'queue',
  messagequeue: 'queue',
  topic: 'topic',
  stream: 'topic',
  eventbus: 'topic',
  pubsub: 'topic',
  cache: 'cache',
  api: 'api',
  gateway: 'api',
  apigateway: 'api',
  rest: 'api',
  grpc: 'api',
  service: 'service',
  microservice: 'service',
  worker: 'service',
  job: 'service',
  browser: 'browser',
  web: 'browser',
  webapp: 'browser',
  webapplication: 'browser',
  spa: 'browser',
  frontend: 'browser',
  website: 'browser',
  mobile: 'mobileApp',
  mobileapp: 'mobileApp',
  ios: 'mobileApp',
  android: 'mobileApp',
  function: 'function',
  lambda: 'function',
  serverless: 'function',
  faas: 'function',
  external: 'external',
  thirdparty: 'external',
  saas: 'external',
  person: 'person',
  user: 'person',
  actor: 'person',
  system: 'system',
  container: 'container',
  component: 'component',
  deploymentnode: 'deploymentNode',
  node: 'deploymentNode',
  server: 'deploymentNode',
  vm: 'deploymentNode',
  infrastructurenode: 'infrastructureNode',
  infrastructure: 'infrastructureNode',
  cloud: 'infrastructureNode',
};

const KIND_GLYPHS: Readonly<Record<string, BuiltinGlyphName>> = {
  person: 'person',
  system: 'system',
  container: 'container',
  component: 'component',
  deploymentNode: 'deploymentNode',
  infrastructureNode: 'infrastructureNode',
};

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Lowercase, alphanumerics only. `mobile-app` and `mobileApp` become `mobileapp`. */
function compact(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const VERSION_TOKEN = /^v?\d+(\.\d+)*(\.x)?[a-z]?$/;

/**
 * Splits a technology string into segments ("Java 21 / Spring Boot" ->
 * ["java", "spring boot"]), dropping version tokens and punctuation.
 */
function technologySegments(technology: string): string[] {
  const prepared = technology
    .toLowerCase()
    .replace(/c#/g, 'csharp')
    .replace(/f#/g, 'fsharp')
    .replace(/c\+\+/g, 'cplusplus')
    .replace(/(^|[\s(])\.net\b/g, '$1dotnet')
    .replace(/\bnode\.js\b/g, 'nodejs')
    .replace(/\bvue\.js\b/g, 'vuejs')
    .replace(/\bnext\.js\b/g, 'nextjs')
    .replace(/\bexpress\.js\b/g, 'expressjs')
    .replace(/\bsocket\.io\b/g, 'socketio')
    .replace(/\bpub\/sub\b/g, 'pubsub');
  const segments: string[] = [];
  for (const raw of prepared.split(/\s*(?:[\/,+|;&()]|\bon\b|\bwith\b|\band\b|\busing\b|\bvia\b)\s*/)) {
    const words = raw
      .replace(/[^a-z0-9.#-]+/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/^[.\-]+|[.\-]+$/g, ''))
      .filter((w) => w.length > 0 && !VERSION_TOKEN.test(w))
      .map((w) => w.replace(/[^a-z0-9]+/g, ''))
      .filter((w) => w.length > 0);
    if (words.length > 0) segments.push(words.join(' '));
  }
  return segments;
}

/**
 * Candidate tokens for a technology string, most specific first. Multi-word
 * phrases beat single words; within a tier, later segments beat earlier ones
 * because "Language / Framework" conventionally lists the general thing
 * first. "Java 21 / Spring Boot" -> springboot, spring, boot, java.
 */
export function technologyCandidates(technology: string): readonly string[] {
  const segments = technologySegments(technology);
  const phrases: string[] = [];
  const words: string[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment === undefined) continue;
    const parts = segment.split(' ');
    if (parts.length > 1) phrases.push(parts.join(''));
    for (const part of parts) words.push(part);
  }
  return [...new Set([...phrases, ...words])];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Picks the best available icon from an alias list.
 *
 * The list says which icons are *acceptable* for a technology; `PACK_PRIORITY`
 * decides which is *preferred*. Resolving by pack rank rather than by list
 * order means a full-colour Devicon mark wins over a monochrome Simple Icons
 * silhouette without every one of the several hundred alias entries having to
 * be hand-ordered — and it keeps one documented rule for precedence instead of
 * two that can disagree.
 *
 * Ties within a pack fall back to the order the author wrote, which is the
 * only remaining signal and is stable.
 */
function firstExisting(candidates: readonly string[] | undefined): IconDef | undefined {
  if (candidates === undefined) return undefined;

  let best: IconDef | undefined;
  let bestRank = Number.POSITIVE_INFINITY;

  for (const id of candidates) {
    const icon = BY_ID.get(id);
    if (icon === undefined) continue;
    const rank = PACK_PRIORITY.indexOf(icon.pack);
    const effective = rank < 0 ? PACK_PRIORITY.length : rank;
    if (effective < bestRank) {
      best = icon;
      bestRank = effective;
    }
  }
  return best;
}

/** A bare name ("database") looked up across packs in fixed priority order. */
function byBareName(name: string): IconDef | undefined {
  if (name.length < 2) return undefined;
  for (const pack of PACK_PRIORITY) {
    const icon = BY_ID.get(`${pack}:${name}`);
    if (icon !== undefined) return icon;
  }
  return undefined;
}

/** Alias table first, then a bare-name lookup across packs. */
function byToken(token: string): IconDef | undefined {
  return firstExisting(TECH_ALIASES[token]) ?? byBareName(token);
}

function resolveExplicit(explicit: string): IconDef | undefined {
  const trimmed = explicit.trim();
  if (trimmed.length === 0) return undefined;
  const exact = BY_ID.get(trimmed) ?? BY_ID.get(trimmed.toLowerCase());
  if (exact !== undefined) return exact;
  const colon = trimmed.indexOf(':');
  if (colon > 0) {
    // "pack:name" that does not exist verbatim: try the normalised name inside that pack.
    const pack = trimmed.slice(0, colon).toLowerCase();
    const name = trimmed.slice(colon + 1).toLowerCase();
    return BY_ID.get(`${pack}:${name}`) ?? BY_ID.get(`${pack}:${compact(name)}`);
  }
  const lower = trimmed.toLowerCase();
  return byBareName(lower) ?? byBareName(compact(lower)) ?? byToken(compact(lower));
}

function resolveTechnology(technology: string): IconDef | undefined {
  for (const token of technologyCandidates(technology)) {
    const icon = byToken(token);
    if (icon !== undefined) return icon;
  }
  return undefined;
}

function resolveSubtype(subtype: string): IconDef | undefined {
  const token = compact(subtype);
  if (token.length === 0) return undefined;
  const canonical = SUBTYPE_SYNONYMS[token];
  return (
    byBareName(token) ??
    (canonical !== undefined ? byBareName(canonical.toLowerCase()) : undefined) ??
    byToken(token)
  );
}

/**
 * Offline, deterministic. Order: explicit > technology > subtype > tags >
 * built-in glyph for the kind/subtype. Returns undefined only if nothing
 * matches at all, which cannot happen while the built-in set is complete.
 */
export function resolveIcon(query: IconQuery): IconDef | undefined {
  if (query.explicit !== undefined) {
    const icon = resolveExplicit(query.explicit);
    if (icon !== undefined) return icon;
  }
  if (query.technology !== undefined) {
    const icon = resolveTechnology(query.technology);
    if (icon !== undefined) return icon;
  }
  if (query.subtype !== undefined) {
    const icon = resolveSubtype(query.subtype);
    if (icon !== undefined) return icon;
  }
  if (query.tags !== undefined) {
    // Tags are sorted in the model; sort again here so callers cannot change the outcome by ordering.
    for (const tag of [...query.tags].sort(compareIds)) {
      const icon = firstExisting(TECH_ALIASES[compact(tag)]);
      if (icon !== undefined) return icon;
    }
  }
  return builtinGlyph(query.kind, query.subtype);
}

/** Always returns something: the hand-drawn fallback for a kind/subtype. */
export function builtinGlyph(kind: string, subtype?: string): IconDef {
  if (subtype !== undefined) {
    const name = SUBTYPE_SYNONYMS[compact(subtype)];
    if (name !== undefined) return BUILTIN_GLYPHS[name];
  }
  const byKind = KIND_GLYPHS[kind] ?? KIND_GLYPHS[compact(kind)];
  return BUILTIN_GLYPHS[byKind ?? 'unknown'];
}

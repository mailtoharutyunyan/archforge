#!/usr/bin/env node
/**
 * Vendors icon packs into the repository so rendering never needs the network.
 *
 *   node tools/fetch-icons.mjs                       # default packs
 *   node tools/fetch-icons.mjs --pack simpleicons,kubernetes
 *   node tools/fetch-icons.mjs --pack aws            # prints licence obligations, downloads nothing
 *   node tools/fetch-icons.mjs --verify              # checks manifest + generated data, writes nothing
 *
 * Outputs (all deterministic; re-running with unchanged upstream is a no-op):
 *   assets/icons/<pack>/<name>.svg           raw upstream bytes, untouched (provenance)
 *   assets/icons/manifest.json               canonical JSON: pack, name, sha256, url, license
 *   packages/core/src/render/icons.data.ts   sanitised inner markup, inlined for the renderer
 *
 * Plain Node ESM, no dependencies. Requires Node >= 18 for global fetch.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_DIR = join(ROOT, 'assets', 'icons');
const MANIFEST_PATH = join(ASSETS_DIR, 'manifest.json');
const DATA_PATH = join(ROOT, 'packages', 'core', 'src', 'render', 'icons.data.ts');

const CONCURRENCY = 8;
const TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Pack definitions
// ---------------------------------------------------------------------------

const SIMPLEICONS_NAMES = [
  'angular', 'apache', 'apacheairflow', 'apachecassandra', 'apachehadoop', 'apachekafka', 'apachepulsar',
  'apachespark', 'argo', 'auth0', 'clickhouse', 'cloudflare', 'consul', 'couchbase', 'dart', 'datadog',
  'debian', 'django', 'docker', 'dotnet', 'elasticsearch', 'elixir', 'envoyproxy', 'express', 'fastapi',
  'firebase', 'flask', 'flutter', 'git', 'github', 'githubactions', 'gitlab', 'go', 'googlebigquery',
  'googlecloud', 'googlecloudstorage', 'googlepubsub', 'grafana', 'graphql', 'helm', 'influxdb', 'istio',
  'jaeger', 'javascript', 'jenkins', 'jsonwebtokens', 'keycloak', 'kibana', 'kotlin', 'kubernetes',
  'laravel', 'linux', 'mariadb', 'minio', 'mongodb', 'mysql', 'natsdotio', 'neo4j', 'nestjs', 'nextdotjs',
  'nginx', 'nodedotjs', 'openapiinitiative', 'openjdk', 'opentelemetry', 'pagerduty', 'phoenixframework',
  'php', 'postgresql', 'prometheus', 'python', 'rabbitmq', 'react', 'redis', 'ruby', 'rubyonrails', 'rust',
  'scala', 'sentry', 'snowflake', 'socketdotio', 'splunk', 'spring', 'springboot', 'sqlite', 'stripe',
  'supabase', 'svelte', 'swagger', 'swift', 'temporal', 'terraform', 'typescript', 'ubuntu', 'vault',
  'vercel', 'vuedotjs',
];

const DEVICON_NAMES = [
  'angularjs', 'ansible', 'apachekafka', 'apachespark', 'argocd', 'azure', 'bitbucket', 'cassandra',
  'couchdb', 'cplusplus', 'csharp', 'dart', 'docker', 'dot-net', 'elasticsearch', 'express', 'fastapi',
  'firebase', 'flask', 'flutter', 'git', 'github', 'gitlab', 'go', 'googlecloud', 'grafana', 'graphql',
  'hadoop', 'helm', 'java', 'javascript', 'jenkins', 'kotlin', 'kubernetes', 'linux', 'mariadb', 'mongodb',
  'mysql', 'neo4j', 'nestjs', 'nextjs', 'nginx', 'nodejs', 'oracle', 'php', 'postgresql', 'prometheus',
  'python', 'rabbitmq', 'react', 'redis', 'ruby', 'rust', 'scala', 'spring', 'sqlite', 'supabase', 'swift',
  'terraform', 'typescript', 'ubuntu', 'vagrant', 'vuejs',
];

const KUBERNETES_NAMES = [
  'cm', 'crd', 'cronjob', 'deploy', 'ds', 'ep', 'hpa', 'ing', 'job', 'netpol', 'ns', 'pod', 'pv', 'pvc',
  'rs', 'sa', 'sc', 'secret', 'sts', 'svc', 'vol',
];

const LUCIDE_NAMES = [
  'activity', 'app-window', 'bell', 'blocks', 'bot', 'box', 'boxes', 'braces', 'cable', 'cloud', 'cloud-cog',
  'cog', 'container', 'cpu', 'database', 'file-text', 'folder', 'git-branch', 'globe', 'hard-drive', 'inbox',
  'key', 'layers', 'lock', 'mail', 'message-square', 'monitor', 'network', 'package', 'plug', 'radio',
  'rocket', 'router', 'scroll-text', 'search', 'server', 'server-cog', 'shield', 'smartphone', 'terminal',
  'timer', 'user', 'users', 'webhook', 'workflow', 'zap',
];

const TABLER_NAMES = [
  'activity', 'api', 'arrows-exchange', 'bell', 'bolt', 'box', 'braces', 'brand-aws', 'brand-azure',
  'brand-docker', 'brand-google', 'broadcast', 'browser', 'clock', 'cloud', 'cloud-computing', 'container',
  'cpu', 'database', 'device-desktop', 'device-mobile', 'file-text', 'folder', 'git-branch', 'inbox', 'key',
  'lock', 'mail', 'message', 'network', 'package', 'plug-connected', 'robot', 'router', 'search', 'server',
  'server-2', 'settings', 'shield', 'stack-2', 'terminal-2', 'topology-star', 'user', 'users', 'webhook',
  'world',
];

/**
 * `vendored: true` packs are downloaded and committed. `vendored: false` packs
 * are declared only: the script prints where the official archive lives and
 * what the user must accept; files the user drops into assets/icons/<pack>/
 * are ingested into the generated data on the next run.
 *
 * `monochrome: 'fill'`   => single-colour glyphs relying on the default black fill (simpleicons);
 *                           hardcoded fills become currentColor and a fill="currentColor" wrapper is added.
 * `monochrome: 'stroke'` => already expressed in currentColor on the root svg (lucide, tabler).
 * `monochrome: false`    => multi-colour brand art; colours are preserved.
 */
const PACKS = {
  simpleicons: {
    license: 'CC0-1.0',
    homepage: 'https://github.com/simple-icons/simple-icons',
    licenseUrl: 'https://raw.githubusercontent.com/simple-icons/simple-icons/master/LICENSE.md',
    vendored: true,
    monochrome: 'fill',
    names: SIMPLEICONS_NAMES,
    urls: (name) => [`https://raw.githubusercontent.com/simple-icons/simple-icons/master/icons/${name}.svg`],
  },
  devicon: {
    license: 'MIT',
    homepage: 'https://github.com/devicons/devicon',
    licenseUrl: 'https://raw.githubusercontent.com/devicons/devicon/master/LICENSE',
    vendored: true,
    monochrome: false,
    names: DEVICON_NAMES,
    // Some logos ship only a "-plain" variant; try "-original" first.
    urls: (name) => [
      `https://raw.githubusercontent.com/devicons/devicon/master/icons/${name}/${name}-original.svg`,
      `https://raw.githubusercontent.com/devicons/devicon/master/icons/${name}/${name}-plain.svg`,
    ],
  },
  kubernetes: {
    license: 'Apache-2.0',
    homepage: 'https://github.com/kubernetes/community/tree/master/icons',
    licenseUrl: 'https://raw.githubusercontent.com/kubernetes/community/master/LICENSE',
    vendored: true,
    monochrome: false,
    names: KUBERNETES_NAMES,
    // "unlabeled": the labeled variant embeds 2.8px text that is illegible at icon size.
    urls: (name) => [
      `https://raw.githubusercontent.com/kubernetes/community/master/icons/svg/resources/unlabeled/${name}.svg`,
    ],
  },
  lucide: {
    license: 'ISC',
    homepage: 'https://github.com/lucide-icons/lucide',
    licenseUrl: 'https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE',
    vendored: true,
    monochrome: 'stroke',
    names: LUCIDE_NAMES,
    urls: (name) => [`https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/${name}.svg`],
  },
  tabler: {
    license: 'MIT',
    homepage: 'https://github.com/tabler/tabler-icons',
    licenseUrl: 'https://raw.githubusercontent.com/tabler/tabler-icons/main/LICENSE',
    vendored: true,
    monochrome: 'stroke',
    names: TABLER_NAMES,
    urls: (name) => [`https://raw.githubusercontent.com/tabler/tabler-icons/main/icons/outline/${name}.svg`],
  },
  aws: {
    license: 'AWS Architecture Icons terms; not redistributed',
    homepage: 'https://aws.amazon.com/architecture/icons/',
    vendored: false,
    monochrome: false,
    names: [],
    obligations:
      'AWS Architecture Icons may be used to describe AWS-based architectures but not redistributed as an icon library. ' +
      'Download the official asset package, accept its terms, then copy the SVGs you need into assets/icons/aws/<name>.svg ' +
      '(e.g. s3.svg, rds.svg, lambda.svg, dynamodb.svg, sqs.svg, sns.svg, eks.svg, ec2.svg, cloudfront.svg, apigateway.svg) ' +
      'and re-run this script.',
  },
  azure: {
    license: 'Microsoft Azure architecture icons terms; not redistributed',
    homepage: 'https://learn.microsoft.com/en-us/azure/architecture/icons/',
    vendored: false,
    monochrome: false,
    names: [],
    obligations:
      'Microsoft permits the Azure architecture icons in diagrams and documentation about Azure only; they must not be ' +
      'redistributed as a library or modified. Download the official SVG package, accept its terms, then copy the files ' +
      'you need into assets/icons/azure/<name>.svg (e.g. functions.svg, cosmosdb.svg, aks.svg, servicebus.svg, ' +
      'blobstorage.svg, sqldatabase.svg, keyvault.svg, appservice.svg, apimanagement.svg) and re-run this script.',
  },
  gcp: {
    license: 'Google Cloud architecture icons terms; not redistributed',
    homepage: 'https://cloud.google.com/icons',
    vendored: false,
    monochrome: false,
    names: [],
    obligations:
      'Google Cloud architecture icons are provided for depicting Google Cloud products in diagrams under Google’s ' +
      'terms; they are not offered under an open licence. Download the official package, accept its terms, then copy the ' +
      'SVGs you need into assets/icons/gcp/<name>.svg (e.g. gke.svg, bigquery.svg, pubsub.svg, cloudrun.svg, cloudsql.svg, ' +
      'cloudstorage.svg, cloudfunctions.svg, spanner.svg, firestore.svg, dataflow.svg) and re-run this script.',
  },
};

const DEFAULT_PACKS = ['simpleicons', 'devicon', 'kubernetes', 'lucide', 'tabler'];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { packs: DEFAULT_PACKS, verify: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verify') opts.verify = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--pack') opts.packs = splitPacks(argv[++i]);
    else if (arg.startsWith('--pack=')) opts.packs = splitPacks(arg.slice('--pack='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function splitPacks(value) {
  if (value === undefined || value.trim() === '') throw new Error('--pack requires a comma-separated list');
  const names = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (names.includes('all')) return Object.keys(PACKS);
  for (const name of names) {
    if (!(name in PACKS)) throw new Error(`Unknown pack "${name}". Known: ${Object.keys(PACKS).join(', ')}`);
  }
  return [...new Set(names)];
}

function usage() {
  return [
    'Usage: node tools/fetch-icons.mjs [--pack a,b,c] [--verify]',
    '',
    `  --pack     comma-separated packs (default: ${DEFAULT_PACKS.join(',')}; "all" for every known pack)`,
    '  --verify   check manifest checksums and generated data against disk; write nothing',
    '',
    'Packs:',
    ...Object.entries(PACKS).map(
      ([name, p]) => `  ${name.padEnd(12)} ${p.license.padEnd(58)} ${p.vendored ? 'vendored' : 'declared only'}`,
    ),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchBytes(url) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
      if (res.status === 404) return { status: 404 };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: 200, bytes: Buffer.from(await res.arrayBuffer()) };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Runs `fn` over `items` with bounded concurrency, preserving order of results. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchPack(packName, pack) {
  const dir = join(ASSETS_DIR, packName);
  await mkdir(dir, { recursive: true });
  const failures = [];
  let written = 0;
  let unchanged = 0;

  await mapLimit([...pack.names].sort(), CONCURRENCY, async (name) => {
    const urls = pack.urls(name);
    let result;
    let usedUrl;
    try {
      for (const url of urls) {
        result = await fetchBytes(url);
        usedUrl = url;
        if (result.status === 200) break;
      }
    } catch (err) {
      failures.push({ name, url: usedUrl, reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (result.status !== 200) {
      failures.push({ name, url: urls.join(' | '), reason: '404 Not Found' });
      return;
    }
    if (!looksLikeSvg(result.bytes)) {
      failures.push({ name, url: usedUrl, reason: 'response is not an SVG document' });
      return;
    }
    const changed = await writeIfChanged(join(dir, `${name}.svg`), result.bytes);
    if (changed) written++;
    else unchanged++;
  });

  return { written, unchanged, failures };
}

function looksLikeSvg(bytes) {
  const head = bytes.subarray(0, 2048).toString('utf8');
  return /<svg[\s>]/i.test(head);
}

async function writeIfChanged(path, bytes) {
  try {
    const existing = await readFile(path);
    if (existing.equals(bytes)) return false;
  } catch {
    // does not exist yet
  }
  await writeFile(path, bytes);
  return true;
}

// ---------------------------------------------------------------------------
// SVG sanitiser. Input is untrusted: it gets inlined into our own SVG output.
// ---------------------------------------------------------------------------

/** Elements removed together with their content. */
const DROP_WITH_CONTENT = new Set([
  'script', 'foreignobject', 'style', 'metadata', 'title', 'desc', 'image', 'iframe', 'embed', 'object',
  'video', 'audio', 'animate', 'animatemotion', 'animatetransform', 'set', 'sodipodi:namedview',
]);
/** Elements whose tags are dropped but whose children are kept. */
const UNWRAP = new Set(['a', 'switch']);
/** Root <svg> attributes that are not presentation and must not be hoisted. */
const ROOT_SKIP = new Set([
  'xmlns', 'width', 'height', 'viewbox', 'version', 'id', 'role', 'class', 'baseprofile', 'preserveaspectratio',
  'x', 'y', 'enable-background', 'xml:space', 'style',
]);
const URL_REF = /url\(\s*(['"]?)#([^)'"]+)\1\s*\)/g;

function tokenize(svg) {
  const tokens = [];
  let i = 0;
  while (i < svg.length) {
    const lt = svg.indexOf('<', i);
    if (lt === -1) {
      tokens.push({ type: 'text', text: svg.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ type: 'text', text: svg.slice(i, lt) });
    if (svg.startsWith('<!--', lt)) {
      const end = svg.indexOf('-->', lt + 4);
      i = end === -1 ? svg.length : end + 3;
      continue;
    }
    if (svg.startsWith('<?', lt)) {
      const end = svg.indexOf('?>', lt + 2);
      i = end === -1 ? svg.length : end + 2;
      continue;
    }
    if (svg.startsWith('<![CDATA[', lt)) {
      const end = svg.indexOf(']]>', lt + 9);
      tokens.push({ type: 'text', text: svg.slice(lt + 9, end === -1 ? svg.length : end) });
      i = end === -1 ? svg.length : end + 3;
      continue;
    }
    if (svg.startsWith('<!', lt)) {
      const end = svg.indexOf('>', lt + 2);
      i = end === -1 ? svg.length : end + 1;
      continue;
    }
    // A tag: scan to the closing '>' honouring quotes.
    let j = lt + 1;
    let quote = null;
    while (j < svg.length) {
      const ch = svg[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }
    const raw = svg.slice(lt + 1, j);
    i = j + 1;
    if (raw.startsWith('/')) {
      const lname = raw.slice(1).trim().toLowerCase();
      tokens.push({ type: 'close', name: lname, lname });
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^\s*([^\s/>]+)/.exec(body);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const attrs = [];
    const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    attrRe.lastIndex = nameMatch[0].length;
    let m;
    while ((m = attrRe.exec(body)) !== null) {
      attrs.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] ?? '' });
    }
    tokens.push({ type: 'open', name, lname: name.toLowerCase(), attrs, selfClosing });
  }
  return tokens;
}

function escapeAttr(value) {
  return value.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Returns { viewBox, title, body } or null when the document has no usable
 * root or viewBox. `prefix` namespaces every id so several icons can share a
 * host document.
 */
function sanitizeSvg(svg, { prefix, monochrome }) {
  const tokens = tokenize(svg);
  const rootIndex = tokens.findIndex((t) => t.type === 'open' && t.lname === 'svg');
  if (rootIndex === -1) return null;
  const root = tokens[rootIndex];

  let viewBox = attr(root, 'viewBox');
  if (!viewBox) {
    const w = parseFloat(attr(root, 'width') ?? '');
    const h = parseFloat(attr(root, 'height') ?? '');
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) viewBox = `0 0 ${w} ${h}`;
  }
  if (!viewBox) return null;
  viewBox = viewBox.trim().split(/[\s,]+/).map((n) => String(Number(n))).join(' ');
  if (viewBox.split(' ').length !== 4 || viewBox.includes('NaN')) return null;

  let title = '';
  const titleIndex = tokens.findIndex((t, i) => i > rootIndex && t.type === 'open' && t.lname === 'title');
  if (titleIndex !== -1 && tokens[titleIndex + 1]?.type === 'text') title = tokens[titleIndex + 1].text.trim();

  // Collect ids so references can be rewritten consistently.
  const ids = new Set();
  for (const t of tokens) {
    if (t.type !== 'open') continue;
    const id = attr(t, 'id');
    if (id) ids.add(id);
  }
  const renameId = (id) => (ids.has(id) ? `${prefix}-${id}` : id);
  const rewriteUrls = (value) => value.replace(URL_REF, (_m, q, id) => `url(${q}#${renameId(id)}${q})`);

  const out = [];
  const stack = [];
  let dropDepth = 0;
  let dropName = null;

  for (let i = rootIndex + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (dropName !== null) {
      if (t.type === 'open' && t.lname === dropName && !t.selfClosing) dropDepth++;
      else if (t.type === 'close' && t.lname === dropName) {
        dropDepth--;
        if (dropDepth === 0) dropName = null;
      }
      continue;
    }
    if (t.type === 'text') {
      const text = t.text.replace(/\s+/g, ' ');
      if (text.trim() !== '') out.push(escapeText(text.trim()));
      continue;
    }
    if (t.type === 'close') {
      if (t.name === 'svg') break;
      if (UNWRAP.has(t.name)) continue;
      const open = stack.pop();
      if (open !== undefined) out.push(`</${open}>`);
      continue;
    }
    // open tag
    if (DROP_WITH_CONTENT.has(t.lname) || t.lname.includes(':')) {
      if (!t.selfClosing) {
        dropName = t.lname;
        dropDepth = 1;
      }
      continue;
    }
    if (UNWRAP.has(t.lname)) continue;
    const attrs = sanitizeAttrs(t.attrs, { renameId, rewriteUrls, monochrome });
    if (t.lname === 'defs' && t.selfClosing) continue;
    out.push(`<${t.name}${attrs}${t.selfClosing ? '/>' : '>'}`);
    if (!t.selfClosing) stack.push(t.name);
  }
  while (stack.length > 0) out.push(`</${stack.pop()}>`);

  let body = out.join('').replace(/<defs><\/defs>/g, '');

  // Hoist root presentation attributes (lucide/tabler put stroke settings on <svg>).
  const hoisted = sanitizeAttrs(
    root.attrs.filter((a) => !ROOT_SKIP.has(a.name.toLowerCase())),
    { renameId, rewriteUrls, monochrome },
  );
  const rootHasFill = root.attrs.some((a) => a.name.toLowerCase() === 'fill');
  if (monochrome === 'fill' && !rootHasFill) {
    body = `<g fill="currentColor"${hoisted}>${body}</g>`;
  } else if (hoisted.length > 0) {
    body = `<g${hoisted}>${body}</g>`;
  }
  return { viewBox, title, body };
}

function attr(token, name) {
  const lname = name.toLowerCase();
  return token.attrs.find((a) => a.name.toLowerCase() === lname)?.value;
}

function escapeText(text) {
  return text.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeAttrs(attrs, { renameId, rewriteUrls, monochrome }) {
  const parts = [];
  for (const { name, value } of attrs) {
    const lname = name.toLowerCase();
    if (lname.startsWith('on')) continue; // event handlers
    if (lname.startsWith('xmlns')) continue; // namespaces belong to the host document
    if (lname.includes(':') && lname !== 'xlink:href') continue; // inkscape:*, sodipodi:*, xml:space, ...
    if (lname === 'class' || lname === 'data-name' || lname === 'tabindex') continue;
    let outName = name;
    let outValue = value;
    if (lname === 'id') {
      outValue = renameId(value);
    } else if (lname === 'href' || lname === 'xlink:href') {
      const trimmed = value.trim();
      if (!trimmed.startsWith('#')) continue; // external, data: or javascript: references are dropped
      outName = 'href';
      outValue = `#${renameId(trimmed.slice(1))}`;
    } else if (lname === 'style') {
      outValue = sanitizeStyle(value, { rewriteUrls, monochrome });
      if (outValue === '') continue;
    } else if (URL_REF.test(value)) {
      URL_REF.lastIndex = 0;
      outValue = rewriteUrls(value);
    }
    URL_REF.lastIndex = 0;
    if (monochrome === 'fill' && (lname === 'fill' || lname === 'stroke') && isHardcodedColor(outValue)) {
      outValue = 'currentColor';
    }
    parts.push(` ${outName}="${escapeAttr(outValue)}"`);
  }
  return parts.join('');
}

function isHardcodedColor(value) {
  const v = value.trim().toLowerCase();
  return v !== 'none' && v !== 'currentcolor' && v !== 'inherit' && v !== 'transparent' && !v.startsWith('url(');
}

function sanitizeStyle(style, { rewriteUrls, monochrome }) {
  const decls = [];
  for (const raw of style.split(';')) {
    const idx = raw.indexOf(':');
    if (idx === -1) continue;
    const prop = raw.slice(0, idx).trim().toLowerCase();
    let value = raw.slice(idx + 1).trim();
    if (prop === '' || value === '') continue;
    if (prop.startsWith('-')) continue; // vendor / inkscape properties
    if (/expression|javascript:|@import|behavior/i.test(value)) continue;
    if (/url\(\s*['"]?(?!#)/i.test(value)) continue; // external url()
    value = rewriteUrls(value);
    if (monochrome === 'fill' && (prop === 'fill' || prop === 'stroke') && isHardcodedColor(value)) value = 'currentColor';
    decls.push(`${prop}:${value}`);
  }
  return decls.join(';');
}

// ---------------------------------------------------------------------------
// Manifest + generated data (derived entirely from what is on disk)
// ---------------------------------------------------------------------------

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function humanize(name) {
  return name.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

async function listLocalIcons(packName) {
  const dir = join(ASSETS_DIR, packName);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.svg'))
    .map((e) => e.name.slice(0, -4))
    .sort();
}

async function buildOutputs() {
  const manifest = { packs: {}, icons: {} };
  const icons = [];
  const problems = [];

  for (const packName of Object.keys(PACKS).sort()) {
    const pack = PACKS[packName];
    const names = await listLocalIcons(packName);
    manifest.packs[packName] = {
      license: pack.license,
      homepage: pack.homepage,
      vendored: pack.vendored,
      count: names.length,
      ...(pack.licenseUrl ? { licenseUrl: pack.licenseUrl } : {}),
    };
    for (const name of names) {
      const bytes = await readFile(join(ASSETS_DIR, packName, `${name}.svg`));
      const url = pack.vendored ? pack.urls(name)[0] : undefined;
      manifest.icons[`${packName}/${name}`] = {
        pack: packName,
        name,
        sha256: sha256(bytes),
        license: pack.license,
        ...(url ? { url } : { url: null, note: 'added locally by the user; see assets/icons/README.md' }),
      };
      const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const cleaned = sanitizeSvg(bytes.toString('utf8'), {
        prefix: `ic-${packName}-${safeName}`,
        monochrome: pack.monochrome,
      });
      if (!cleaned) {
        problems.push(`${packName}/${name}: no <svg> root or viewBox; skipped`);
        continue;
      }
      icons.push({
        id: `${packName}:${name}`,
        pack: packName,
        title: cleaned.title || humanize(name),
        viewBox: cleaned.viewBox,
        body: cleaned.body,
        monochrome: pack.monochrome !== false,
        license: pack.license,
        ...(url ? { source: url } : {}),
      });
    }
  }

  icons.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { manifestText: canonicalJson(manifest), dataText: renderDataTs(icons), icons, problems, manifest };
}

function renderDataTs(icons) {
  const lines = [
    '/**',
    ' * GENERATED by tools/fetch-icons.mjs. Do not edit by hand.',
    ' *',
    ' * Vendored icon bodies, sanitised and inlined so the renderer needs neither',
    ' * network nor filesystem access. Provenance and checksums live in',
    ' * assets/icons/manifest.json; licences in assets/icons/README.md.',
    ' */',
    '',
    "import type { IconDef } from './icons.ts';",
    '',
    'export const VENDORED_ICONS: readonly IconDef[] = [',
  ];
  for (const icon of icons) {
    const fields = [
      `id: ${JSON.stringify(icon.id)}`,
      `pack: ${JSON.stringify(icon.pack)}`,
      `title: ${JSON.stringify(icon.title)}`,
      `viewBox: ${JSON.stringify(icon.viewBox)}`,
      `body: ${JSON.stringify(icon.body)}`,
      `monochrome: ${icon.monochrome}`,
      `license: ${JSON.stringify(icon.license)}`,
    ];
    if (icon.source) fields.push(`source: ${JSON.stringify(icon.source)}`);
    lines.push(`  {\n    ${fields.join(',\n    ')},\n  },`);
  }
  lines.push('];', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function verify() {
  const { manifestText, dataText, manifest, problems } = await buildOutputs();
  let ok = true;
  const onDisk = await readText(MANIFEST_PATH);
  if (onDisk === null) {
    console.error(`FAIL manifest missing: ${MANIFEST_PATH}`);
    ok = false;
  } else if (onDisk !== manifestText) {
    ok = false;
    const stored = JSON.parse(onDisk);
    const storedIcons = stored.icons ?? {};
    for (const key of Object.keys(storedIcons)) {
      const current = manifest.icons[key];
      if (!current) console.error(`FAIL ${key}: listed in manifest but file missing`);
      else if (current.sha256 !== storedIcons[key].sha256)
        console.error(`FAIL ${key}: sha256 mismatch (manifest ${storedIcons[key].sha256.slice(0, 12)}..., disk ${current.sha256.slice(0, 12)}...)`);
    }
    for (const key of Object.keys(manifest.icons)) {
      if (!storedIcons[key]) console.error(`FAIL ${key}: on disk but not in manifest`);
    }
    console.error('FAIL manifest.json is not identical to what the tree on disk produces');
  }
  const data = await readText(DATA_PATH);
  if (data === null) {
    console.error(`FAIL generated data missing: ${DATA_PATH}`);
    ok = false;
  } else if (data !== dataText) {
    console.error('FAIL icons.data.ts is stale: regenerate with node tools/fetch-icons.mjs');
    ok = false;
  }
  for (const p of problems) console.error(`WARN ${p}`);
  const total = Object.keys(manifest.icons).length;
  console.log(ok ? `OK ${total} icons verified against manifest and generated data` : `FAILED verification of ${total} icons`);
  return ok ? 0 : 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  if (opts.verify) return verify();

  await mkdir(ASSETS_DIR, { recursive: true });
  const summary = [];
  const allFailures = [];

  for (const packName of opts.packs) {
    const pack = PACKS[packName];
    if (!pack.vendored) {
      console.log(`\n[${packName}] NOT downloaded. Licence: ${pack.license}`);
      console.log(`  Official archive: ${pack.homepage}`);
      console.log(`  ${pack.obligations}`);
      const local = await listLocalIcons(packName);
      console.log(`  Local files found in assets/icons/${packName}/: ${local.length}`);
      continue;
    }
    process.stdout.write(`[${packName}] fetching ${pack.names.length} icons ... `);
    const result = await fetchPack(packName, pack);
    console.log(`${result.written} written, ${result.unchanged} unchanged, ${result.failures.length} failed`);
    summary.push({ packName, ...result });
    for (const f of result.failures) allFailures.push({ packName, ...f });
  }

  const { manifestText, dataText, icons, problems } = await buildOutputs();
  const manifestChanged = await writeIfChanged(MANIFEST_PATH, Buffer.from(manifestText));
  const dataChanged = await writeIfChanged(DATA_PATH, Buffer.from(dataText));

  console.log('\nSummary');
  const counts = {};
  for (const icon of icons) counts[icon.pack] = (counts[icon.pack] ?? 0) + 1;
  for (const packName of Object.keys(PACKS).sort()) {
    const pack = PACKS[packName];
    console.log(`  ${packName.padEnd(12)} ${String(counts[packName] ?? 0).padStart(4)} icons   ${pack.license}${pack.vendored ? '' : '   (declared, not vendored)'}`);
  }
  console.log(`  manifest.json   ${manifestChanged ? 'updated' : 'unchanged'}`);
  console.log(`  icons.data.ts   ${dataChanged ? 'updated' : 'unchanged'}`);
  for (const p of problems) console.log(`  WARN ${p}`);
  if (allFailures.length > 0) {
    console.log(`\n${allFailures.length} icon(s) could not be fetched (the run still succeeded):`);
    for (const f of allFailures) console.log(`  ${f.packName}/${f.name}: ${f.reason}  ${f.url ?? ''}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    console.error('\n' + usage());
    process.exit(2);
  },
);

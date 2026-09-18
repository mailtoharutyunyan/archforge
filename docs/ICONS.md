# Icons

The renderer never fetches anything. Every icon it can draw is either a
hand-drawn built-in glyph in `packages/core/src/render/icons.ts` or a vendored
SVG body inlined into `packages/core/src/render/icons.data.ts` by
`tools/fetch-icons.mjs`. Licensing and provenance are in
`assets/icons/README.md`.

## API

```ts
import { resolveIcon, builtinGlyph, getIcon, listIcons, ICON_PACKS } from '.../render/icons.ts';

resolveIcon({ kind: 'container', technology: 'PostgreSQL 16' });   // simpleicons:postgresql
resolveIcon({ kind: 'container', subtype: 'queue' });              // builtin:queue
resolveIcon({ kind: 'container', explicit: 'kubernetes:pod' });    // kubernetes:pod
builtinGlyph('person');                                            // always returns an IconDef
```

An `IconDef` has `viewBox` and `body` (inner markup only; no `<svg>`
wrapper, no `width`/`height`). To draw one at `x, y` with size `s`:

```ts
`<svg x="${x}" y="${y}" width="${s}" height="${s}" viewBox="${icon.viewBox}" color="${hex}">${icon.body}</svg>`
```

Monochrome icons (`monochrome: true`) reference only `currentColor`, so
setting `color` on the wrapper recolours them. Filled brand marks
(simpleicons) come wrapped in `<g fill="currentColor">`; stroke sets
(builtin, lucide, tabler) come wrapped in `<g fill="none"
stroke="currentColor" stroke-width="2" ...>`. Multi-colour packs (devicon,
kubernetes) keep their own colours and ignore `color`.

Every `id` inside a body is prefixed `ic-<pack>-<name>-`, so any number of
icons can be inlined into one document without gradient or clip-path
collisions.

## Resolution order

`resolveIcon(query)` is deterministic. It tries, in order, and returns the
first hit:

1. **`explicit`** – the DSL `icon "..."` property.
   - Exact id (`simpleicons:postgresql`).
   - `pack:name` with the name normalised.
   - A bare name (`postgresql`, `database`) looked up in each pack in
     priority order (below), then through the alias table.
   - If none of that matches, resolution continues with the next step
     instead of failing.
2. **`technology`** – normalised and matched against the alias table, then
   as a bare name across packs.
3. **`subtype`** – as a bare name across packs (`database` finds
   `lucide:database`), then via subtype synonyms (`db`, `rdbms`, `mq`,
   `spa`, `faas`, ...), then the alias table.
4. **`tags`** – sorted first, then each tag through the alias table.
5. **`builtinGlyph(kind, subtype)`** – never fails. Subtype synonyms pick a
   semantic glyph (queue, topic, cache, api, browser, function, ...);
   otherwise the kind's glyph; otherwise `builtin:unknown`.

### Pack priority

When a bare name exists in more than one pack, the earlier pack wins:

```
simpleicons > devicon > kubernetes > aws > azure > gcp > lucide > tabler > builtin
```

`aws`, `azure` and `gcp` are declared but empty unless the user adds files
(see `assets/icons/README.md`); they participate in the order so that
locally added official icons take precedence over generic fallbacks. Ties
never depend on object key order: the registry is a sorted array and every
lookup iterates `PACK_PRIORITY` or an explicit candidate list.

### Technology normalisation

`technologyCandidates("Java 21 / Spring Boot")` yields
`["springboot", "spring", "boot", "java"]`:

- Lowercase; `C#`, `C++`, `.NET`, `Node.js`, `Vue.js`, `Next.js`, `Pub/Sub`
  are rewritten before punctuation is stripped.
- Split into segments on `/ , + | ; & ( )` and the words `on`, `with`,
  `and`, `using`, `via`.
- Drop version tokens: `16`, `3.12`, `v2`, `1.x`, `21a`. Digits that are
  part of a word (`s3`, `ec2`, `oauth2`) are kept.
- Multi-word segments are tried first as one token (`springboot`), then
  individual words. Within a tier, later segments are tried before earlier
  ones, because "Language / Framework" conventionally lists the general
  thing first and the specific thing last.

Each candidate goes through the alias table, which maps a token to a
preference-ordered list of ids; the first id present in the registry wins.
Entries may name icons from non-vendored packs and still degrade sensibly,
e.g. `sqs: ['aws:sqs', 'builtin:queue']`. If no alias matches, the token is
looked up as a bare name across packs, so any vendored icon is reachable by
its name without an alias entry.

## Built-in glyphs

Seventeen 24x24 stroke glyphs, 2px stroke, round caps and joins, all
`currentColor`, CC0-1.0: `person system container component database queue
topic cache api service browser mobileApp function deploymentNode
infrastructureNode external unknown`. They share the idiom of lucide and
tabler so mixing the three sets looks intentional.

## Adding an icon to an existing pack

1. Add the upstream name to the pack's list in `tools/fetch-icons.mjs`
   (`SIMPLEICONS_NAMES`, `DEVICON_NAMES`, `KUBERNETES_NAMES`, `LUCIDE_NAMES`,
   `TABLER_NAMES`).
2. Optionally add alias entries in `TECH_ALIASES` in `icons.ts` so
   technology strings reach it (a bare-name match already works).
3. Run `node tools/fetch-icons.mjs --pack <pack>`. The script downloads
   only that pack, then regenerates `manifest.json` and `icons.data.ts` from
   everything on disk.
4. Run `node tools/fetch-icons.mjs --verify` and commit
   `assets/icons/**`, `manifest.json` and `icons.data.ts` together.

## Adding a new pack

1. Confirm the licence permits redistribution (CC0, MIT, ISC, Apache-2.0 and
   similar are fine; vendor-specific "for depicting our products" terms are
   not — see how `aws`/`azure`/`gcp` are declared without `vendored`).
2. Verify the raw URL pattern with `curl` before relying on it.
3. Add an entry to `PACKS` in `tools/fetch-icons.mjs`: `license`, `homepage`,
   `licenseUrl`, `vendored: true`, `monochrome` (`'fill'` for single-colour
   filled marks, `'stroke'` for currentColor stroke sets, `false` for
   colour art), a sorted `names` list and a `urls(name)` function returning
   the candidate URLs to try in order.
4. Add the pack to `PACK_PRIORITY` and `PACK_META` in `icons.ts`, and to the
   table in `assets/icons/README.md` (licence, whether it is in git, upstream).
5. Run the script, then `--verify`.

## What the sanitiser does

Upstream SVGs are untrusted input that gets inlined into our output. For
each file the script:

- extracts `viewBox` (or synthesises it from `width`/`height`) and the text
  of `<title>`;
- drops the `<svg>` wrapper, XML prolog, DOCTYPE and comments;
- removes, with content: `script`, `foreignObject`, `style`, `metadata`,
  `title`, `desc`, `image`, `iframe`, `object`, `embed`, `video`, `audio`,
  SMIL `animate*`/`set`, and any namespaced element (`sodipodi:*`, `rdf:*`);
- unwraps `<a>` and `<switch>`;
- removes attributes: `on*` handlers, `xmlns*`, `class`, `tabindex`, every
  namespaced attribute (`inkscape:*`, `sodipodi:*`, `xml:space`), and any
  `href` that is not a local `#fragment` (`xlink:href` becomes `href`);
- filters `style="..."` declarations: vendor `-*` properties, `expression`,
  `javascript:`, `@import`, `behavior` and external `url()` are dropped;
- prefixes every `id` and rewrites `url(#id)` / `href="#id"` to match;
- for `monochrome: 'fill'` packs, rewrites hardcoded `fill`/`stroke`
  colours to `currentColor`; for `'stroke'` packs hoists the root
  presentation attributes onto a `<g>` wrapper;
- normalises `viewBox` to four plain numbers and skips (with a warning) any
  file that has no usable root or viewBox.

The stored `assets/icons/<pack>/<name>.svg` is the raw upstream file; only
the generated `icons.data.ts` is sanitised.

## Determinism

Names are sorted before fetching and before generation; the manifest is
canonical JSON; the data file lists icons by id. Files are written only when
their bytes change. Re-running with unchanged upstream leaves the tree
byte-identical, and `--verify` fails if the manifest or the generated data
disagree with the files on disk.

# archforge

**Architecture as code, that can't go stale.**

One structured model of your system. Every C4 view derived from it. Your own
architecture rules enforced in CI. And — the part nobody else does — a check
that the documented architecture still matches the actual source code.

- **Web editor:** static, no backend, runs entirely in the browser
- **Bidirectional authoring:** draw on the canvas *or* edit the text — same model, both ways
- **CLI:** `arch check`, `arch render`, `arch drift`, `arch analyze`, `arch diff`
- **MCP server:** so AI agents can read and propose architecture changes safely
- **Zero runtime dependencies.** Node 22.6+ runs the TypeScript directly.

---

## Why this exists

Nobody's actual problem is "I can't draw a diagram" — that was solved decades
ago. The problem is that the diagram stops being true, quietly, and no one finds
out until an incident.

Freeform diagramming tools cannot help with this, because in those tools **the
picture is the data**. There is nothing to validate. Here **the model is the
data** and pictures are projections of it, which makes three things possible
that a drawing cannot do:

| | Freeform tools | archforge |
| --- | --- | --- |
| Source of truth | the drawing | the model |
| Views | drawn by hand, drift apart | derived, always consistent |
| Can it be linted? | no | cycles, forbidden dependencies, ownership |
| Knows your code? | no | drift detection with file:line evidence |
| Review in a PR | opaque blob | readable text diff |

---

## Bidirectional authoring

This is the part that does not exist elsewhere. Drawing tools have no text
model; the text-based architecture tools have no visual authoring. Here they are
the same model, and edits flow both ways:

- **Drag from the palette** onto the canvas — 100+ semantic entries, so dropping
  "PostgreSQL" creates a *database element with its technology set*, not an
  unlabelled cylinder. It renders with the right icon, participates in rules and
  can be drift-checked immediately.
- **Shift-click** a second element to connect it.
- **Edit fields in the inspector**, including the identifier — renaming it is a
  real refactor that updates every reference (relationships, view scopes,
  dynamic steps, `instanceOf`) and is *verified by recompiling* before it is
  applied.
- **Drag a node** to pin its position. That writes to the layout file, never to
  the architecture.
- **Type in the source pane** and the canvas updates live.

Every visual action is a surgical edit to the source text, so your comments,
blank lines and formatting survive — and undo is exact, because it is just the
previous text.

## Quick start

```bash
git clone https://github.com/<you>/archforge && cd archforge
npm install                      # one dev dependency: typescript

npx arch init                    # scaffold .archforge/architecture.arch
npx arch check --recommended     # compile + evaluate architecture rules
npx arch render --all            # SVG diagrams into out/diagrams
npx arch docs                    # ARCHITECTURE.md + diagrams
```

Point it at an existing repository instead:

```bash
npx arch analyze ./my-repo > architecture.arch
npx arch check architecture.arch
npx arch drift architecture.arch --repo ./my-repo
```

Run the web editor locally:

```bash
node tools/build-site.mjs
python3 -m http.server 8080 -d site      # then open http://localhost:8080
```

---

## The DSL

```
workspace "Payment Platform" {

  person customer "Customer"

  system payments "Payment Platform" {
    owner "team-payments"
    tag domain-payment

    container api "Payment API" {
      technology "Java 21 / Spring Boot"
      source "services/payment-api"     // binds to code — enables drift checks
      tag internal
    }

    database db "Payments DB" { technology "PostgreSQL 16" }
    topic events "payment.events" { technology "Apache Kafka" }
  }

  customer -> payments.api "Pays" { technology "HTTPS/JSON" }
  payments.api -> payments.db "Reads and writes" { technology "JDBC" }

  views {
    context   landscape "System landscape" of payments
    container platform  "Containers"       of payments
    dynamic   checkout  "Taking a payment" {
      customer -> payments.api "Submits card"
      payments.api -> payments.db "Persists the intent"
    }
  }

  rules {
    rule no-cycles { severity error  forbid cycles }

    rule domains "Order must not reach payment internals" {
      severity error
      forbid element(tag:domain-order) -> element(tag:internal, tag:domain-payment)
    }

    rule owned {
      severity warning
      require owner on element(kind:container)
    }
  }
}
```

Full grammar: `arch` MCP tool `dsl_reference`, or [`examples/`](examples/).

### Selectors

Rules are written against *sets*, not individual ids, so they keep working as
the model grows:

```
*                                        everything
tag:internal                             one predicate
element(kind:container, tag:internal)    predicates are ANDed, values glob
```

Predicates: `tag`, `owntag`, `kind`, `id`, `name`, `owner`, `tech`, `in`,
`source`, `provenance`.

`tag` is **inherited**: tagging a system `domain-payment` covers everything
inside it, which is what makes domain rules work — a rule written against a
system's tag would otherwise match nothing and pass silently. Use `owntag` when
you mean "tagged here and not above".

---

## Drift detection

Bind a container to the directory that implements it with `source "..."`, then:

```console
$ arch drift --repo .

ARCHITECTURE DRIFT
16 files scanned · 12 declared · 9 detected

✗ Payment Worker depends on Redis (redis/client), but no declared relation accounts for it
    detector: redis/client · confidence: high
    services/payment-worker/.../IdempotencyStore.java:17  private final StringRedisTemplate redis;
⚠ Payment Worker is declared to depend on Notification Service, but nothing in the code supports it
i  PaymentController has no source binding, so drift cannot be assessed for it

6 finding(s), 1 error(s).
```

Two deliberate design decisions here:

- **Confidence is a class, never a number.** `high` means the code cannot
  plausibly mean anything else (an annotation, a typed client). There are no
  invented percentages anywhere in this project.
- **The report states its own coverage.** Elements with no `source` binding are
  listed as unchecked, so a clean report never implies more than it verified.

### Languages

Detection is table-driven, so a stack is data rather than a new scanner:
Java/Kotlin (Spring-aware), JavaScript/TypeScript, Python, Go, .NET, Ruby, PHP,
Rust, plus dependency manifests (`package.json`, `requirements.txt`, `go.mod`,
`pom.xml`, `*.csproj`, `Cargo.toml`, `Gemfile`), Dockerfiles, Compose,
Kubernetes manifests and Terraform.

---

## AI agents (MCP)

```json
{
  "mcpServers": {
    "archforge": {
      "command": "node",
      "args": ["/path/to/archforge/packages/mcp/src/server.ts"],
      "env": { "ARCH_SOURCE": ".archforge/architecture.arch" }
    }
  }
}
```

Agents get 13 tools. The important thing is what they *don't* get: a CRUD API
over your graph. Mutation is a two-step, human-gated flow:

1. `propose` — compiles the candidate, evaluates the rules, returns a
   structural diff. **Writes nothing.**
2. a human reads the diff
3. `apply confirm=true` — refuses anything that does not compile, and refuses
   anything that breaks an error-severity rule unless explicitly overridden

Read-only tools: `get_model`, `query`, `validate`, `impact`, `list_views`,
`render`, `docs`, `scan_repository`, `drift`, `diff_models`, `dsl_reference`.

---

## Determinism

Every artefact is byte-stable across runs and machines: sorted output, integer
geometry, no timestamps, no randomness, no host paths. This is not tidiness for
its own sake — it is what makes a rendered diagram reviewable in a pull request
instead of producing noise on every build.

```console
$ arch render --all --out a && arch render --all --out b && diff -rq a b
# (no output)
```

---

## Repository layout

```
packages/core/     the engine — runs in Node AND the browser, no dependencies
  dsl/             lexer, parser, compiler, emitter
  model/           the architecture model and graph queries
  views/           model → view derivation, relationship lifting
  layout/          deterministic hierarchical layout, manual pin storage
  render/          SVG renderer, offline icon registry
  rules/           selector-based rule engine
  diff/            structural diff
  scan/            repository scanners (host-agnostic via FileSource)
  drift/           declared vs implemented comparison
  export/          self-contained PlantUML, Mermaid
  docs/            Markdown generation
packages/cli/      the `arch` command
packages/mcp/      MCP server for AI agents
packages/web/      static editor + landing page (→ GitHub Pages)
assets/icons/      vendored icon packs with checksums and licences
examples/          payment-platform (small), globex-commerce (107 elements)
tools/             site build, icon vendoring
```

### Why TypeScript, and why no bundler

The parser, validator, layout and renderer must behave identically in the CLI,
in CI, and in the browser. Implementing them once in TypeScript and compiling to
native ES modules achieves that with no server, no database and no build step
for development. It is also what makes a static GitHub Pages deployment
possible at all.

---

## Icons

290 icons resolve offline, keyed off `technology`, `subtype` or an explicit
`icon "..."`. Vendored with a checksum manifest:

| Pack | Count | Licence | In git |
| --- | --- | --- | --- |
| Simple Icons | 97 | CC0-1.0 | yes |
| Devicon | 63 | MIT | yes |
| Lucide | 46 | ISC | yes |
| Tabler | 46 | MIT | yes |
| Kubernetes / CNCF | 21 | Apache-2.0 | yes |
| built-in glyphs | 17 | CC0-1.0 | yes |
| AWS / Azure / GCP | — | vendor terms prohibit redistribution | **no** — opt in locally |

```bash
node tools/fetch-icons.mjs            # re-vendor (deterministic)
node tools/fetch-icons.mjs --verify   # check the committed bytes
```

See [`assets/icons/README.md`](assets/icons/README.md) and
[`docs/ICONS.md`](docs/ICONS.md).

---

## CLI reference

| Command | Purpose |
| --- | --- |
| `arch init [dir]` | scaffold a workspace |
| `arch check [src]` | compile and evaluate architecture rules |
| `arch model [src]` | print the resolved model (`--json` for the contract) |
| `arch views [src]` | list derived views |
| `arch render [src]` | `--format svg\|puml\|mermaid\|json`, `--all`, `--out` |
| `arch analyze [repo]` | reverse-engineer a repository into `.arch` |
| `arch drift [src] --repo` | compare the model against real code |
| `arch impact [src] <id>` | direct and transitive dependents |
| `arch diff <a> <b>` | structural diff, `--exit-code` for CI |
| `arch docs [src]` | generate `ARCHITECTURE.md` plus diagrams |
| `arch layout [src]` | prune stale manual positions |
| `arch icons` | list vendored icon packs |

Exit codes: `0` clean · `1` findings · `2` usage error · `3` model does not compile.

---

## Known limitations

Stated plainly, because a tool about honesty should be honest about itself:

- **`forbid a -> b` checks declared relations, not transitive reachability.** A
  transitive check sounds stricter but fires on paths nobody considers a
  dependency. Cycle detection covers the transitive case where it matters.
- **Scanners are heuristic.** They read text, not ASTs. They can be fooled by an
  annotation inside a string literal, and they will miss a dependency reached
  through a layer of indirection. Everything they find carries evidence so you
  can judge it yourself.
- **Drift only covers elements with a `source` binding.** The report says so.
- **Text metrics are approximated**, not measured against a real font, so box
  sizing is close but not pixel-perfect. This is the price of identical geometry
  in Node and the browser.
- **The canvas is not a freeform drawing surface.** You add elements from a
  semantic palette and connect them; you cannot draw an unlabelled box that
  means nothing. That is deliberate — an unconstrained drawing is exactly what
  cannot be validated.
- **Edge routing is orthogonal with distributed ports, not obstacle-avoiding.**
  Lines no longer converge on a single point per box and labels avoid nodes, but
  a very dense view can still produce a line that passes near an unrelated box.
- **No collaboration, auth or persistence server.** The browser keeps your work
  in `localStorage`; real storage is your Git repository.
- **Text metrics are approximated**, so a label can occasionally be a few pixels
  narrower or wider than its box assumes.

## License

Apache-2.0.

# Vendored icons: licensing and provenance

Everything the renderer draws comes from this directory or from hand-drawn
glyphs in `packages/core/src/render/icons.ts`. Rendering never makes a
network call. This tree is produced by `node tools/fetch-icons.mjs`; do not
edit files here by hand.

Layout:

- `<pack>/<name>.svg` – the upstream file, byte for byte, as downloaded. Kept
  raw so the checksum in the manifest can be compared with upstream.
- `manifest.json` – canonical JSON (sorted keys) recording, per icon: pack,
  name, sha256 of the stored bytes, upstream URL, licence. `node
  tools/fetch-icons.mjs --verify` recomputes it from disk and fails on any
  difference.
- The sanitised inner markup that actually ships is generated into
  `packages/core/src/render/icons.data.ts` (see `docs/ICONS.md` for what the
  sanitiser strips).

## Packs

| Pack | Licence | In git? | Upstream | Notes |
| --- | --- | --- | --- | --- |
| `builtin` | CC0-1.0 (this project) | yes (source code) | `packages/core/src/render/icons.ts` | 17 hand-drawn 24x24 stroke glyphs. Default visual language. |
| `simpleicons` | CC0-1.0 | yes | https://github.com/simple-icons/simple-icons | Monochrome brand marks. The public-domain dedication covers the SVG files; the brands themselves remain trademarks of their owners and are used here nominatively, to label the technology they depict. Note that Simple Icons has removed AWS and Azure marks at the request of those companies, so none are vendored. |
| `devicon` | MIT | yes | https://github.com/devicons/devicon | Colour developer-tool logos (`*-original.svg`, or `*-plain.svg` where no original exists). MIT covers the files; trademarks as above. |
| `kubernetes` | Apache-2.0 (alternatively CC-BY-4.0, at the user's choice) | yes | https://github.com/kubernetes/community/tree/master/icons | Resource icons from the unlabeled set. The Kubernetes logo is a registered trademark of The Linux Foundation; its trademark policy applies (https://www.linuxfoundation.org/trademark-usage/). |
| `lucide` | ISC | yes | https://github.com/lucide-icons/lucide | Generic 24x24 stroke glyphs (database, server, cloud, ...). Same visual idiom as `builtin`. |
| `tabler` | MIT | yes | https://github.com/tabler/tabler-icons | Generic 24x24 stroke glyphs, outline variant. Fallback generic set. |
| `aws` | AWS Architecture Icons terms | **no** | https://aws.amazon.com/architecture/icons/ | Declared only. See below. |
| `azure` | Microsoft Azure architecture icons terms | **no** | https://learn.microsoft.com/en-us/azure/architecture/icons/ | Declared only. See below. |
| `gcp` | Google Cloud architecture icons terms | **no** | https://cloud.google.com/icons | Declared only. See below. |

Icon counts per vendored pack are recorded in `manifest.json` under `packs`.

## Cloud provider packs are not redistributed

AWS, Microsoft and Google publish official architecture icon sets, but each
under its own terms rather than an open licence. In summary, and without
attempting to restate the legal text:

- **AWS** allows the icons to be used to depict AWS-based architectures, and
  prohibits redistribution as part of an icon library or product. The
  official package is at https://aws.amazon.com/architecture/icons/.
- **Azure** allows use in architecture diagrams, training material and
  documentation about Azure; the icons may not be modified, used as a brand
  or redistributed as a set. The official package is at
  https://learn.microsoft.com/en-us/azure/architecture/icons/.
- **Google Cloud** provides the icons for depicting its products in
  diagrams; they are not under an open licence. The official package is at
  https://cloud.google.com/icons.

Because this repository is an icon library from the point of view of those
terms, none of these files are committed here. We do not claim a right to
redistribute them.

If you want them in your own diagrams, you (not this project) accept the
terms and add the files locally:

1. Download the official package from the URL above and read its terms.
2. Copy the SVGs you need into `assets/icons/aws/`, `assets/icons/azure/` or
   `assets/icons/gcp/`, named as the resolver expects. The alias table in
   `icons.ts` looks for, at minimum:
   - `aws`: `aws.svg s3.svg rds.svg aurora.svg lambda.svg dynamodb.svg sqs.svg sns.svg kinesis.svg eventbridge.svg eks.svg ecs.svg fargate.svg ec2.svg cloudfront.svg route53.svg apigateway.svg elasticache.svg cloudwatch.svg iam.svg cognito.svg`
   - `azure`: `azure.svg functions.svg cosmosdb.svg aks.svg servicebus.svg eventhubs.svg blobstorage.svg sqldatabase.svg keyvault.svg appservice.svg apimanagement.svg`
   - `gcp`: `googlecloud.svg gke.svg bigquery.svg pubsub.svg cloudrun.svg cloudsql.svg cloudstorage.svg cloudfunctions.svg spanner.svg firestore.svg dataflow.svg`
3. Run `node tools/fetch-icons.mjs --pack aws` (or `azure`, `gcp`). The
   script downloads nothing for these packs; it prints the obligations,
   ingests whatever is in the directory, records each file in the manifest
   with `"url": null` and a note that it was added locally, and regenerates
   `icons.data.ts`.
4. Decide for yourself whether committing the result to your repository is
   consistent with the terms you accepted. Adding these directories to
   `.gitignore` is a reasonable default.

Until such files exist, every AWS/Azure/GCP alias degrades to a generic
glyph from `lucide`, `tabler` or `builtin` (for example `sqs` renders the
built-in queue, `dynamodb` the generic database, `lambda` the built-in
function). Nothing renders blank.

## Rejected sources

- **macosicons.com** – raster PNG/ICNS only, macOS application icons rather
  than infrastructure, and user-submitted derivatives of trademarked logos
  with unclear per-icon redistribution rights. Not used.
- **Simple Icons AWS/Azure slugs** – removed upstream (404), so not
  available even though the pack licence would permit it.

## Re-vendoring

```
node tools/fetch-icons.mjs                # default packs: simpleicons,devicon,kubernetes,lucide,tabler
node tools/fetch-icons.mjs --pack lucide  # one pack; the generated data still covers every pack on disk
node tools/fetch-icons.mjs --verify       # checksums + generated data, exit 1 on mismatch, writes nothing
```

The script is idempotent: with no upstream change, a re-run leaves every
file byte-identical. Individual 404s are reported at the end and never fail
the run.

# DaSo Aufmaßtool

Quantity surveys (Aufmaß), extra-effort and timesheet reports for DaSo Lüftungsbau:
bill-of-quantities import, daily reports with PDF export, and an evaluation by
project, employee or subcontractor. A saved report is finished and stays editable.
Access is restricted to DaSo staff through Cloudflare Access.

## Stack

- Next.js on [vinext](https://github.com/cloudflare/vinext), deployed as a Cloudflare Worker
- Cloudflare D1 for records, Cloudflare R2 for files
- Cloudflare Access for sign-in. The Worker verifies the signed Access token on
  every request; roles (Planer / Obermonteur / Buchhaltung) are checked server-side in `lib/auth.ts`

## Local development

Requires Node.js `>=22.13.0` and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm run dev
```

For local development put `DASO_DEV_IDENTITY=1` in `.dev.vars` (git-ignored); the app then
treats unauthenticated requests as a local Planer. Never set it in production. Tests:

```bash
pnpm test
```

## Configuration

Worker secrets (`wrangler secret put <name> --name daso-aufmasstool`):

| Name | Purpose |
| --- | --- |
| `CF_ACCESS_TEAM_DOMAIN` | Zero Trust team domain, e.g. `team.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | Audience tag of the Cloudflare Access application |
| `DASO_OWNER_EMAIL` | Email that is always a Planer |

Roles come from the Montageplanung users table. Buchhaltung can read everything but cannot change data. `access:<email>` records in `records` (Planer or Obermonteur) cover people who are not listed there, and `DASO_OWNER_EMAIL` is always a Planer.

## Build and deploy

The Worker `daso-aufmasstool` is connected to this repository through Cloudflare
Workers Builds. The defaults work as they are: leave the Build command empty and
keep the Deploy command `npx wrangler deploy`.

`wrangler.jsonc` holds the bindings and runs `pnpm run build` before deploying, so
no framework detection happens. The build writes `dist/server/wrangler.json`,
which the Vite plugin derives from `wrangler.jsonc`.
`.github/workflows/ci.yml` runs type-check and tests on every push.

## Old customer links

Links of the form `/p/<token>` from earlier mails show a page saying that the link is no longer active.

## Montageplanung

The Worker has a second D1 binding, `PLAN_DB`, to the Montageplanung database. It is
only read: user roles (`planer`, `obermonteur`, `buchhaltung`; `monteur` has no access) decide access here, and
planned projects with customer contacts can be copied into a new project.

## Database migrations

```bash
pnpm run db:generate
wrangler d1 execute DB --remote --config dist/server/wrangler.json --file drizzle/<migration>.sql
```

The database `daso-aufmass-eu` (D1) and the bucket `daso-aufmass-files-eu` (R2) are in Western Europe and separate from Montageplanung. Apply
`drizzle/0000_hard_bill_hollister.sql` once to a new, empty database.

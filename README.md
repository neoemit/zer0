# ⚡ zer0

[![License: MIT](https://img.shields.io/github/license/neoemit/zer0?style=flat-square)](LICENSE)
![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js&logoColor=white)
![Docker Compose](https://img.shields.io/badge/docker-compose-2496ED?style=flat-square&logo=docker&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?style=flat-square&logo=fastify&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7-C92F24?style=flat-square&logo=redis&logoColor=white)

A tiny, fast, self-hosted URL shortener built for Docker Compose. zer0 keeps the redirect path lean, protects public link creation with CAPTCHA, stores links in Redis, and includes a browser admin dashboard for stats and cleanup.

## ✨ Features

- 🚀 **Fast redirect hot path**: `GET /:code` validates the slug, checks the in-process hot cache, falls back to Redis on cache miss, records stats, and returns a `302 Location`.
- 🧠 **In-process hot cache**: repeated redirects avoid Redis reads while still recording click stats.
- 🧩 **Custom slug generator**: users can provide a safe custom slug or let zer0 generate a friendly one from the homepage.
- 🛡️ **Cloudflare Turnstile on creation only**: redirects never pay the CAPTCHA cost; in admin-only mode, the CAPTCHA appears with the admin-token unlock gate instead of the link form.
- 🔒 **Admin-only creation mode**: set `ADMIN_ONLY_MODE=true` so only visitors with the admin token can create short URLs while redirects stay public.
- 🗄️ **Redis persistence**: Docker Compose uses Redis 7 with AOF enabled.
- ⏳ **User-selected validity**: pre-fill link validity from configuration, then let creators choose finite or indefinite validity per link.
- 🎨 **Modern responsive UI**: the public creator and admin workspace share a tidy design system with accessible controls, focused dialogs, and compact mobile layouts.
- 🌓 **Theme selection**: choose System, Light, or Dark across the public creator, admin dashboard, and invalid-link page.
- 🪐 **Branded invalid-link page**: expired, removed, missing, or malformed public short URLs render a helpful HTML page instead of plain `Not found` text.
- 🏡 **Self-hosting prompt**: the homepage footer invites visitors to self-host their own zer0 and links to the source code at <https://github.com/neoemit/zer0>.
- 📊 **Admin stats**: total clicks plus country buckets from local GeoIP lookup.
- 🧭 **Admin dashboard**: token-based login, local token persistence, search, pagination, country names, refresh, logout, dialog-based link editing, guided import/export, deletion confirmation, and accessible status updates.
- 🧹 **Cleanup controls**: delete one link or all links; deletion removes metadata, stats, and hot-cache entries so slugs can be reused with fresh counters.

## 🧱 Stack

- **Node.js 24 + Fastify 5**: small service with low-overhead HTTP routing.
- **Redis 7**: persistent key/value backing store with optional per-link TTLs.
- **geoip-lite**: local country-level GeoIP lookup; unknown/private IPs are grouped as `ZZ`.
- **Cloudflare Turnstile**: CAPTCHA protection for public URL creation and admin-only creator unlocks.
- **Docker Compose**: one app container plus Redis.

## 🚀 Quick start

```bash
cp .env.example .env
# edit PUBLIC_BASE_URL, TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, and ADMIN_TOKEN
docker compose up -d --build
```

Then open `http://localhost:3000` or your configured `PUBLIC_BASE_URL`.

Useful endpoints:

- 🌐 Homepage: `/`
- 🎨 Favicon: `/favicon.svg`
- 🩺 Health check: `/healthz`
- 🔐 Admin dashboard: `/admin` when `ADMIN_TOKEN` is configured

## ⚙️ Configuration

- `PUBLIC_BASE_URL`: public origin used when returning short URLs.
- `PORT`: host/container app port. Default `3000`.
- `TRUST_PROXY`: set `true` behind a trusted reverse proxy so IP-based stats use forwarded client IPs.
- `CAPTCHA_PROVIDER`: `turnstile` or `none`. Defaults to `turnstile` when a Turnstile secret exists, otherwise `none`.
- `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`: Cloudflare Turnstile keys for public creation CAPTCHA or admin-only creator unlock CAPTCHA.
- `CODE_LENGTH`: generated short-code length. Default `7` gives about 3.5 trillion possible base62 codes.
- `RETENTION_DAYS`: default validity in days used to pre-fill the creation form and default API requests. `0` or unset means indefinite by default; users can still choose a different value per link.
- `ADMIN_TOKEN`: enables admin-only stats/list/delete APIs and the `/admin` dashboard. Leave unset to disable the admin API.
- `ADMIN_ONLY_MODE`: set to `true` to require the admin token before visitors can access the homepage creator or call `POST /api/shorten`. Redirects stay public.
- `HOT_CACHE_MAX_ENTRIES`: max in-process redirect cache entries.
- `HOT_CACHE_TTL_MS`: hot cache TTL in milliseconds.
- `REDIRECT_CACHE_CONTROL`: `Cache-Control` header on redirects. Default `public, max-age=300` helps browsers/CDNs cache redirects.
- `CREATE_RATE_LIMIT_MAX` / `CREATE_RATE_LIMIT_WINDOW`: rate limit for the creation endpoint only.

For local development without CAPTCHA:

```bash
CAPTCHA_PROVIDER=none
```

> ⚠️ Do not use `CAPTCHA_PROVIDER=none` on a public instance.

## 🔌 API

### Create a short URL

```bash
curl -X POST http://localhost:3000/api/shorten \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","slug":"optional-custom-slug","validityDays":30,"captchaToken":"TURNSTILE_TOKEN"}'
```

When `ADMIN_ONLY_MODE=true`, the homepage asks for the admin token and CAPTCHA together before showing the creator. API clients should verify that pair first:

```bash
curl -X POST http://localhost:3000/api/creation-auth \
  -H 'content-type: application/json' \
  -d '{"adminToken":"'$ADMIN_TOKEN'","captchaToken":"TURNSTILE_TOKEN"}'
```

Then create links with the admin token header. The creation request itself does not include a CAPTCHA token in admin-only mode because the CAPTCHA belongs to the unlock step:

```bash
curl -X POST http://localhost:3000/api/shorten \
  -H 'content-type: application/json' \
  -H 'X-Admin-Token: $ADMIN_TOKEN' \
  -d '{"url":"https://example.com","slug":"optional-custom-slug","validityDays":30}'
```

Only visitors with the admin token can create short URLs in admin-only mode. Redirects stay public, so every short URL that an admin creates can still be used by anyone.

Response:

```json
{
  "code": "abc123",
  "shortUrl": "https://z.example.com/abc123",
  "targetUrl": "https://example.com/",
  "expiresInDays": 30
}
```

`validityDays` is optional. When omitted, zer0 uses the configured `RETENTION_DAYS` default. `0` means the link is valid indefinitely. `expiresInDays` is `null` for indefinite links, otherwise it is the selected positive validity value.

### Redirect

```bash
curl -i http://localhost:3000/abc123
```

Returns `302 Location: <target-url>` when the slug exists. If the short URL is expired, removed, malformed, or missing, zer0 returns a branded invalid-link page explaining that the URL is no longer valid and asking the visitor to request a fresh link from the person who shared it.

## 🏡 Public homepage and self-hosting footer

The public homepage is intentionally lightweight and friendly:

- a URL creation form with optional custom slug input, validity-days input, and a custom slug generator;
- an admin-token gate with CAPTCHA for the creation form when `ADMIN_ONLY_MODE=true`;
- a stable result panel with copy and open-link actions;
- a System / Light / Dark theme selector persisted in browser `localStorage`;
- a stylised zero favicon served from `/favicon.svg`;
- a "Made with ❤️ in Cape Town" footer;
- a self-hosting note linking to the source code: <https://github.com/neoemit/zer0>.

Self-host your own zer0 by forking or cloning the repository, configuring `.env`, and running Docker Compose from the quick-start commands above.

## 🔐 Admin API and dashboard

Admin routes require `ADMIN_TOKEN`. The simplest header form is:

```bash
-H 'X-Admin-Token: $ADMIN_TOKEN'
```

The admin API also accepts a bearer `Authorization` header.

If `ADMIN_TOKEN` is unset, admin APIs return `503` and stay disabled.

### Stats for one link

```bash
curl -H 'X-Admin-Token: $ADMIN_TOKEN' \
  http://localhost:3000/api/stats/abc123
```

```json
{
  "code": "abc123",
  "totalClicks": 42,
  "countries": {
    "IT": 20,
    "US": 12,
    "ZZ": 10
  }
}
```

### List all links

```bash
curl -H 'X-Admin-Token: $ADMIN_TOKEN' \
  http://localhost:3000/api/admin/links
```

```json
{
  "links": [
    {
      "code": "abc123",
      "shortUrl": "https://z.example.com/abc123",
      "targetUrl": "https://example.com/",
      "createdAt": "2026-06-08T12:00:00.000Z",
      "validityDays": 30,
      "expiresAt": "2026-07-08T12:00:00.000Z",
      "expiresInDays": 30,
      "totalClicks": 42,
      "countries": {
        "IT": 20,
        "US": 12,
        "ZZ": 10
      }
    }
  ]
}
```

### Edit link fields

Admins can edit a link slug, destination URL, and validity. Saving a positive validity value resets expiry from the save time. Saving `0` makes the link valid indefinitely. Slug changes are non-destructive: if the requested slug already exists, zer0 returns `409` and leaves both links unchanged.

```bash
curl -X PATCH -H 'content-type: application/json' \
  -H 'X-Admin-Token: $ADMIN_TOKEN' \
  -d '{"code":"new-slug","targetUrl":"https://example.com/new","validityDays":0}' \
  http://localhost:3000/api/admin/links/abc123
```

For backward compatibility, a validity-only payload such as `{"validityDays":30}` still works.

### Export links

Export downloads a zer0 JSON backup that can be imported later to restore links with metadata, validity, expiry, total click counts, and country stats.

```bash
curl -H 'X-Admin-Token: $ADMIN_TOKEN' \
  http://localhost:3000/api/admin/export
```

The export response has this shape:

```json
{
  "schemaVersion": 1,
  "app": "zer0",
  "exportedAt": "2026-06-13T12:00:00.000Z",
  "links": [
    {
      "code": "abc123",
      "targetUrl": "https://example.com/",
      "createdAt": "2026-06-08T12:00:00.000Z",
      "validityDays": 30,
      "expiresAt": "2026-07-08T12:00:00.000Z",
      "expiresInDays": 30,
      "stats": {
        "totalClicks": 42,
        "countries": {
          "IT": 20,
          "US": 12,
          "ZZ": 10
        }
      }
    }
  ]
}
```

### Import links

Import is admin-only and non-destructive by default. Existing slugs are skipped, invalid rows are reported, and valid rows continue importing.

```bash
curl -X POST -H 'content-type: application/json' \
  -H 'X-Admin-Token: $ADMIN_TOKEN' \
  -d @zer0-export.json \
  http://localhost:3000/api/admin/import
```

For API imports, send either a zer0 export wrapper:

```json
{
  "mode": "zer0",
  "export": {
    "app": "zer0",
    "links": []
  }
}
```

Or custom normalized records:

```json
{
  "mode": "custom",
  "records": [
    {
      "targetUrl": "https://example.com/",
      "code": "optional-slug",
      "validityDays": 0,
      "totalClicks": 0,
      "countriesJson": "{\"US\":2}"
    }
  ]
}
```

Custom CSV imports are available in the admin dashboard. Choose **Custom CSV**, upload a CSV file, map the required target URL column, and optionally map slug, timestamps, validity, expiry, total clicks, and country stats. Optional fields can also use a manual fallback value, for example validity `0` for every row. Missing optional fields use zer0 defaults: generated slug, current creation time, indefinite validity, and zero stats.

Common custom headers are detected automatically, including `source` as slug, `target` as destination URL, and `hits` as total clicks. Imported slugs are sanitized by stripping invalid characters, so `/snippets/` becomes `snippets`. If total clicks are provided without country stats, zer0 assigns those clicks to `ZZ` / Unknown.

### Delete links

Deletion removes the URL record, metadata, stats, and in-process hot-cache entry. Once deleted, the slug is available again; if recreated, counters start from zero.

```bash
# Delete one record
curl -X DELETE -H 'X-Admin-Token: $ADMIN_TOKEN' \
  http://localhost:3000/api/admin/links/abc123

# Delete all records
curl -X DELETE -H 'X-Admin-Token: $ADMIN_TOKEN' \
  http://localhost:3000/api/admin/links
```

### Browser dashboard

Open `/admin`, paste `ADMIN_TOKEN`, and load the dashboard.

The dashboard:

- stores a successfully used token in browser `localStorage` for future visits;
- hides the token form and shows links only after authentication succeeds;
- supports refresh, logout, substring search across all slug and destination records before pagination, a remembered row-count preference, side-panel slug/destination/validity edits, zer0 export downloads, and a guided import dialog;
- asks for confirmation in an accessible dialog before deleting a link;
- opens an accessible country breakdown with flags when a link's click total is selected;
- suppresses zero-valued country counters for unclicked links;
- clears the stored token on logout or failed `401` authentication.

The frontend remains build-free. Shared CSS and JavaScript are served from `/assets/*`, and the System / Light / Dark theme preference is shared across all HTML pages.

## 🧪 Development

```bash
npm install
npm test
npm run lint
npm start
```

Local app defaults:

```bash
CAPTCHA_PROVIDER=none npm start
```

## Release workflow

Every pull request must include a `## Release notes` section. Use `- No user-facing changes.` when a PR should not appear in release notes. GitHub Actions validates that section on PRs, and `.github/release.yml` configures GitHub’s generated release notes for tagged releases.

The project is currently versioned at `0.2.0`; create future GitHub releases from version tags after merging release-worthy changes.

## 🏎️ Performance notes

- Keep Redis on the same Docker network/host as the app.
- Put a CDN or reverse proxy in front and keep `REDIRECT_CACHE_CONTROL` enabled if links do not need instant retargeting.
- Scale reads horizontally by running multiple `zer0` containers against the same Redis; each container keeps its own hot cache.
- Every redirect records click stats in Redis, even when the target URL comes from hot cache.
- The creation endpoint is intentionally heavier because it validates URLs, rate-limits, and verifies CAPTCHA. It is separate from the redirect hot path.

## 📦 Dependency and license notes

Direct runtime dependencies are permissively licensed:

- `@fastify/formbody`: MIT
- `@fastify/rate-limit`: MIT
- `fastify`: MIT
- `geoip-lite`: Apache-2.0
- `ioredis`: MIT
- `nanoid`: MIT
- `undici`: MIT

`npm audit --omit=dev --audit-level=moderate` currently reports zero known production vulnerabilities.

## 📄 License

zer0 is open source under the [MIT License](LICENSE).

MIT is a good fit here because zer0 is an infrastructure tool meant to be easy to self-host, fork, embed, and improve with minimal legal friction while remaining compatible with the current permissive dependency set.

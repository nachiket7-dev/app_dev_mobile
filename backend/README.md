# Campus Chat Backend

NestJS 11, pinned Prisma 6.19.3, MongoDB 7 replica set, and a supported Node LTS runtime. See the root [setup guide](../README.md) and [API contract](../README_API.md) for the submission workflow.

## Startup

From the project root:

```bash
npm --prefix backend ci
npm --prefix backend run prisma:generate
npm run setup:env
docker compose --env-file backend/.env -f backend/docker-compose.yml up --build --wait
```

MongoDB must be PRIMARY. The locked builder/provision image initializes verified defaults and required indexes before the non-root API runtime starts. Prisma generation alone does not initialize indexes. Ordinary Compose shutdown keeps database/key volumes; do not remove them to resolve a migration error.

For local host editing, with a prepared database:

```bash
npm run db:inspect
npm run db:provision
npm run api:dev
```

Root wrappers supply the local environment explicitly and keep the backend's own working directory. Backend database scripts themselves do not silently load or fall back to a development URL. Set `DATABASE_URL` explicitly when invoking them without a wrapper/Compose.

## Verification

```bash
npm --prefix backend run verify
TEST_DATABASE_URL='<isolated loopback Mongo URI on non-default port/test_* database>' npm --prefix backend run test:integration
```

Unit checks require no database. Integration derives uniquely named disposable databases, validates the namespace/host/port before destructive cleanup, and never drops the supplied base or ordinary database. It exercises real HTTP authorization, concurrent registration/DM/send/receipt behavior, same-timestamp pagination, private files, schema provisioning, and reviewed legacy migration.

## Data And Authentication

The legacy raw `Basic username:password` header is retained; passwords are salted hashes and never profile-response fields. Missing legacy hashes fail closed rather than bypass verification. First-use registration and exact two-member DM creation handle concurrent requests through unique constraints and transactions.

`db:inspect` reports safe counts, indexes, legacy/conflict summaries and a review token. Provisioning refuses unsafe legacy/conflicting data. Migration is an explicit, backed-up, writer-stopped operation tied to its reviewed snapshot; no silent account/history merge or volume reset is performed. Read the dry report and supply its required acknowledgement/credential mapping before applying.

Bot mode is off by default. A single internal FactBot identity cannot be claimed/authenticated by humans; usable fixed bot credentials are removed. Optional bot ticks have a bounded interval/batch and an overlap guard. Do not enable it merely to populate a submission: two ordinary test accounts are sufficient.

## Operational Boundaries

- Production requires HTTPS through an explicitly trusted proxy and forbids local-HTTP opt-in. Keep API/Mongo bindings private unless deliberately enabling a test-only LAN API.
- CORS origins are explicit; public health and preflight do not register users. CORS is not authorization.
- Size/pixel/input limits, concurrent request/upload/media gates and per-minute limits are bounded single-instance controls. A 429 is recoverable for safe reads; message/file POSTs are not blindly retried.
- Content, credential and unsafe user-controlled terminal logs are removed. Health contains no connection credentials.
- Legacy inline images are bounded independently of binary uploads. Uploaded raster files must decode; signature-only fake PNG/JPEG/BMP data is rejected.
- Remote-upload DNS/address/redirect SSRF checks and deadline/size cleanup are retained. Generic non-image downloads use attachment disposition and `nosniff`.
- Production-scale quotas/retention/backups/distributed limits and authorized hosting/signing are separate operational work, not implied by passing a local test.

Prisma CLI/config dependency advisories are reviewed separately from the runtime HTTP module graph. Compatible patches are preferred; no forced Prisma-major upgrade is used to hide a report. The integration suite checks that runtime bootstrap/database/HTTP paths do not load the config/merge advisory libraries.

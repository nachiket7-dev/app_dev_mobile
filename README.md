# Campus Chat

An Expo SDK 58 / React Native chat client with Expo Router, a NestJS backend, and Prisma on a MongoDB 7 replica set. The submission scope is private text/photo conversations, groups, paged history, reliable retries, truthful receipts, and a reproducible local demonstration.

## Requirements

- Node 22.23.5, pinned in `.nvmrc`, and npm. Other supported Node LTS versions must satisfy package engine requirements.
- Docker Desktop with Docker Compose v2+ for MongoDB and the containerized backend.
- Expo Go compatible with SDK 58 or an authorized development/internal build for native use. Browser verification does not count as native-device testing.

## Fresh Setup

From the project root:

```bash
npm ci
npm --prefix backend ci
npm --prefix backend run prisma:generate
npm run setup:env
docker compose --env-file backend/.env -f backend/docker-compose.yml up --build --wait
npm start
```

`setup:env` generates owner-only `backend/.env` with random local MongoDB credentials, a disposable `test_demo` database on port 27027, and API port 3000. Credentials are not printed. If a file already exists, it is left unchanged: inspect its database/ports before starting anything. Never reuse this demo configuration or test passwords for shared/private-data deployment.

Compose waits for replica-set PRIMARY, then runs the pinned, non-destructive provisioning/index job before starting the compiled API. MongoDB is loopback-only. Application code changes require a rebuild; host `node_modules` are not mounted into Linux containers.

- API: `http://127.0.0.1:3000`
- API specification: `http://127.0.0.1:3000/docs`
- Public readiness/capabilities: `http://127.0.0.1:3000/health`
- Expo development web: `http://localhost:8081`

The first authenticated request registers an unused handle. Use two different disposable handles and session-only passwords to demonstrate messaging. Usernames must be compatible with the documented raw-header contract; this is not standard base64 HTTP Basic.

Choose **Included backend** on sign-in for this project. Enter the server URL appropriate to the device: localhost for browser/iOS simulator, `10.0.2.2:3000` for an Android emulator, or an explicitly enabled private LAN development endpoint for a physical device. A phone's localhost is not the computer's localhost.

For a physical-device development demo, expose only the API intentionally using `API_BIND_HOST=0.0.0.0` or run the host API with the appropriate bind address. Keep MongoDB private, use test accounts, and use HTTPS for any shared build. Production forbids the local-HTTP opt-in.

## Host Development And Existing Data

The host API can use the prepared replica set while you edit source:

```bash
npm run db:inspect
npm run db:provision
npm run api:dev
```

These root wrappers load `backend/.env` and run commands in the backend's own working directory. `api:dev` enables local HTTP only for an explicitly development/test configuration; it does not downgrade a production configuration.

Provisioning verifies/backfills safe defaults and indexes, but refuses conflicting or legacy credential data. It never silently merges accounts or chat histories. For existing non-test data, stop writers, inspect, make a protected backup, run the migration dry report, and review its token before any explicit apply:

```bash
npm run db:inspect
npm run db:migrate
# Only after backup/review: npm run db:migrate -- --apply --review-token=<reviewed-token>
```

Applying migration also requires `MIGRATION_ACKNOWLEDGE_BACKUP=true` and any required explicit legacy credential mapping. Do not set these automatically. Duplicate identities, poisoned DMs, and unknown bot ownership need individual review; no data-reset workaround is provided.

Stop ordinary services without deleting their data:

```bash
docker compose --env-file backend/.env -f backend/docker-compose.yml down
```

Never add `--volumes` for an ordinary development database. Only explicitly disposable test projects may be destroyed.

## Features And Safety

- Exact two-participant DMs with database-enforced pair identity, transaction-safe creation, and caller membership on message reads/writes.
- Password hashes instead of passwords in `User.phone`; wrong/missing credentials fail closed and concurrent first-use registration does not create duplicate identities.
- Server/account changes clear old identity, requests, private-media caches, and outgoing work, require reauthentication, and warn before discarding unsent messages.
- Protected incoming/outgoing photos, bounded validation, and authenticated web blob rendering; files are not made public to fix image loading.
- Older history loading, stable time/ID ordering, correct DM counterpart names, last-activity previews, unread metadata, and active/visible-recipient read acknowledgement.
- Immediate outbox feedback, explicit retries, stable idempotency keys, successful upload reuse, and failed-photo caption/reselection/removal controls.
- Cached chats remain usable during refetch errors. Creation/upload/server errors have visible, cross-platform feedback.
- Light/dark/system appearance and persistent non-secret server selection. Passwords, accounts, and outbox contents are intentionally not restored after app restart.

**External / campus legacy** mode is explicit. It does not assume this backend's health, idempotency, file-upload, summary, or acknowledgement extensions exist. It preserves the existing raw-auth/text/inline-photo contract and does not display invented receipts. No campus endpoint is accessed by the test suite. External server security/availability is outside this checkout's control.

## Verification

```bash
npm run verify
npx expo install --check
npx expo-doctor
```

`verify` runs frontend lint/types/pure regression tests and the backend's independent generate/lint/types/unit/build checks. Real HTTP/MongoDB and browser tests are separate and require an explicitly isolated service.

Example disposable service, using a local environment file for credentials:

```bash
MONGO_DATABASE=test_submission MONGO_PORT=27027 API_PORT=3100 NODE_ENV=test \
  ALLOW_INSECURE_LOCAL_HTTP=true \
  docker compose -p campus-chat-test --env-file backend/.env -f backend/docker-compose.yml up --build --wait
```

Provide `TEST_DATABASE_URL` with the test instance's credentials, a `test_*` database, loopback host and non-default port. Integration creates and deletes only uniquely generated test databases; it does not reset either the supplied base or the ordinary development database.

```bash
TEST_DATABASE_URL='<explicit isolated MongoDB URI>' npm --prefix backend run test:integration
npx playwright install chromium
E2E_API_URL=http://127.0.0.1:3100 npm run test:web
```

Browser success cases use the real API and no CORS/HTML interception shim. Fault injection is clearly limited to loss/error cases. Both mobile and desktop web viewports are checked. `.github/workflows/verify.yml` wires fresh installs, provisioning, checks, disposable integration, browser tests, exports and evidence retention.

To use an already installed Chrome locally, set `CHROME_EXECUTABLE_PATH` to its executable. This avoids downloading a browser but does not change the test semantics.

## Production Export And Submission

```bash
npm run export:web
npm run serve:web
npm run export:all
npm run package:submission
```

The client-rendered export contains a real HTML entry without prerendering private conversations. The local preview serves `dist/web` on loopback port 4173 with an HTML route fallback; include its exact origin in backend `CORS_ORIGINS`. `serve:web -- --dir dist/app` previews the all-platform export instead.

The source archive is created under `.artifacts/`. Packaging excludes real environment files, dependency/caches, backups, signing material, generated native/build files, and test traces. It includes source, lockfiles, tests, templates, and documentation. Inspect the archive and add the required screenshots/recording and authorized native artifact separately.

`eas.json` supplies an internal Android APK preview profile and an iOS simulator profile. Cloud builds, account setup, app identifiers, signing and hosting need owner authorization. Before a shared build, configure a reachable approved HTTPS `EXPO_PUBLIC_API_URL`; do not publish a localhost/insecure demo default.

```bash
# After authorization and release configuration only:
npx eas-cli@latest build --platform android --profile preview
```

The demo identifiers `edu.example.campuschat.demo` are not a claim of store ownership. Store publication is outside the default academic submission.

## Known Boundaries

- Updates use REST polling, not WebSockets, push, presence or typing indicators.
- Voice/calls, full document picking/sharing, editable profiles, advanced group management, message edit/delete, account/password recovery, and durable offline outbox are not presented as implemented features.
- Unsupported raster codecs are rejected cleanly; JPEG/PNG are the portable photo path. Generic non-image attachments get explicit file/unsupported cards rather than fake photos.
- Quotas and concurrency limits are single-process safeguards. Production-scale retention, distributed limits, backups and deployment monitoring need a separate operational scope.
- Moderate frontend tooling advisories and any Prisma CLI/config-only advisory exceptions must be reviewed; passing functional tests is not a claim of zero supply-chain risk.
- Actual native-device/build results, external backend limitations, and authorized artifact links must accompany the final handover. A JavaScript export or small web viewport is not a native APK test.

`PROJECT_AUDIT.md` records the pre-fix baseline; `SUBMISSION_PLAN.md` records the approved fix scope. See current verification evidence rather than interpreting historical audit failures as current results.

## Verified Implementation

Local checks completed after implementation:

| Check | Result |
| --- | --- |
| Frontend regression tests, retaining the original 21 | 58 passed |
| Backend unit/stream/validation regressions | 43 passed |
| Real HTTP/MongoDB security and migration integration | 15 passed |
| Actual exported-app browser checks, mobile and desktop | 8 passed, with no CORS/HTML success bypass |
| Frontend/backend lint, types and backend compilation | Passed |
| Expo compatibility and native deduplication diagnostics | 20/20 passed |
| iOS/Android Hermes and production web export | Passed; real `dist/app/index.html` generated |
| Locked Node 22.23.5 production/provision images | Built and verified; health ready and CLI advisory modules absent from runtime graph |
| Original development database inspection | Zero records, no migration or test-data writes performed |

The HTTP suite covers outsiders, three-person DM poisoning, concurrent registration/DM/sends, lost committed replies, caller-only concurrent read batches, 100 equal-timestamp messages, protected photos, input/stream bounds, provisioning, and reviewed legacy migration. The browser suite also checks server reauthentication, no credential transfer to a changed host, and non-secret server/appearance persistence.

Actual iOS 27 Expo Go checks exercised local login, one-tap contact selection, DM/group text sending, received protected PNG, gallery selection/cropping and outgoing JPEG, and delivered/read acknowledgement. Native QA found and reverified the photo-preview close-button correction: its top is now 78 points, 16 below the 62-point status inset, and one centre tap at (364, 101) dismisses the preview. Software-keyboard overlap, Android execution and standalone signed binaries remain unverified and must not be inferred from these checks.

Native screenshots and structured results are retained in `/var/folders/zb/f2xpgmlj4zb_gvz1nbq1hlx80000gp/T/kilo/native-qa-20261123/`, including `15-fixed-photo-preview-before-centre-tap.png`, `16-fixed-photo-preview-after-centre-tap.png`, and `native-qa-result.json`. Browser evidence is generated under `test-results/` and `playwright-report/` when the suite runs.

Remaining dependency exception: `npm audit --omit=dev` reports three high entries for the single `deepmerge-ts <8` advisory chain through Prisma CLI/config. Moving to Prisma 7/8 solely to suppress it would be a breaking migration. Tests and the actual production container verify that config/deepmerge/effect modules are not loaded by HTTP/database runtime paths; do not use untrusted recursive CLI configuration. The compatible Effect patch is applied. Frontend tooling still has moderate advisories requiring maintenance review.

# Project Audit

Historical pre-fix baseline. The implementation authorized after this audit is described in `README.md` and `SUBMISSION_PLAN.md`; current verification supersedes the old command results below. The original findings are retained for traceability, not presented as unresolved current behavior.

Date: 2026-11-21

Status: Complete. Source, setup, backend/API, browser, dependency, and export checks finished. No application fixes applied.

## Assessment

The project can install, compile, and pass its existing automated checks, but it has confirmed privacy, authentication, concurrency, and cross-platform defects. It should not be used for private conversations or exposed as a production service in its current state.

This audit covers the source in this checkout and locally running instances of its backend. It does not establish how the separate campus server is configured. No campus-server requests, cloud builds, paid services, dependency upgrades, or application-code fixes were performed.

## Setup Completed

- Installed frontend and backend dependencies using their existing lockfiles with `npm ci`.
- Generated Prisma Client 6.19.3 and validated the MongoDB schema.
- Added ignored `backend/.env` with a newly generated local database password and owner-only file permissions (`0600`). Do not use this local configuration as a production configuration.
- Started MongoDB 7 as a single-node replica set, restricted to `127.0.0.1:27017` using a temporary Compose override outside the project.
- Ran `npm run prisma:push` for the local development database, including its username unique index.
- Built the backend normally and built and started its production Docker image against a separate fresh test database.
- Started the actual Expo web entry and tested it in Chrome at mobile and desktop viewport sizes.
- Exported iOS, Android, and web bundles into a temporary directory, without generating native projects.

Only the local environment file and this requested report were intentionally added to the project. Application source, dependency manifests/lockfiles, and existing documentation were not patched. Installed dependencies, generated Prisma/TypeScript output, and Expo caches are setup artifacts.

## Check Results

| Check | Result | Interpretation |
| --- | --- | --- |
| Frontend `npm test` | 21/21 passed | Tests cover API fetching, outbox utilities, and theme utilities, not the complete app or backend authorization. |
| `npm run lint` | Passed | Existing Expo lint configuration. |
| Full frontend ESLint, including JS screens and tests | Passed | No lint failures; this does not prove correct behavior. |
| Frontend `npm run typecheck` | Passed | Most screens and contexts are JavaScript and are not checked with `checkJs`. |
| Backend own TypeScript check | Passed | Checked separately because root configuration excludes `backend`. |
| Prisma validate/generate/schema push | Passed | Local development database is initialized. |
| Backend production compile | Passed | `npm run build`. |
| Production Docker build and startup | Passed | Its missing database initialization is a separate defect below. |
| Expo all-platform production export | Command passed | Native JS bundles generated; web output has no HTML entry. These are not native builds. |
| Expo native configuration introspection | Passed | Does not substitute for running a native binary. |
| Actual web entry at 390x844 and 1440x1000 | Passed | Auth UI renders after JS loads; no initial runtime exceptions or horizontal overflow. The server-rendered Router welcome screen alone is not evidence that development web startup is broken. |
| `expo-doctor` | 18/20 checks passed | Failed native-module deduplication and SDK dependency-version compatibility. |
| `expo install --check` | Failed | 13 package-version mismatches. |
| Frontend `npm audit` | 14 moderate findings | Dependency advisories, not 14 demonstrated application exploits. |
| Backend `npm audit` | 11 findings: 6 high, 5 moderate | Production-only audit reports 8: 6 high, 2 moderate. Reachability varies; some findings are tooling/transitive dependencies. |

## Browser Runtime Evidence

The unmodified browser login was separately captured without Playwright routing or a CORS shim: its actual preflight returned 404, Chrome reported `PreflightMissingAllowOriginHeader`, and the UI remained signed out with "Cannot connect to server."

The following deeper interaction checks ran against the real app and real local APIs with an explicitly temporary CORS-only interception shim. No application code was replaced and no temporary HTML shell was needed.

- Text sending returned 201, persisted on the server, and reconciled after polling. Normal new-DM and group creation returned 201 and navigated to the chat composer.
- Received and outgoing server-stored images requested their real download URLs without `Authorization` and received 401. A separately authenticated download of the same fixture succeeded with 200 and 68 bytes.
- Switching from the first local API to the second kept the old profile ID on screen, while the second server's successful profile response had a different ID. The same credentials went to the second server, and the current account became selectable as a new-chat recipient.
- A controlled conversation-create 503 produced no dialog, DOM alert, displayed error, or changed screen text. Repeating the action against the real backend succeeded with 201, ruling out an inert test control.
- A DM initiated by another account displayed the viewer's own handle in its `[DM]` title rather than identifying the sender.
- A 25-message history showed only messages #06-25. Scrolling from top to bottom and back issued no older-page cursor request; all 20 rows were present in the DOM, so the missing five were not a virtualization artifact.
- Mobile and desktop composer/navigation checks showed no horizontal overflow or JavaScript page exceptions. This is browser evidence, not native-device evidence.
- Dark appearance remained saved and applied across reload. Reload sign-out was treated as the existing session-persistence limitation, not a newly discovered regression.

Browser screenshots and structured evidence are in the temporary directory `/var/folders/zb/f2xpgmlj4zb_gvz1nbq1hlx80000gp/T/kilo/chatapp-audit-tools/`. `browser-baseline-final.json` is the authoritative unmodified CORS/appearance capture; `browser-flows.json` contains the deeper shim-assisted UI checks, and `unmodified-web.json` contains startup/viewport checks. Interception can automatically answer preflights, so earlier intercepted captures are not used to establish the backend's actual preflight status.

## Highest-Priority Defects

### 1. Critical: Outsiders can read and write private conversations

Any authenticated account can fetch messages for another conversation and post messages into it if the conversation ID is known. Auto-registration means obtaining an account is not a meaningful barrier.

Local reproduction: a third user absent from the participant list received private text with HTTP 200, posted an injected message with HTTP 201, and the legitimate participant could then see that injection.

Evidence: `backend/src/message/message.controller.ts:51-55`, `backend/src/message/message.service.ts:21-49`, `backend/src/message/message.service.ts:65-124`. The read path does not receive the caller, and the write path checks existence but not membership.

File endpoints separately enforce access. This finding is not a claim that every attached file is anonymously downloadable; text, inline images, and attachment metadata are exposed by message fetching.

### 2. Critical: An outsider can turn an intended private DM into a three-person chat

The API accepts `type: "DM"` with more than one recipient. Its normal DM lookup matches conversations containing both requested users, rather than exactly those two users.

Local reproduction: C created a DM containing C, A, and B. A's subsequent ordinary DM request for B returned C's same conversation. A's uploaded attachment then became downloadable by C with HTTP 200 because C was now a legitimate participant.

Evidence: `backend/src/conversation/dto/conversation.dto.ts:16-36`, `backend/src/conversation/conversation.service.ts:67-103`. The frontend also hardcodes a returned DM's member count as two in `src/screens/NewChatScreen.js:53-59`, obscuring the extra participant.

### 3. High: Passwords are plaintext and default connections are unencrypted

Passwords are stored verbatim in `User.phone` and compared directly. A local test account's database field exactly matched its test password. The default HTTP server URL and HTTP presets transmit the literal username/password on every authenticated request without transport encryption.

Evidence: `backend/src/auth/auth.guard.ts:35-68`, `backend/prisma/schema.prisma:13-18`, `src/api/config.ts:3-9`, `src/api/config.ts:24-32`. The sign-in screen's secure-synchronization claim at `src/screens/AuthScreen.js:184-185` does not match this implementation.

Current user-list/profile responses omit the password field; a direct password leak from those endpoints was not established.

### 4. High: Fresh Docker deployments do not create required database indexes

Generating Prisma Client does not apply database indexes. Neither the Docker startup command nor Compose runs schema push or a separate database-provisioning step.

Local reproduction: the built production image started against a fresh database with only `_id_` on `users`. Eight simultaneous registrations using the same username and different passwords all returned HTTP 200 and created eight separate user IDs. The `@unique` annotation did not enforce uniqueness there.

Evidence: `backend/Dockerfile:13-22`, `backend/Dockerfile:48-54`, `backend/docker-compose.yml:45-65`, `backend/prisma/schema.prisma:15`. The audit's development database was initialized manually; the shipped deployment workflow remains unchanged.

### 5. High: Browser authentication fails against the included backend

The backend does not enable CORS for the web app's origin or authenticated requests. Local OPTIONS preflight returned HTTP 404 with no `Access-Control-Allow-Origin`.

Evidence: `backend/src/main.ts:8-22`, `backend/src/main.ts:53-54`, `src/api/config.ts:47-73`.

Further browser interaction checks use an explicitly labeled, temporary CORS-only interception shim. Success under that shim must not be read as success of the unmodified client/backend integration.

### 6. High: Production web export is not deployable as configured

`web.output` is `static` and the Router plugin is enabled, but the application uses a custom entry and manual React Navigation with no Router screens. Export emits JS, assets, and metadata, but no HTML files or `index.html`.

Evidence: `app.json:22-36`, `package.json:3`, `index.js:1-8`, `App.js:45-48`, absence of `src/app`/`app` routes, and the actual exported output. A custom entry can work in development; the problem is its mismatch with the selected static-export configuration.

### 7. High: Native compatibility checks fail

Expo reports 13 version mismatches, including installed Expo 58.0.22 versus recommended `~58.0.26`, React Native 0.88.0 versus 0.88.1, and screens 4.30.0 versus `~4.30.1`. Two native copies of `react-native-screens` are installed: top-level 4.30.0 and Router-nested 4.30.1.

Evidence: `package.json:12-31`, lockfile, and actual `expo-doctor`/`expo install --check` output. Native build/runtime failure has not been proven, but this is a diagnosed native-build risk, not a clean dependency baseline. No automatic upgrades or `npm audit fix --force` were applied.

## App Behavior Defects

| Priority | Problem | Evidence and impact |
| --- | --- | --- |
| High | Server switching keeps the previous server's identity | `src/context/AuthContext.js:28-35` changes URL/cache but keeps `user`, username, and password. With different server-side IDs, Settings and ownership checks use the old profile while requests authenticate as the new server's account. Old credentials are automatically sent to the new host. |
| High | Server-stored photos cannot authenticate on web | `src/screens/ChatRoomScreen.js:55-65,368-383,642-650` supplies image headers, but React Native Web's image loader does not send them. Anonymous downloads were confirmed HTTP 401. Local optimistic previews can hide this until reconciliation/reopening. |
| High | Incoming DMs can have indistinguishable, wrong names | Backend stores one shared `[DM] <recipient>` name (`conversation.service.ts:89-103`); `src/screens/ChatListScreen.js:46-58` prefers it over counterpart resolution. Bob sees his own name for DMs initiated by Alice and Carol, risking replies to the wrong chat. |
| Medium | Only the latest 20 messages are accessible | `src/screens/ChatRoomScreen.js:69-89,494-553`, `src/api/hooks.ts:106-123` never load `nextCursor`. Both HTTP and browser tests confirmed 25 stored messages but only #06-25 displayed; #01-05 exist on the older API page. Scrolling issued no cursor request. |
| Medium | First-use authentication races return server errors | `backend/src/auth/auth.guard.ts:53-68` uses separate lookup/create without collision recovery. On an initialized database, eight parallel first-use requests returned one 200 and seven 500s. |
| Medium | Concurrent DM creation splits a chat across duplicates | `backend/src/conversation/conversation.service.ts:69-113` has a lookup/insert race and no unique pair constraint. Eight parallel creates produced eight distinct conversations, all HTTP 201. |
| Medium | Delivery/read indicators never reflect recipient activity | `backend/src/message/message.service.ts:107-123` initializes flags only. The recipient fetched the message, but both recipient flags remained false. No acknowledgement endpoint exists. |
| Medium | A delayed login can undo sign-out or server switching | `src/context/AuthContext.js:38-75` has no login-generation/cancellation guard. A late profile response can restore a signed-out user while the global API credentials remain cleared, or leave React state and HTTP configuration pointing to different servers. Source-confirmed; asynchronous UI reproduction is separate. |
| Medium | A polling error hides usable cached conversations | `src/screens/ChatListScreen.js:205-250` replaces the list on any query error, including refetch errors with retained data. Users cannot open cached chats/outbox entries during an outage. |
| Medium | Server settings and sign-in disagree | `src/screens/AuthScreen.js:22-35` initializes its server field from the default, not the active context. Logout keeps the custom context URL, but sign-in resets to campus. `SettingsScreen.js:29-55` also tests the applied URL rather than an unsaved edited URL. |
| Medium | New-chat failures have no browser feedback | `src/screens/NewChatScreen.js:61-63,105-107` only calls `Alert.alert`; React Native Web's implementation is a no-op. Rejected DM/group creation silently returns to the contacts UI. |
| Medium | Permanently failed photos cannot be corrected or removed | `src/screens/ChatRoomScreen.js:195-198,431-460` offers only Retry for failed images. A permanent 400/413 keeps retrying the same attachment; only failed text has an Edit/discard path. |

## Additional Backend Findings

| Priority | Problem | Verification |
| --- | --- | --- |
| High, conditional | Null/empty stored credentials fail open | `auth.guard.ts:65-69` checks the password only when `phone` is truthy. A deliberately seeded local legacy record authenticated with an unrelated password, HTTP 200. Current normal registration supplies nonempty credentials, so prevalence in existing deployments is unknown. |
| High, bot mode only | FactBot is impersonable and can be preclaimed | `bot/bot.service.ts:6,40-55` uses a fixed source-visible credential and adopts an existing account with that name. `auth.guard.ts` treats it as a regular user. Source-confirmed; bot mode was not enabled during the main local audit. |
| Medium | Remote error/redirect bodies escape download bounds | `common/remote-fetch.util.ts:113-129,204-210` clears the header timer and drains error/redirect bodies without the body deadline/size guard. A network-free fixture showed an open stream accepting 1,024 bytes despite a one-byte limit and remaining undestroyed after the deadline. Resource-exhaustion magnitude was not load-tested. |
| Medium | Standard Basic Auth/Swagger authorization does not match the guard | `auth.guard.ts:28-45` expects raw `username:password`; `main.ts:36-43` advertises standard HTTP Basic. A standard base64 Basic header returned 401 locally. The existing app intentionally uses the raw contract. |
| Medium | Foreign-conversation cursors are accepted | `message.service.ts:38-46` validates only global message existence. Supplying another conversation's cursor returned HTTP 200 with zero messages for a history containing 25. |
| Low | Malformed images and blank messages are accepted | Invalid legacy `imageInfo` returned 201; an eight-byte PNG signature was stored as an IMAGE; whitespace-only text returned 201. Evidence: `message.service.ts:65-99`, `common/base64.util.ts:53-68`, `file/file.service.ts:88-108`. |
| Low | Uppercase ObjectIds break participant normalization | `conversation.service.ts:43-67,89-94` deduplicates/matches strings before canonicalization. A valid uppercase caller ID plus one recipient created a GROUP with three participant entries but only two distinct users. |
| Low | Some error/continuation responses are misleading | A malformed redirect target produced an unmapped `TypeError`, not a client HTTP error (`remote-fetch.util.ts:116-122`). Exactly 20 final messages also advertise another cursor (`message.service.ts:54`), producing an unnecessary empty page. |
| Low | Private content and control characters reach logs | `message.service.ts:138-158` logs message text and participant names without escaping message controls. This creates another retained copy of chat data and allows misleading multiline/terminal-control logs. Source-confirmed. |

Additional failure scenarios need fault-injection/boundary validation: conversation insertion can succeed before user-link updates fail (`conversation.service.ts:96-115`); message insertion can succeed before follow-up reads fail (`message.service.ts:115-132`), making a failed response ambiguous. With `MAX_UPLOAD_MB=15`, the global JSON limit exceeds MongoDB's 16 MiB document limit, but message strings have no per-field cap. These are conditional risks, not observed outages during ordinary use.

## Missing Functionality And Engineering Work

These are implementation gaps or product decisions, not all necessarily required for a small classroom demo.

- Read/delivery acknowledgement, unread counts, last-message previews, and last-message activity ordering. Chat rows currently show conversation creation metadata and generic descriptions.
- Real-time/background notification delivery, typing/presence, and push notifications. Current updates rely on polling.
- Generic attachment UI. The backend can return FILE/PDF/document messages, but the screen treats any `fileId` as an image and has no proper filename/open/download flow (`ChatRoomScreen.js:55-65,368-383`).
- Group rename/leave/add/remove-members flows; message edit/delete; account deletion; password reset/change; editable profiles. Corresponding backend management endpoints are absent.
- Functionality behind visible Edit, microphone, chat-details, and profile-chevron controls. Several render without an action (`ChatListScreen.js:161-163`, `ChatRoomScreen.js:124-145,617-619`, `SettingsScreen.js:68-86`).
- Durable session/server/draft/outbox recovery and warnings before discarding unsent work. The current session-only outbox is documented, so persistence is an enhancement decision, not an accidental storage regression.
- Server-side message idempotency. The UI appropriately warns about uncertain delivery and avoids automatic POST retries, but a lost successful response followed by manual retry can still duplicate a message.
- Rate limits, registration/upload quotas, file deletion, orphan-upload cleanup, retention policies, and private-log retention controls. Individual upload size limits do not bound aggregate storage.
- Message/conversation/file hot-query indexes and bounded user/conversation listing. The initialized local message collection had only `_id_`; its conversation-history query used SORT plus COLLSCAN. Large-data performance was not benchmarked.
- Bot opt-in/opt-out and bounded traffic. One bot currently sends to every non-bot account every 10 seconds, nominally 8,640 messages per account per day; slow asynchronous ticks can overlap.
- Backend automated tests and linting, committed UI/end-to-end tests, security/authorization regression tests, and CI. The root lint/typecheck excludes the backend, and current 21 frontend tests do not cover its security or the React screen/context flows.
- Defined Node/runtime versions and a reproducible end-to-end setup/deployment workflow. Expo SDK 58 requires a compatible Node version; this audit used Node 26.12.1 and npm 11.20.0.
- Release configuration: real app identifiers, build profiles, signing/project setup, HTTPS deployment, health checks, backups, and error monitoring. Native introspection used placeholder app IDs; no EAS/native release build was performed.
- Corrected API/setup documentation. `README_API.md:60-65` documents `recipient_id`, but the included backend rejects it with 400 and expects `participants_ids`. Bot documentation describes five random bots, while source implements one cycling FactBot. The non-Docker instructions also do not start the required replica-set database.

## Native-Only Verification Still Needed

- Android keyboard avoidance: `AuthScreen.js:43-45` and `ChatRoomScreen.js:473-476` provide behavior only on iOS. Current Expo guidance requires keyboard handling for Android edge-to-edge layouts. Check the real composer, multiline input, and send button with the IME open.
- Native list search: lists omit `keyboardShouldPersistTaps`, so a first result tap can dismiss the keyboard instead of selecting the row (`NewChatScreen.js:249-286`, `ChatListScreen.js:236-250`).
- Android release networking: native introspection did not show an explicit cleartext exception, while default server URLs use HTTP. Expo's matching build-properties docs state Android 9+ defaults to disallowing cleartext. Validate a release/development binary rather than treating Expo Go/debug behavior as proof.
- Tab-bar safe areas on Android gesture/three-button navigation, iOS tablets, and larger bottom insets (`src/navigation/Tabnavigator.js:19-26,55-62`).
- Image-picker activity-destruction/cancellation recovery and photo limits on actual devices (`ChatRoomScreen.js:242-310`).

Native API assessment used matching Expo SDK 58 documentation. No general picker MIME failure was found: the backend corrects raster MIME from bytes. Browser mobile viewports and successful native JS exports are not native-device tests.

## Positive Controls And Limits

- Missing authorization on file downloads returned 401; an authenticated user outside a file's sharing conversation returned 403.
- Loopback remote-upload URLs were rejected with 400. No reachable private-address SSRF bypass was established; the confirmed remote-fetch issues concern cleanup/error handling.
- The outbox tests confirm immediate pending messages, no automatic POST retries, duplicate-tap protection, failed upload retention, reuse of uploaded IDs, and prevention of a post-upload send after session rotation.
- Existing appearance utility tests passed, including contrast checks. Initial mobile/desktop browser startup was clean.
- Photo fixtures were uploaded through the real API. Native/gallery picker interaction and the optimistic local-photo-preview lifecycle were not manually verified.
- No real/campus accounts or messages were used, and no production load test was performed. This is a prioritized audit, not proof that every possible bug has been discovered.
- This downloaded checkout has no Git metadata, so repository history, working-tree diffs, and remote CI results could not be inspected.

## Suggested Decision Order

1. Address conversation privacy, DM cardinality/exact matching, credentials/transport, and database provisioning before using real private data.
2. Resolve SDK/native dependency compatibility, web routing/export/CORS, authenticated web images, and authentication/server-switch state.
3. Address history loading, DM labels, concurrency, receipts, outage behavior, and actionable error/retry handling, with regression tests.
4. Choose desired product features and release/performance hardening, then perform rebuilt iOS/Android device verification.

No items above have been implemented as fixes during this audit.

## Final Local State

- Removed only the generated audit fixtures: 30 test account records, 18 conversations, 85 messages, and 6 files across the development and separate audit databases. No audit accounts remain.
- Stopped the Expo web server, compiled API server, and disposable production API container. Verified that ports 3000, 3001, and 8081 no longer have listeners.
- The prepared local MongoDB replica set remains healthy and running as `chatapp_mongo`, bound only to `127.0.0.1:27017`. The development schema/index setup and ignored, owner-only `backend/.env` remain available.
- To resume local development, run `npm run start:dev` from `backend/` and `npm start` from the project root. Use a local server preset appropriate to the device/emulator. The unresolved compatibility, CORS, and application defects described above still apply.

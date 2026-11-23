# Submission Fix Plan

Date: 2026-11-21
Status: Required local MVP source/configuration fixes and handover are complete. Frontend58, backend43, realHTTP15 and production-browser8 regression checks pass, as do SDK20/20, compilation and all-platform exports. Native iOS Expo Go exercised the main flows and verified the corrected preview-close centre tap. Software-keyboard overlap, Android execution and standalone signed artifacts remain unverified; hosting, cloud builds, signing, commits and pushes require separate authorization.
Basis: [PROJECT_AUDIT.md](PROJECT_AUDIT.md).

## Goal And Scope

Deliver a credible academic project: a reproducibly runnable, tested chat app with private DMs/groups, text and photo messaging, accessible history, clear error handling, and an honest demonstration of supported features.

Assume submission means source code, setup instructions, screenshots/demo recording, and a runnable app. An Android APK is included if the rubric requires an installable artifact. App Store/Play Store publication is not part of the default scope.

Before implementation, confirm the deadline, required platforms, grading rubric, and whether the included backend or the campus server must be used. The proposal below assumes we may fix and demonstrate the included backend. Client changes cannot repair security defects in a campus server we do not control.

## Implementation Rules

- Preserve the current visual design and reuse existing screens, theme, API layer, and outbox. Do not rewrite the app or replace MongoDB/NestJS.
- Stay on Expo SDK 58 and use its matching documentation and SDK-compatible package installation. Do not perform a major SDK upgrade or run `npm audit fix --force`.
- Preserve the documented raw `Authorization: Basic username:password` contract where required by the course. Correct server-side credential storage and documentation without silently breaking external API compatibility. A JWT/auth-provider rewrite is not required for this submission.
- Use disposable local test accounts and isolated databases. Do not contact or alter the campus service without authorization.
- Back up any existing non-test data before schema changes. Do not automatically erase accounts, merge different identities, discard chat histories, or remove database volumes.
- Add regression tests with each fix, not only at the end. Retain the existing 21 passing tests and the outbox behavior they protect.
- Cloud builds, hosting, signing, Git commits, and pushes require separate authorization. This planning step changes only this document.

## Phase 1: Reproducible Foundation

Priority: Required. Establish a reliable baseline before changing application behavior.

Main files: `package.json`, lockfiles, `app.json`, `backend/package.json`, `backend/Dockerfile`, `backend/docker-compose.yml`, environment examples, and verification scripts.

1. Select and pin a supported Node LTS version satisfying Expo 58's Node 22.13 minimum. Align developer instructions, backend Docker runtime, and CI; replace the old Node 20 image.
2. Resolve the 13 SDK package mismatches using Expo's compatible versions. Deduplicate `react-native-screens` and remove unused direct navigation dependencies only after the Router migration confirms they are unnecessary.
3. Review dependency advisories and apply compatible patches. Resolve reachable critical/high runtime risks; document any demonstrably unreachable tooling/transitive exceptions instead of hiding them or forcing incompatible upgrades.
4. Add backend lint, typecheck, unit-test, and HTTP integration-test commands. Keep the existing frontend Node tests; add focused React/browser tests for authentication, routing, and error states.
5. Provide a repeatable MongoDB replica-set setup and an explicit, lockfile-pinned Prisma provisioning job. Apply schema/index changes before the API is reported ready. Use MongoDB schema push/provisioning, not SQL migration commands.
6. Verify required indexes explicitly. Ensure the provisioning job has the pinned Prisma CLI available rather than downloading an arbitrary version in the production container.
7. Add a non-sensitive health endpoint and clear configuration validation. Keep MongoDB private; make test Compose projects/ports isolated so they do not interfere with the existing local database.

Acceptance gate: clean installs work from the lockfiles, Expo compatibility/deduplication checks pass, backend checks run independently, and a fresh Docker database receives its required indexes before accepting requests. Repeating provisioning must not destroy data.

## Phase 2: Privacy And Backend Security

Priority: Required. Do not use real private data until this gate passes.

Main files: `backend/src/auth/`, `backend/src/conversation/`, `backend/src/message/`, `backend/src/file/`, `backend/src/common/`, `backend/src/main.ts`, and `backend/prisma/schema.prisma`.

1. Pass the authenticated caller into message reads and verify conversation membership before returning text, inline images, attachment metadata, or accepting a send. Keep file ownership/download checks intact and authorize before loading large blobs.
2. Normalize ObjectIds before participant deduplication. Require exactly two distinct users for a DM, including its caller. An existing-DM lookup must match that exact pair, never a superset.
3. Enforce DM uniqueness in the database. Proposed minimal schema: a unique `conversationKey`, using `dm:<sorted user IDs>` for DMs and a fresh `group:<UUID>` for groups. This avoids the nullable-unique-index trap that would prevent multiple groups.
4. Handle concurrent create collisions by retrieving the exact existing DM. Make conversation insertion and required user-link updates transactional on the replica set. Identify existing poisoned/duplicate conversations in a reviewed migration rather than silently deleting or merging them.
5. Replace plaintext password storage in `User.phone` with salted password hashes, using a suitable implementation such as Node's built-in scrypt. Fail closed for missing/empty credentials. Migrate owned legacy data only through a reviewed process; never retain an unrestricted plaintext fallback.
6. Make concurrent first-use registration safe: reload and verify the winning account after a unique collision. Equal credentials should authenticate consistently; different credentials must not create another account or gain access.
7. Correct Swagger's authentication description to match the actual course contract. Require HTTPS for any shared/private-data deployment. HTTP is restricted to explicitly identified local development with test credentials; remove unsupported secure-sync claims.
8. Configure CORS for explicitly allowed web origins, methods, and headers, including successful OPTIONS preflight. CORS is not a substitute for backend authorization.
9. Reject blank/oversized text, blank filenames, malformed base64, and truncated/non-decodable images. Bound legacy inline images and total message size below MongoDB's document limit, even if upload configuration changes.
10. Close remote error/redirect response streams, keep deadline/size bounds effective, and map malformed redirects to controlled client errors. Preserve existing SSRF address/DNS/redirect protections.
11. Stop logging private message bodies, raw credentials, and unescaped user-controlled terminal content. Add practical request/upload limits for the single-instance demo.
12. Keep bot mode off by default. Prevent human login/preclaiming of reserved bot identities and remove fixed usable bot credentials. Do not enable bot mode in the submission unless its identity, concurrency, and traffic controls are tested.

Acceptance gate: outsider read/write attempts are rejected; three-person DMs are rejected; eight parallel DM creates produce one conversation; eight identical first-login requests produce one account without 500s; wrong/missing passwords fail; passwords are not stored verbatim; invalid input and remote-fetch failures are bounded and handled.

## Phase 3: Routing, Sessions, And Private Photos

Priority: Required. Fix cross-platform integration and identity isolation.

Main files: `App.js`, `index.js`, `app.json`, new route files under `src/app/`, `src/context/AuthContext`, `src/context/MessageOutboxContext`, `src/api/`, `AuthScreen`, `SettingsScreen`, and `ChatRoomScreen`.

1. Migrate the existing navigation shell to Expo Router, as required by the repository. Keep UI components outside `src/app/`; add thin sign-in, chats/settings, new-chat, and `chat/[conversationId]` routes. Use SDK 58 Router entry points, not application imports from `@react-navigation/*`.
2. Place existing providers in the root layout with stable lifetimes. Protect private routes, retain pre-login server selection, and keep backend authorization authoritative. Load chat metadata by conversation ID instead of trusting stale navigation parameters.
3. Use client-rendered SPA web output suitable for authenticated dynamic routes, rather than trying to prerender private conversations. Verify a real HTML entry, browser refresh/deep links, and host fallback configuration.
4. Treat a server/account change as a new session. Cancel requests, clear the old identity and scoped caches/outbox, and require reauthentication before sending credentials to a different host. Warn before discarding unsent work.
5. Add session-generation/abort handling to login, including its success, failure, and final loading updates. A late response must not undo logout, overwrite a new session, or stop a newer login's loading indicator.
6. Scope queries and private-media caches to the session/server/account. Validate successful profile/API response shapes so a 200 HTML/error page cannot become an authenticated user.
7. Persist the non-secret chosen server URL and initialize sign-in from it. Test the edited URL without changing global configuration or silently sending existing credentials to an unapproved host. Do not store passwords in AsyncStorage or browser localStorage.
8. For web photos, fetch the protected image through the authenticated API and render a bounded blob URL, with abort/revoke/cache cleanup on unmount and session changes. Keep a working authenticated native image path. Do not make files public or put passwords in image URLs.

Acceptance gate: real browser login works without a CORS shim; stored incoming/outgoing photos load after reopening; switching between two servers with different account IDs requires a fresh login and displays the new identity; no old-session data appears; logout defeats delayed responses; production web export has a usable HTML entry.

## Phase 4: Correct Chat Behavior

Priority: Required for the demonstrated chat features.

Main files: `src/api/hooks.ts`, `src/api/types.ts`, `src/utils/messageOutbox.ts`, `ChatRoomScreen`, `ChatListScreen`, `NewChatScreen`, and backend message/conversation services and DTOs.

1. Implement older-history loading. Poll the newest page while retaining loaded history; merge/deduplicate by server ID and preserve scroll position. Do not refetch the entire history every few seconds or drop older rows when a new message arrives.
2. Make backend pagination deterministic with creation time plus ID, bind cursors to their conversation, and fetch an extra row to determine whether another page truly exists.
3. Derive DM titles from the other participant, not the shared stored recipient name. Use actual participant counts, including when reopening existing chats.
4. Preserve cached conversations on refetch failures and display a non-blocking offline/error banner. Make new-chat errors visible on every platform using in-app feedback, not only `Alert.alert`.
5. Add Retry, Remove, and reselect/edit options for permanently failed photo sends. Preserve captions and successful upload IDs. Keep the current no-automatic-POST-retry and old-session-send protections.
6. Add idempotent sends for the included backend: a client-generated send identifier scoped to sender/conversation, enforced by a unique database key. Repeating the same send must return the same committed message; key reuse with different content must be rejected. Provide unique defaults for legacy/internal writes, not a nullable unique field.
7. Implement caller-only delivery/read acknowledgement. Delivery means successful retrieval; read means an active, visible chat, not background polling. Batch acknowledgements and make them idempotent. Never let one user mark another user's receipt.
8. Show useful last-message/activity metadata and honest message status. Add unread indicators if supported by the agreed backend contract; do not show fake read receipts on a server without acknowledgements.
9. Treat non-image attachments explicitly as file/unsupported-file cards, not broken images. Full document picking/sharing is optional unless required by the rubric.

New idempotency/acknowledgement/summary fields and endpoints apply to the included backend. Do not send them to a campus API until its support is confirmed; preserve its required payload format and document any external-server limitations.

Acceptance gate: 100-message and same-timestamp histories load without skips/duplicates; a lost successful response followed by retry creates one message; receipts change only for the correct recipient; failed photos are removable; offline cached chats remain accessible; recipients see the correct DM counterpart.

## Phase 5: Native UX And Submission Polish

Priority: Required for the platforms being submitted.

1. Fix keyboard avoidance on both Android and iOS using SDK 58 guidance. Verify multiline composer/send controls with the keyboard open and avoid double adjustment with tab/header insets.
2. Make the first contact/chat tap work while the search keyboard is visible. Correct bottom safe areas on gesture/three-button navigation and smaller displays.
3. Test gallery permission denial, cancellation, large photos, app background/resume, and server/network failures. Recover cleanly rather than leaving a permanent spinner or losing a caption.
4. Remove or clearly disable unfinished Edit, microphone, chat-details, and profile controls. Do not add voice/call/profile-management features just to fill placeholder buttons.
5. Keep existing light/dark/system appearance and verify persistence. Preserve the current visual language; fix misleading labels, clipping, and empty/error states rather than redesigning the app.
6. Set project-appropriate names, app IDs, icons, and build configuration. Keep cleartext exceptions development-scoped; an installable shared build must use an approved reachable HTTPS API, not a phone's `localhost` or an arbitrary insecure default.

Acceptance gate: the actual submitted native build works on at least one Android device/emulator; iOS is verified if required. A small browser viewport is not counted as native verification. All visible controls either work or clearly explain their limitation.

## Phase 6: Verification And Handover

Priority: Required. Submission readiness is demonstrated by evidence, not assumed from a successful bundle command.

1. Run all frontend tests/lint/typechecks plus independent backend lint/typechecks/unit/integration tests. Add a CI or reproducible local verification workflow with an isolated test replica set.
2. Repeat clean-install and fresh-database Docker startup, checking indexes and registration/DM concurrency. Preserve ordinary data volumes; only reset explicitly disposable test environments.
3. Run browser acceptance against the actual API with no CORS shim, synthetic HTML shell, or intercepted preflight. Keep fault injection separate and clearly labeled for failure tests.
4. Export and serve the production web artifact; test sign-in, direct chat links, refresh, images, and two-user messaging. Run native-device tests on the intended final build, not only Expo Go or exported JavaScript.
5. If an APK is required, configure an internal/preview APK profile in `eas.json` and build through EAS/Expo Build after account/build authorization. For this npm project the command is `npx eas-cli@latest build --platform android --profile preview`. Store publication and iOS signing are separate scope decisions.
6. Update setup/API documentation to match the implemented payloads, authentication, database initialization, server choices, polling/receipt behavior, and actual bot features. Include troubleshooting and known limitations.
7. Provide a deterministic test-data seed for two ordinary demo accounts and one group. Use only clearly labeled test credentials and keep the demonstration independent of unreliable campus access where the rubric permits.
8. Prepare the submission archive/repository, screenshots, short demo recording, test/build results, and artifact link if required. Exclude `.env`, real passwords, signing credentials, database data, `node_modules`, and caches.

Acceptance gate: another person can follow the instructions from a fresh checkout, run the backend and app, reproduce the demonstrated features, and understand remaining limitations without undocumented setup steps.

## Regression Checklist

- [ ] Outsider message reads/writes and file downloads are denied; multi-party DM poisoning is rejected.
- [ ] User/DM concurrency creates one correct record; missing/wrong credentials never authenticate.
- [ ] Passwords are hashed; a shared build uses HTTPS; no private message content or credentials appear in logs.
- [ ] Real web preflight/login and authenticated photo loading work without test bypasses.
- [ ] Server switching, delayed login, logout, and cache/media isolation are correct.
- [ ] More than 20 messages, exact-page boundaries, equal timestamps, and foreign cursors behave correctly.
- [ ] Lost-response retries do not duplicate messages; upload failure retains usable Retry/Remove actions.
- [ ] Receipts are accurate; cached chats survive outages; DM names identify the other person.
- [ ] Empty/oversized input, malformed images/redirects, and private-address remote URLs are handled safely.
- [ ] Native keyboard, safe areas, search taps, permissions, and app resume are verified on the submitted platform.
- [ ] Fresh database provisioning, compatible dependencies, production HTML export, and required build artifacts pass.
- [ ] Instructions, demo evidence, known limitations, and a secret-free handover package are complete.

## Deferred Unless Required By The Rubric

- WebSockets, push notifications, presence, and typing indicators. Document existing polling instead of claiming these features.
- Voice notes/calls, complete document-picker/sharing support, and broad profile editing.
- Advanced group administration, message edit/delete, password recovery, account deletion, and full durable offline outbox recovery.
- Automatic login persistence. Reauthentication is acceptable for the baseline; do not implement it by storing plaintext passwords.
- Production-scale storage retention/orphan-cleanup automation, multi-instance rate limiting, advanced monitoring, and public store submission. Keep basic bounds and privacy safeguards in the required work.

## Recommended Work Order

Run Phases 1 and 2 first, then complete the end-to-end login/text/photo path in Phase 3. Finish chat reliability in Phase 4, verify native UX in Phase 5, and reserve a separate Phase 6 for clean-room testing and handover. Do not spend the submission buffer adding optional features.

The exact schedule depends on the rubric, deadline, available devices, backend authority, and any cloud-build access. No delivery date is promised before those constraints are established. Any required feature from the rubric overrides the deferred list.

## Reference Documentation

- Expo SDK 58: https://docs.expo.dev/versions/v58.0.0/
- Router migration: https://docs.expo.dev/router/migrate/from-react-navigation.md
- Protected routes: https://docs.expo.dev/router/advanced/protected.md
- Web output/static-rendering constraints: https://docs.expo.dev/router/web/static-rendering.md
- Keyboard handling: https://docs.expo.dev/guides/keyboard-handling.md
- Android APK builds: https://docs.expo.dev/build-reference/apk.md

No application code, dependency versions, database schema, or services were changed while drafting this plan.

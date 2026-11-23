# Included Backend API

For setup and verification, use [README.md](README.md). The included local server's live specification is `/docs`, with OpenAPI JSON at `/docs-json`. This document does not assert that the separate campus service supports the same extensions.

## Authentication

Protected endpoints retain the course's literal header:

```http
Authorization: Basic username:password
```

This is not standard base64 HTTP Basic. Swagger uses an Authorization header input rather than advertising incompatible encoding. A first authenticated request registers an unused valid handle; an existing handle requires its password. The server stores salted scrypt hashes, not passwords in `User.phone`. Profile responses omit credential fields.

Use test accounts for explicitly enabled local HTTP development. Production requires trusted HTTPS termination and configured proxy trust; local HTTP opt-in is forbidden in production. Public `/health` and OPTIONS preflight never register users, even if an Authorization header is supplied.

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | Public database readiness, API version and supported capability flags; no secrets. |
| GET | `/user` | Authenticated user directory, safe profile fields only. |
| GET | `/user/profile` | Caller profile, or supported `user_id` lookup. |
| GET | `/conversation` | Caller-only conversations, activity summaries and unread counts. |
| GET | `/conversation/:id` | Caller membership required, fresh route metadata. |
| POST | `/conversation` | Exact two-user DM or named group; database-enforced DM identity and safe concurrency. |
| GET | `/message` | Authorized room's older-history pages; stable time/ID ordering and room-bound cursor. |
| POST | `/message` | Authorized send; optional caller-scoped idempotent client identifier. |
| POST | `/message/acknowledge` | Batched delivery/read update for the caller only. |
| POST | `/file` | Validated bounded JSON base64 or public remote URL upload. |
| GET | `/file/:id` | Authorized metadata/base64 contents. |
| GET | `/file/:id/download` | Authorized binary download; private images are not public URLs. |

### Conversations

```json
{ "type": "DM", "participants_ids": ["<recipient ObjectId>"] }
```

The included API also retains the legacy `recipient_id` alias where unambiguous. Exactly two distinct users are required after caller addition/normalization; multi-party DMs are rejected. Group conversations use:

```json
{ "type": "GROUP", "name": "Study Group", "participants_ids": ["<recipient ObjectId>"] }
```

Responses keep `id`, `name`, `type`, `createdAt`, `createdBy`, and `participants_ids`, with optional `lastMessageAt`, `lastMessagePreview`, and `unreadCount`. Clients derive a DM's title from its other participant, never the shared stored name.

### Messages And Pagination

```json
{
  "conversation_id": "<conversation ObjectId>",
  "content": "Hello",
  "client_message_id": "<UUID for this logical send>"
}
```

`client_message_id` is optional for compatibility. Included clients generate it once and preserve it across retries. Its unique key is scoped to sender/conversation; repeating the same content/image/file returns the committed message, while conflicting reuse returns 409. Legacy/internal sends without a key receive unique defaults and cannot gain automatic retry deduplication.

`GET /message?conversation_id=<id>&from_message_cursor=<id>` returns `{data,nextCursor,count}`. Each page is oldest-first within the newest-first page traversal. Follow `nextCursor` to load earlier history; the cursor must belong to that room. A full final page has no false continuation cursor.

Response fields retain `id`, `content`, `createdAt`, `senderId`, `conversationId`, `status`, `type`, `imageInfo`, `fileId`, and `file` as applicable, plus `clientMessageId` for keyed sends. File metadata never embeds the binary blob in message lists.

### Delivery And Read Receipts

```json
{
  "conversation_id": "<conversation ObjectId>",
  "message_ids": ["<message ObjectId>"],
  "status": "read"
}
```

Use `delivered` or `read`, at most 100 IDs. Read implies delivered. Only the authenticated recipient's flags can change; foreign-room IDs and receipt impersonation are rejected. Repetition is idempotent. Fetching/prefetching alone does not mark read: the client acknowledges an active, visible chat.

### Photos And Files

```json
{ "file_name": "photo.png", "mime_type": "image/png", "data": "<base64>" }
```

Alternatively, submit `{ "url": "https://<public image URL>" }`, never both sources. Private/loopback/link-local destinations and redirects are blocked. Error/redirect streams are closed and byte/time bounds enforced. Raster images must actually decode within configured byte/pixel limits; header-only fake images are rejected. Unsupported codecs receive a controlled error. JPEG/PNG are the portable photo path.

Upload response includes `id`, `name`, `mimeType`, `size`, `kind`, `uploadedBy`, `createdAt`, and a relative `downloadUrl`. Send the owned file with:

```json
{ "conversation_id": "<room ObjectId>", "file_id": "<file ObjectId>", "content": "Optional caption" }
```

File access requires uploader ownership or membership in a conversation that shares it. Sending also requires membership and uploader ownership. Legacy valid `imageInfo` remains supported with separate size/format bounds.

Web images use an authenticated fetch and bounded/revoked blob URL, not ineffective `Image.source.headers` or password query parameters. Native images use supported authenticated sources. Generic non-image attachments get an explicit file/unsupported UI instead of a broken photo.

## External Legacy Mode

Choose **External / campus legacy** only for a known compatible service. The client skips included-only health/capability assumptions, retains the original raw-auth/text/inline-photo payloads, and suppresses unsupported idempotency/file/receipt extensions. External availability, security, payload differences, and HTTPS support must be verified separately with authorization.

The outbox has no automatic message/upload POST retries. It remains session-local; server/account changes clear identity and work after the appropriate warning. Images, history GETs and cached chats have bounded recovery, while permanent send failures expose explicit corrective actions.

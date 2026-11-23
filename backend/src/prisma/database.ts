import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalDmKey, cleanContent, cleanFileName, cleanName, isReservedBotName, MAX_PARTICIPANTS } from '../common/input.util';
import { hashPassword } from '../auth/password';
import { messagePreview, receipts } from '../message/summary';
import { decodeBase64 } from '../common/base64.util';
import { validateRasterImage } from '../common/image.util';

type Client = Pick<Prisma.TransactionClient, 'user' | 'conversation' | 'message' | 'file' | '$runCommandRaw'>;
type Raw = Record<string, any>;
export type DatabaseSnapshot = { users: Raw[]; conversations: Raw[]; messages: Raw[]; files: Raw[] };
export const SCHEMA_VERSION = 2;
export const REQUIRED_INDEXES = {
  users: [{ name: 'users_name_unique', key: { name: 1 }, unique: true }],
  conversations: [
    { name: 'conversation_key_unique', key: { conversationKey: 1 }, unique: true },
    { name: 'conversation_participants_activity', key: { userIds: 1, activityAt: 1, _id: 1 } },
  ],
  messages: [
    { name: 'message_send_key_unique', key: { sendKey: 1 }, unique: true },
    { name: 'message_conversation_time_id', key: { conversationId: 1, createdAt: 1, _id: 1 } },
    { name: 'message_file_conversation', key: { fileId: 1, conversationId: 1 } },
  ],
  files: [{ name: 'file_owner_time', key: { uploadedBy: 1, createdAt: 1 } }],
} as const;

export class DatabaseSafetyError extends Error {}

export function rawId(value: any): string | null {
  const id = value?.$oid ?? value;
  return typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id) ? id.toLowerCase() : null;
}

function rawDate(value: any): Date | null {
  const raw = value?.$date;
  if (raw === undefined) return null;
  const date = new Date(typeof raw === 'object' ? Number(raw?.$numberLong) : raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

function records(value: unknown): Raw[] {
  if (!Array.isArray(value)) throw new DatabaseSafetyError('Unexpected raw database response');
  if (value.length > 100_000) throw new DatabaseSafetyError('Inspection is bounded to 100000 records per collection; use an offline reviewed batch process');
  return value;
}

const isString = (field: string) => ({ $eq: [{ $type: `$${field}` }, 'string'] });
const stringBytes = (field: string) => ({ $cond: [isString(field), { $strLenBytes: `$${field}` }, 0] });
const present = (field: string) => ({ $ne: [{ $type: `$${field}` }, 'missing'] });

/** Projection avoids Prisma required-field decoding and never returns credential values or blobs. */
export async function loadDatabaseSnapshot(client: Client): Promise<DatabaseSnapshot> {
  const [users, conversations, messages, files] = await Promise.all([
    client.user.aggregateRaw({ pipeline: [{ $project: {
      _id: 1, name: 1, isBot: 1, conversationIds: 1,
      hasHash: { $regexMatch: {
        input: { $cond: [isString('passwordHash'), '$passwordHash', ''] },
        regex: '^scrypt\\$v1\\$16384\\$8\\$1\\$[0-9a-f]{32}\\$[0-9a-f]{128}$',
      } },
      hasPhone: { $ne: [{ $ifNull: ['$phone', null] }, null] },
      hasLegacyPassword: { $and: [isString('phone'), { $ne: [{ $ifNull: ['$phone', ''] }, ''] }] },
    } }, { $limit: 100001 }] }),
    client.conversation.aggregateRaw({ pipeline: [{ $project: {
      _id: 1, name: 1, type: 1, userIds: 1, createdBy: 1, createdAt: 1, conversationKey: 1,
      activityAt: 1, unreadCounts: 1, lastMessageAt: 1, lastMessageId: 1,
      hasLastMessagePreview: present('lastMessagePreview'),
    } }, { $limit: 100001 }] }),
    client.message.aggregateRaw({ pipeline: [{ $project: {
      _id: 1, conversationId: 1, senderId: 1, createdAt: 1, status: 1, fileId: 1,
      sendKey: 1, clientMessageId: 1, contentBytes: stringBytes('content'), imageBytes: stringBytes('imageInfo'),
      contentType: { $type: '$content' }, imageType: { $type: '$imageInfo' }, docBytes: { $bsonSize: '$$ROOT' },
    } }, { $limit: 100001 }] }),
    client.file.aggregateRaw({ pipeline: [{ $project: {
      _id: 1, uploadedBy: 1, size: 1, name: 1, kind: 1, mimeType: 1,
      dataBytes: { $cond: [{ $eq: [{ $type: '$data' }, 'binData'] }, { $binarySize: '$data' }, -1] },
      docBytes: { $bsonSize: '$$ROOT' },
    } }, { $limit: 100001 }] }),
  ]);
  return { users: records(users), conversations: records(conversations), messages: records(messages), files: records(files) };
}

export function analyzeDatabase(snapshot: DatabaseSnapshot, approvedBots: string[] = []) {
  const conflicts: Array<{ kind: string; ids: string[] }> = [];
  const issue = (kind: string, ids: Array<string | null>) => conflicts.push({ kind, ids: ids.map((id) => id ?? '(invalid id)') });
  const users = new Map(snapshot.users.map((user) => [rawId(user._id), user]));
  const conversations = new Map(snapshot.conversations.map((conversation) => [rawId(conversation._id), conversation]));
  const files = new Set(snapshot.files.map((file) => rawId(file._id)));
  const names = new Map<string, string[]>();
  const dmPairs = new Map<string, string[]>();
  const keys = new Map<string, string[]>();
  const sendKeys = new Map<string, string[]>();
  const legacy = { plaintextPasswords: 0, missingCredentials: 0, missingConversationKeys: 0, missingSendKeys: 0, invalidSummariesOrReceipts: 0 };
  let defaults = 0;
  for (const user of snapshot.users) {
    const id = rawId(user._id);
    if (!id) issue('invalidUserId', [id]);
    try { if (cleanName(user.name) !== user.name) issue('invalidUsername', [id]); } catch { issue('invalidUsername', [id]); }
    if (typeof user.name === 'string' && user.name.includes(':')) issue('invalidUsername', [id]);
    if (user.isBot !== undefined && typeof user.isBot !== 'boolean') issue('invalidUserDefaults', [id]);
    if (typeof user.name === 'string') names.set(user.name, [...(names.get(user.name) ?? []), id!]);
    const approvedBot = id && approvedBots.includes(id) && typeof user.name === 'string' && isReservedBotName(user.name);
    const reserved = typeof user.name === 'string' && isReservedBotName(user.name);
    if ((reserved && (user.isBot !== true || user.hasHash || user.hasPhone) && !approvedBot) ||
        (user.isBot === true && !reserved)) issue('reservedBotIdentity', [id]);
    if (user.hasPhone) legacy.plaintextPasswords++;
    if (!user.hasHash && user.isBot !== true && !approvedBot) legacy.missingCredentials++;
    if (user.conversationIds === undefined || user.isBot === undefined) defaults++;
    if (user.conversationIds !== undefined && (!Array.isArray(user.conversationIds) || user.conversationIds.some((value: any) => !rawId(value)))) {
      issue('invalidUserLinks', [id]);
    }
  }
  for (const ids of names.values()) if (ids.length > 1) issue('duplicateUsername', ids);
  for (const conversation of snapshot.conversations) {
    const id = rawId(conversation._id);
    const participantIds = Array.isArray(conversation.userIds) ? conversation.userIds.map(rawId) : [];
    if (!id || participantIds.length < 2 || participantIds.length > MAX_PARTICIPANTS || participantIds.some((value: string | null) => !value || !users.has(value)) ||
        new Set(participantIds).size !== participantIds.length || !participantIds.includes(rawId(conversation.createdBy)) || !rawDate(conversation.createdAt)) {
      issue('invalidConversationParticipantsOrMetadata', [id]);
    }
    if (conversation.name !== undefined && conversation.name !== null) {
      try { cleanName(conversation.name); } catch { issue('invalidConversationName', [id]); }
    }
    if (conversation.type === 'DM') {
      if (participantIds.length !== 2 || participantIds.some((value: string | null) => !value) || new Set(participantIds).size !== 2) {
        issue('poisonedDm', [id]);
      } else {
        const key = canonicalDmKey(participantIds);
        dmPairs.set(key, [...(dmPairs.get(key) ?? []), id!]);
        if (conversation.conversationKey && conversation.conversationKey !== key) issue('nonCanonicalDmKey', [id]);
      }
    } else if (conversation.type !== 'GROUP') issue('invalidConversationType', [id]);
    else if (conversation.conversationKey && !/^group:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversation.conversationKey)) {
      issue('invalidGroupKey', [id]);
    }
    if (!conversation.conversationKey) legacy.missingConversationKeys++;
    else keys.set(conversation.conversationKey, [...(keys.get(conversation.conversationKey) ?? []), id!]);
    if (!conversation.activityAt || !conversation.unreadCounts || conversation.lastMessageAt === undefined ||
        conversation.lastMessageId === undefined || !conversation.hasLastMessagePreview) defaults++;
    if ((conversation.activityAt !== undefined && !rawDate(conversation.activityAt)) ||
        (conversation.unreadCounts !== undefined && (!conversation.unreadCounts || typeof conversation.unreadCounts !== 'object' || Array.isArray(conversation.unreadCounts)))) {
      legacy.invalidSummariesOrReceipts++;
    }
  }
  for (const ids of dmPairs.values()) if (ids.length > 1) issue('duplicateDmPair', ids);
  for (const ids of keys.values()) if (ids.length > 1) issue('duplicateConversationKey', ids);
  for (const user of snapshot.users) for (const value of Array.isArray(user.conversationIds) ? user.conversationIds : []) {
    const conversation = conversations.get(rawId(value));
    if (!conversation || !conversation.userIds?.map(rawId).includes(rawId(user._id))) issue('invalidUserConversationLink', [rawId(user._id), rawId(value)]);
  }
  for (const message of snapshot.messages) {
    const id = rawId(message._id);
    const roomId = rawId(message.conversationId);
    const senderId = rawId(message.senderId);
    const conversation = conversations.get(roomId);
    if (!id || !conversation || !senderId || !users.has(senderId) || !conversation.userIds?.map(rawId).includes(senderId) || !rawDate(message.createdAt)) {
      issue('invalidMessageReferencesOrSender', [id]);
    }
    if (message.fileId !== undefined && message.fileId !== null && !files.has(rawId(message.fileId))) issue('missingAttachment', [id]);
    if (message.fileId && rawId(snapshot.files.find((file) => rawId(file._id) === rawId(message.fileId))?.uploadedBy) !== senderId) issue('attachmentOwnerMismatch', [id]);
    if (message.contentBytes > 16000 || message.imageBytes > Math.ceil(4 * 1024 * 1024 / 3) * 4 + 512 || message.docBytes > 8 * 1024 * 1024 ||
        !['missing', 'null', 'string'].includes(message.contentType) || !['missing', 'null', 'string'].includes(message.imageType)) {
      issue('oversizedOrInvalidLegacyMessage', [id]);
    }
    if (!message.sendKey) legacy.missingSendKeys++;
    else if (typeof message.sendKey !== 'string' || message.sendKey.length > 512) issue('invalidSendKey', [id]);
    else sendKeys.set(message.sendKey, [...(sendKeys.get(message.sendKey) ?? []), id!]);
    if (message.clientMessageId && message.sendKey !== `client:${senderId}:${roomId}:${message.clientMessageId}`) issue('invalidClientSendKey', [id]);
    const status = message.status;
    if (!status || typeof status !== 'object' || Array.isArray(status) || conversation?.userIds?.map(rawId).some((participant: string) =>
      typeof status[participant]?.delivered !== 'boolean' || typeof status[participant]?.read !== 'boolean' ||
      (status[participant].read && !status[participant].delivered))) legacy.invalidSummariesOrReceipts++;
  }
  for (const ids of sendKeys.values()) if (ids.length > 1) issue('duplicateSendKey', ids);
  for (const file of snapshot.files) {
    const id = rawId(file._id);
    if (!id || !users.has(rawId(file.uploadedBy)) || !Number.isInteger(file.size) || file.size <= 0 || file.size !== file.dataBytes || file.size > 15 * 1024 * 1024 || file.docBytes > 16 * 1024 * 1024 - 65536) {
      issue('invalidFileMetadataOrOwner', [id]);
    }
    try { cleanFileName(file.name); } catch { issue('invalidFilename', [id]); }
    if (!['IMAGE', 'FILE'].includes(file.kind) || typeof file.mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType)) issue('invalidFileType', [id]);
  }
  const normalizedSnapshot = Object.fromEntries(Object.entries(snapshot).map(([collection, rows]) =>
    [collection, [...rows].sort((a, b) => String(rawId(a._id)).localeCompare(String(rawId(b._id))))],
  ));
  const reviewToken = createHash('sha256').update(JSON.stringify({ snapshot: normalizedSnapshot, approvedBots: [...approvedBots].sort() })).digest('hex');
  return {
    counts: Object.fromEntries(Object.entries(snapshot).map(([key, rows]) => [key, rows.length])),
    legacy, defaultInitializations: defaults, conflicts, reviewToken,
  };
}

export async function inspectDatabase(client: Client) {
  return analyzeDatabase(await loadDatabaseSnapshot(client));
}

export async function assertReplicaSet(client: Client) {
  const hello = await client.$runCommandRaw({ hello: 1 }) as Raw;
  if (!hello.setName || hello.isWritablePrimary !== true) throw new DatabaseSafetyError('MongoDB must be a writable replica-set PRIMARY');
}

async function collectionIndexes(client: Client, collection: string): Promise<Raw[]> {
  try {
    const result = await client.$runCommandRaw({ listIndexes: collection, cursor: { batchSize: 1000 } }) as Raw;
    if (result.cursor?.id && Number(result.cursor.id?.$numberLong ?? result.cursor.id) !== 0) throw new DatabaseSafetyError('Unexpected index cursor');
    return result.cursor?.firstBatch ?? [];
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010' &&
        (error.meta?.code === '26' || error.meta?.code === 26 || /NamespaceNotFound|does not exist/.test(String(error.meta?.message)))) return [];
    throw error;
  }
}

function matchingIndex(indexes: Raw[], expected: { key: Raw; unique?: boolean }) {
  return indexes.some((index) => JSON.stringify(index.key) === JSON.stringify(expected.key) &&
    !!index.unique === !!expected.unique && !index.sparse && !index.partialFilterExpression && !index.collation);
}

export async function verifyIndexes(client: Client) {
  for (const [collection, required] of Object.entries(REQUIRED_INDEXES)) {
    const indexes = await collectionIndexes(client, collection);
    if (required.some((index) => !matchingIndex(indexes, index))) throw new DatabaseSafetyError(`Required indexes missing from ${collection}; run npm run db:provision`);
    if (indexes.some((index) => index.unique && JSON.stringify(index.key) !== JSON.stringify({ _id: 1 }) &&
      !required.some((expected) => JSON.stringify(expected.key) === JSON.stringify(index.key)))) {
      throw new DatabaseSafetyError(`Unexpected unique index in ${collection} requires review; provisioning never deletes indexes`);
    }
  }
}

export async function verifyDatabaseReady(client: Client) {
  await assertReplicaSet(client);
  await verifyIndexes(client);
  const result = await client.$runCommandRaw({ find: '_chatapp_meta', filter: { _id: 'schema' }, limit: 1, singleBatch: true }) as Raw;
  if (result.cursor?.firstBatch?.[0]?.version !== SCHEMA_VERSION) {
    throw new DatabaseSafetyError('Database defaults are not provisioned; run npm run db:inspect and db:provision');
  }
}

async function rawUpdate(client: Client, collection: string, id: string, data: Raw, extra: Raw = {}) {
  const result = await client.$runCommandRaw({ update: collection, updates: [{ q: { _id: { $oid: id }, ...extra }, u: { $set: data } }], ordered: true }) as Raw;
  return Number(result.n?.$numberLong ?? result.n);
}

async function validateStoredPayloads(client: Client, snapshot: DatabaseSnapshot) {
  for (let offset = 0; offset < snapshot.messages.length; offset += 100) {
    const rows = await client.message.findMany({
      where: { id: { in: snapshot.messages.slice(offset, offset + 100).map((message) => rawId(message._id)!) } },
      select: { id: true, content: true, imageInfo: true, fileId: true },
    });
    for (const message of rows) {
      try {
        const content = cleanContent(message.content);
        if (!content && !message.imageInfo && !message.fileId) throw new Error('empty message');
        if (message.imageInfo && !(await validateRasterImage(decodeBase64(message.imageInfo, 4 * 1024 * 1024).buffer))) throw new Error('not a raster');
      } catch { throw new DatabaseSafetyError('Invalid legacy message text or image requires review; no data was changed'); }
    }
  }
  for (const meta of snapshot.files.filter((file) => file.kind === 'IMAGE')) {
    const file = await client.file.findUnique({ where: { id: rawId(meta._id)! }, select: { data: true } });
    try {
      if (!file || !(await validateRasterImage(Buffer.from(file.data)))) throw new Error('not a raster');
    } catch { throw new DatabaseSafetyError('An invalid legacy raster file requires review; no data was changed'); }
  }
}

async function initializeDefaults(client: Client, snapshot: DatabaseSnapshot, forceSummaries = false) {
  const latest = new Map<string, Raw>();
  const counts = new Map<string, Record<string, number>>();
  const files = new Map(snapshot.files.map((file) => [rawId(file._id), file]));
  for (const conversation of snapshot.conversations) {
    counts.set(rawId(conversation._id)!, Object.fromEntries(conversation.userIds.map((id: any) => [rawId(id), 0])));
  }
  for (const message of snapshot.messages) {
    const roomId = rawId(message.conversationId)!;
    const previous = latest.get(roomId);
    if (!previous || rawDate(message.createdAt)! > rawDate(previous.createdAt)! ||
        (+rawDate(message.createdAt)! === +rawDate(previous.createdAt)! && rawId(message._id)! > rawId(previous._id)!)) latest.set(roomId, message);
    const receipt = receipts(message.status ?? {});
    const roomCounts = counts.get(roomId)!;
    for (const userId of Object.keys(roomCounts)) if (userId !== rawId(message.senderId) && !receipt[userId]?.read) roomCounts[userId]++;
  }
  const previews = records(await client.message.findRaw({
    filter: { _id: { $in: [...latest.values()].map((message) => message._id) } },
    options: { projection: { _id: 1, content: 1 } },
  }));
  const content = new Map(previews.map((message) => [rawId(message._id), message.content]));
  for (const user of snapshot.users) {
    const id = rawId(user._id)!;
    if (user.isBot === undefined) await rawUpdate(client, 'users', id, { isBot: false }, { isBot: { $exists: false } });
    const linked = snapshot.conversations.filter((conversation) => conversation.userIds.map(rawId).includes(id)).map((conversation) => conversation._id);
    if (user.conversationIds === undefined) await rawUpdate(client, 'users', id, { conversationIds: [] }, { conversationIds: { $exists: false } });
    if (linked.length) await client.$runCommandRaw({ update: 'users', updates: [{
      q: { _id: user._id }, u: { $addToSet: { conversationIds: { $each: linked } } },
    }] });
  }
  for (const conversation of snapshot.conversations) {
    const id = rawId(conversation._id)!;
    const last = latest.get(id);
    const summary = {
      activityAt: last?.createdAt ?? conversation.createdAt, lastMessageAt: last?.createdAt ?? null,
      lastMessageId: last?._id ?? null,
      lastMessagePreview: last ? messagePreview(content.get(rawId(last._id)) ?? null, last.fileId ? files.get(rawId(last.fileId))?.kind : null, last.imageBytes > 0) : null,
      unreadCounts: counts.get(id),
    };
    if (forceSummaries) await rawUpdate(client, 'conversations', id, summary);
    else for (const [field, value] of Object.entries(summary)) {
      await rawUpdate(client, 'conversations', id, { [field]: value }, { [field]: { $exists: false } });
    }
  }
}

/** No schema push that drops indexes, no data deletion, and no implicit credential/DM migration. */
export async function provisionDatabase(prisma: PrismaClient) {
  await assertReplicaSet(prisma);
  const snapshot = await loadDatabaseSnapshot(prisma);
  const report = analyzeDatabase(snapshot);
  if (report.conflicts.length || Object.values(report.legacy).some((count) => count > 0)) {
    throw new DatabaseSafetyError('Legacy data or conflicts detected. Run db:inspect, back up data, stop writers and explicitly review db:migrate; provisioning made no changes');
  }
  await validateStoredPayloads(prisma, snapshot);
  for (const [collection, required] of Object.entries(REQUIRED_INDEXES)) {
    const indexes = await collectionIndexes(prisma, collection);
    if (indexes.some((index) => index.unique && JSON.stringify(index.key) !== JSON.stringify({ _id: 1 }) &&
      !required.some((expected) => JSON.stringify(expected.key) === JSON.stringify(index.key)))) {
      throw new DatabaseSafetyError(`Unexpected unique index in ${collection} requires review; provisioning made no changes`);
    }
  }
  await initializeDefaults(prisma, snapshot);
  for (const [collection, required] of Object.entries(REQUIRED_INDEXES)) {
    const indexes = await collectionIndexes(prisma, collection);
    const missing = required.filter((index) => !matchingIndex(indexes, index));
    if (missing.length) await prisma.$runCommandRaw({ createIndexes: collection, indexes: missing });
  }
  await verifyIndexes(prisma);
  await prisma.$runCommandRaw({ update: '_chatapp_meta', updates: [{
    q: { _id: 'schema' }, u: { $set: { version: SCHEMA_VERSION, provisionedAt: { $date: new Date().toISOString() } } }, upsert: true,
  }] });
  return { status: 'ok', schemaVersion: SCHEMA_VERSION, counts: report.counts };
}

export async function migrateDatabase(prisma: PrismaClient, options: {
  reviewToken: string; acknowledgedBackup: boolean; credentialResets?: Record<string, string>; approvedBots?: string[];
}) {
  if (!options.acknowledgedBackup) throw new DatabaseSafetyError('MIGRATION_ACKNOWLEDGE_BACKUP=true is required after backup and stopping API writers');
  await assertReplicaSet(prisma);
  const approvedBots = options.approvedBots ?? [];
  const snapshot = await loadDatabaseSnapshot(prisma);
  const report = analyzeDatabase(snapshot, approvedBots);
  if (report.reviewToken !== options.reviewToken) throw new DatabaseSafetyError('Review token is stale or missing; inspect the current migration dry-run');
  if (report.conflicts.length) throw new DatabaseSafetyError('Unresolved conflicts require explicit human decisions; no histories/accounts will be deleted or merged');
  await validateStoredPayloads(prisma, snapshot);
  const sensitiveUsers = records(await prisma.user.findRaw({ options: { projection: { _id: 1, phone: 1, passwordHash: 1 } } }));
  const source = new Map(sensitiveUsers.map((user) => [rawId(user._id), user]));
  const updates = new Map<string, Raw>();
  for (const user of snapshot.users) {
    const id = rawId(user._id)!;
    const bot = approvedBots.includes(id) || user.isBot === true;
    if (bot) { updates.set(id, { isBot: true, passwordHash: null, phone: null }); continue; }
    let passwordHash = source.get(id)?.passwordHash ?? null;
    if (!user.hasHash) {
      const password = options.credentialResets?.[id] ?? source.get(id)?.phone;
      if (typeof password !== 'string' || !password.trim() || Buffer.byteLength(password, 'utf8') > 1024 || /[\x00-\x1f\x7f-\x9f]/.test(password)) {
        throw new DatabaseSafetyError('A legacy account lacks valid credentials; provide reviewed MIGRATION_CREDENTIALS_JSON keyed by its user ID');
      }
      passwordHash = await hashPassword(password.trim());
    }
    updates.set(id, { passwordHash, phone: null, isBot: false });
  }
  for (const id of Object.keys(options.credentialResets ?? {})) {
    const user = snapshot.users.find((entry) => rawId(entry._id) === id);
    if (!user || user.hasHash || user.isBot || approvedBots.includes(id)) throw new DatabaseSafetyError('Credential resets may target only existing legacy human accounts without valid hashes');
  }
  for (const id of approvedBots) {
    const user = snapshot.users.find((entry) => rawId(entry._id) === id);
    if (!user || !isReservedBotName(user.name)) throw new DatabaseSafetyError('Approved bot IDs must identify an existing reserved bot name');
  }
  await prisma.$transaction(async (tx) => {
    const current = await loadDatabaseSnapshot(tx);
    if (analyzeDatabase(current, approvedBots).reviewToken !== options.reviewToken) throw new DatabaseSafetyError('Data changed after review; migration aborted');
    for (const [id, data] of updates) {
      const original = source.get(id)!;
      const matches = Object.fromEntries(['phone', 'passwordHash'].map((field) =>
        [field, original[field] === undefined ? { $exists: false } : original[field]],
      ));
      if (await rawUpdate(tx, 'users', id, data, matches) !== 1) throw new DatabaseSafetyError('Credentials changed during migration preparation; transaction aborted');
    }
    for (const conversation of current.conversations) if (!conversation.conversationKey) {
      const key = conversation.type === 'DM' ? canonicalDmKey(conversation.userIds.map(rawId)) : `group:${randomUUID()}`;
      await rawUpdate(tx, 'conversations', rawId(conversation._id)!, { conversationKey: key });
    }
    for (const message of current.messages) {
      const conversation = current.conversations.find((entry) => rawId(entry._id) === rawId(message.conversationId))!;
      const old = receipts(message.status ?? {});
      const status = Object.fromEntries(conversation.userIds.map((value: any) => {
        const id = rawId(value)!;
        return [id, id === rawId(message.senderId) ? { delivered: true, read: true } : old[id] ?? { delivered: false, read: false }];
      }));
      await rawUpdate(tx, 'messages', rawId(message._id)!, { sendKey: message.sendKey || `legacy:${rawId(message._id)}`, clientMessageId: message.clientMessageId ?? null, status });
      message.status = status;
    }
    await initializeDefaults(tx, current, true);
  }, { maxWait: 10_000, timeout: 120_000 });
  return { status: 'ok', counts: report.counts, next: 'Run npm run db:provision before starting the API' };
}

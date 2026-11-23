const { DatabaseSafetyError, provisionDatabase } = require('../src/prisma/database');
const { hashPassword, verifyPassword } = require('../src/auth/password');
const { cleanName, isReservedBotName } = require('../src/common/input.util');
const { ConversationService } = require('../src/conversation/conversation.service');
const { MessageService } = require('../src/message/message.service');
const { inTransaction, isUniqueCollision } = require('../src/prisma/transaction');
const { run, noArguments } = require('./db-common.cjs');

void run(async (prisma) => {
  noArguments();
  const credentials = [
    [process.env.DEMO_USERNAME_A ?? 'demo_alice', process.env.DEMO_PASSWORD_A],
    [process.env.DEMO_USERNAME_B ?? 'demo_bob', process.env.DEMO_PASSWORD_B],
  ].map(([rawName, password]) => {
    const name = cleanName(rawName);
    if (isReservedBotName(name) || typeof password !== 'string' || !password.trim() || password !== password.trim() ||
        Buffer.byteLength(password) > 1024 || /[\x00-\x1f\x7f-\x9f]/.test(password)) {
      throw new DatabaseSafetyError('Explicit non-empty disposable DEMO_PASSWORD_A and DEMO_PASSWORD_B are required; bot names are reserved');
    }
    return [name, password];
  });
  if (credentials[0][0] === credentials[1][0]) throw new DatabaseSafetyError('Demo usernames must be distinct');
  await provisionDatabase(prisma);
  const users = [];
  for (const [name, password] of credentials) {
    let user = await prisma.user.findUnique({ where: { name } });
    if (!user) {
      try { user = await prisma.user.create({ data: { name, passwordHash: await hashPassword(password), isBot: false, conversationIds: [] } }); }
      catch (error) {
        if (!isUniqueCollision(error)) throw error;
        user = await prisma.user.findUnique({ where: { name } });
      }
    }
    if (!user || user.isBot || !(await verifyPassword(password, user.passwordHash))) throw new DatabaseSafetyError('Existing demo account credentials differ; no account was overwritten');
    users.push(user);
  }
  const conversations = new ConversationService(prisma);
  const messages = new MessageService(prisma);
  const dm = await conversations.createConversation({ type: 'DM', participants_ids: [users[1].id] }, users[0].id);
  const groupKey = 'group:ba9fa5b0-5a94-4a42-b743-9e081cfcc362';
  const checkGroup = (group) => {
    if (group.type !== 'GROUP' || group.participants_ids.length !== 2 || !users.every((user) => group.participants_ids.includes(user.id))) {
      throw new DatabaseSafetyError('Demo group key is already used by a different fixture; no conversation was overwritten');
    }
    return group;
  };
  let group;
  try {
    group = await inTransaction(prisma, async (tx) => {
      const existing = await tx.conversation.findUnique({ where: { conversationKey: groupKey } });
      if (existing) return checkGroup(existing);
      const created = await tx.conversation.create({ data: {
        conversationKey: groupKey, type: 'GROUP', name: 'Demo Project', createdBy: users[0].id,
        participants_ids: users.map((user) => user.id), unreadCounts: Object.fromEntries(users.map((user) => [user.id, 0])),
      } });
      await tx.user.updateMany({ where: { id: { in: users.map((user) => user.id) } }, data: { conversationIds: { push: created.id } } });
      return created;
    });
  } catch (error) {
    if (!isUniqueCollision(error)) throw error;
    const existing = await prisma.conversation.findUnique({ where: { conversationKey: groupKey } });
    if (!existing) throw error;
    group = checkGroup(existing);
  }
  await messages.createMessage({ conversation_id: dm.id, content: 'Welcome to the disposable chat demo.', client_message_id: '243eae7b-aef4-46b8-86ca-ce21a93d221b' }, users[0].id);
  await messages.createMessage({ conversation_id: group.id, content: 'This group is an idempotent test fixture.', client_message_id: '2c05b525-90bf-4f81-b3b7-4da7c20e78bc' }, users[1].id);
  return { status: 'ok', testOnly: true, users: users.map(({ id, name }) => ({ id, name })), dmId: dm.id, groupId: group.id };
}, 'TEST_DATABASE_URL', true);

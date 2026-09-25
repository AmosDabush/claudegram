/**
 * Forum-topic routing.
 *
 * A Telegram forum topic is a thread inside one supergroup, so every topic shares a
 * single chat id. All of this bot's state — sessions, modes, queues — is keyed by chat
 * id alone, which means every topic in a group collapses into one conversation.
 *
 * Rather than thread a topic id through ~300 send sites, a topic gets its own synthetic
 * chat key ("<chat>:<thread>"). Existing code keeps treating that opaque string as a
 * chat id and keys state off it, and the wrapped bot below splits it apart again at the
 * moment of sending. Plain chat ids pass through untouched, so direct messages behave
 * exactly as before.
 */

const KEY = /^(-?\d+):(\d+)$/;

/** "<chat>:<thread>" -> { chatId, threadId }. A plain id yields threadId null. */
function parseChatKey(key) {
  const m = KEY.exec(String(key));
  if (!m) return { chatId: key, threadId: null };
  return { chatId: Number(m[1]), threadId: Number(m[2]) };
}

/** Synthetic key for an incoming message, or its plain chat id outside a topic. */
function chatKeyOf(msg) {
  const chatId = msg?.chat?.id;
  // is_topic_message distinguishes a real topic from the implicit "General" thread,
  // which reports no thread id and should behave like an ordinary chat.
  if (msg?.is_topic_message && msg.message_thread_id) return `${chatId}:${msg.message_thread_id}`;
  return chatId;
}

const isKey = v => typeof v === 'string' && KEY.test(v);

/**
 * A key read back from a JSON file, restored to the form the in-memory maps use.
 *
 * Plain chat ids were stored as numbers and must come back as numbers, or every
 * lookup misses. A topic key is a string and must stay one: parseInt("-100123:7")
 * silently yields -100123, which folds every topic of a group back into the
 * group's own state — each topic overwriting the last one on the next save.
 */
function toChatKey(raw) {
  const s = String(raw);
  if (KEY.test(s)) return s;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? s : n;
}

// Methods taking the chat as their first argument. The options object is the last
// argument for all of them, which is where the thread id belongs.
const CHAT_FIRST = {
  sendMessage: 2,
  sendPhoto: 2,
  sendDocument: 2,
  sendVoice: 2,
  sendAudio: 2,
  sendChatAction: 2,
  sendSticker: 2,
};

// Methods carrying the chat inside an options object instead. Edits address an existing
// message by id, so they need the chat split out but no thread id.
const CHAT_IN_OPTIONS = new Set(['editMessageText', 'editMessageCaption', 'editMessageReplyMarkup']);

function withThread(options, threadId) {
  if (threadId == null) return options;
  const o = { ...(options || {}) };
  // Never override an explicit target: callers that already know their thread win.
  if (o.message_thread_id == null) o.message_thread_id = threadId;
  return o;
}

/**
 * Wraps a bot so synthetic chat keys are understood everywhere. Safe to apply to a bot
 * that never sees a topic: without a key, every call is forwarded verbatim.
 */
function wrapBot(bot) {
  const cache = new Map();

  return new Proxy(bot, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (cache.has(prop)) return cache.get(prop);

      const name = String(prop);
      let fn;

      if (name in CHAT_FIRST) {
        const optionsIndex = CHAT_FIRST[name];
        fn = (...args) => {
          if (!isKey(args[0])) return value.apply(target, args);
          const { chatId, threadId } = parseChatKey(args[0]);
          args[0] = chatId;
          while (args.length < optionsIndex) args.push(undefined);
          args[optionsIndex] = withThread(args[optionsIndex], threadId);
          return value.apply(target, args);
        };
      } else if (name === 'deleteMessage') {
        // (chatKey, messageId) — the message id already identifies the thread.
        fn = (...args) => {
          if (isKey(args[0])) args[0] = parseChatKey(args[0]).chatId;
          return value.apply(target, args);
        };
      } else if (CHAT_IN_OPTIONS.has(name)) {
        fn = (...args) => {
          const opts = args[1];
          if (opts && isKey(opts.chat_id)) {
            args[1] = { ...opts, chat_id: parseChatKey(opts.chat_id).chatId };
          }
          return value.apply(target, args);
        };
      } else {
        fn = value.bind(target);
      }

      cache.set(prop, fn);
      return fn;
    },
  });
}

module.exports = { wrapBot, chatKeyOf, parseChatKey, toChatKey };

/**
 * One conversation, two windows.
 *
 * The primary session should be reachable both in the group's General topic and in the
 * old direct chat, and both views must stay identical — same text, same edits, same
 * deletions. The two live behind different bot tokens, so a single send has to fan out
 * to both and a later edit has to find both copies again.
 *
 * Downstream code only ever holds one message id, so sends return a synthetic id and the
 * real pair is kept here. Synthetic ids are negative; Telegram's are positive, so the two
 * can never be confused, and anything that was not produced by this mirror falls through
 * to the primary side untouched.
 */

const MIRRORED_METHODS = ['sendMessage', 'sendPhoto', 'sendDocument', 'sendVoice', 'sendAudio', 'sendChatAction', 'sendSticker'];

function createMirror({ primary, secondary, primaryChat, secondaryChat }) {
  const pairs = new Map();
  let nextId = -1;

  // Only traffic aimed at the mirrored chat fans out; everything else is ordinary.
  const isMirrored = (chatId) => String(chatId) === String(primaryChat);

  const remember = (a, b) => {
    const id = nextId--;
    pairs.set(id, { a, b });
    return id;
  };

  async function fanOut(method, chatId, args) {
    const [pResult, sResult] = await Promise.allSettled([
      primary[method](primaryChat, ...args),
      secondary[method](secondaryChat, ...args),
    ]);

    const p = pResult.status === 'fulfilled' ? pResult.value : null;
    const s = sResult.status === 'fulfilled' ? sResult.value : null;

    // A failure on one side must not take the other down: a message landing in one
    // window beats an exception that loses it in both.
    if (!p && !s) throw pResult.reason || sResult.reason || new Error(`${method} failed on both sides`);
    if (!p || !p.message_id) return p || s;

    const id = remember(
      { bot: primary, chat: primaryChat, messageId: p.message_id },
      s && s.message_id ? { bot: secondary, chat: secondaryChat, messageId: s.message_id } : null
    );

    // Hand back something shaped like a real message, carrying the synthetic id.
    return { ...p, message_id: id };
  }

  const sides = (id) => {
    const pair = pairs.get(id);
    if (!pair) return null;
    return [pair.a, pair.b].filter(Boolean);
  };

  return {
    isMirrored,

    /** Wraps a bot so mirrored chats fan out and everything else passes through. */
    wrap(bot) {
      const cache = new Map();
      return new Proxy(bot, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function') return value;
          if (cache.has(prop)) return cache.get(prop);

          const name = String(prop);
          let fn;

          if (MIRRORED_METHODS.includes(name)) {
            fn = (chatId, ...args) =>
              isMirrored(chatId) ? fanOut(name, chatId, args) : value.call(target, chatId, ...args);
          } else if (name === 'editMessageText' || name === 'editMessageCaption' || name === 'editMessageReplyMarkup') {
            fn = async (payload, options = {}) => {
              const targets = sides(options.message_id);
              if (!targets) return value.call(target, payload, options);
              const results = await Promise.allSettled(
                targets.map(t => t.bot[name](payload, { ...options, chat_id: t.chat, message_id: t.messageId }))
              );
              const ok = results.find(r => r.status === 'fulfilled');
              if (ok) return ok.value;
              throw results[0].reason;
            };
          } else if (name === 'deleteMessage') {
            fn = async (chatId, messageId, ...rest) => {
              const targets = sides(messageId);
              if (!targets) return value.call(target, chatId, messageId, ...rest);
              await Promise.allSettled(targets.map(t => t.bot.deleteMessage(t.chat, t.messageId)));
              pairs.delete(messageId);
              return true;
            };
          } else {
            fn = value.bind(target);
          }

          cache.set(prop, fn);
          return fn;
        },
      });
    },
  };
}

module.exports = { createMirror };

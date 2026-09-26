/**
 * Natural-language settings.
 *
 * Changing a setting used to mean: open /settings, find the row, read the icons, tap.
 * Four taps on a phone, and you have to already know which row you want. This lets the
 * same change arrive as an ordinary sentence — "אני רוצה קול", "מחשבה אוטומטי",
 * "voice auto, stream live" — typed or dictated, in Hebrew or English.
 *
 * Two shapes, on purpose:
 *   setting + value  ("קול אוטומטי")  -> applied immediately, one confirmation line
 *   setting alone    ("אני רוצה קול") -> ONE question with the possible answers as buttons
 *
 * The second shape is the point. The bot never guesses which value you meant; it asks the
 * one question that resolves it, so a half-specified request costs a single tap instead of
 * a menu walk. Fully specified requests cost none.
 *
 * Nothing here needs a restart: every setting lives in the in-memory userState that the
 * turn loop reads when it builds the next prompt, so a change applies to the very next
 * message. scheduleSave() only persists it across restarts.
 *
 * False positives are the real risk — this sits in front of every message, and a coding
 * request that happens to contain "מצב" must still reach Claude. Three guards: the message
 * must be short, it must carry an intent verb or an explicit value, and the ask always
 * offers "not a setting", which forwards the original message on untouched.
 */

const { getUserState, scheduleSave } = require('../state');
const {
  TTS_ENGINES, VOICE_CHUNK_PRESETS, EDGE_VOICE_OPTIONS, SPEED_OPTIONS,
  TEXT_STYLE_OPTIONS, VOICE_STYLE_OPTIONS
} = require('../config');

// ===== Text normalisation =====

const NIQQUD = /[֑-ׇ]/g;

/** Lowercased, niqqud- and punctuation-free, single-spaced. Matching happens here. */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(NIQQUD, '')
    .replace(/[׳״'"`]/g, '')       // גרש/גרשיים inside words: אימוג'י -> אימוגי
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Hebrew glues its prepositions onto the word — קול, לקול, בקול, שהקול are all the same
// token to a reader and must be to the matcher too. English aliases are unaffected.
const PREFIX = '[בהולמשכ]{0,3}';
const reCache = new Map();

function aliasRe(alias) {
  let re = reCache.get(alias);
  if (!re) {
    const a = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(?:^|\\s)${PREFIX}${a}(?=\\s|$)`, 'u');
    reCache.set(alias, re);
  }
  return re;
}

/** Earliest match of any alias in the list, or null. Longest alias wins a tie. */
function findAlias(text, aliases) {
  let best = null;
  for (const a of aliases) {
    const m = aliasRe(a).exec(text);
    if (m && (!best || m.index < best.index || (m.index === best.index && a.length > best.alias.length))) {
      best = { index: m.index, end: m.index + m[0].length, alias: a };
    }
  }
  return best;
}

// ===== Value vocabularies =====

function V(id, label, aliases = []) {
  const all = new Set(aliases.map(norm).filter(Boolean));
  const nid = norm(id);
  if (/^[a-z][a-z0-9 ]*$/.test(nid)) all.add(nid);
  return { id, label, aliases: [...all] };
}

const OFF = ['off', 'כבוי', 'כבה', 'לכבות', 'תכבה', 'בטל', 'בלי', 'ללא', 'אין', 'תוריד', 'disable'];
const ON = ['on', 'כפתור', 'button', 'ידני', 'manual', 'דלוק'];
const AUTO = ['auto', 'אוטומטי', 'אוטומט', 'אוטו', 'automatic', 'לבד', 'תמיד', 'always'];

// ===== The registry =====
//
// One entry per thing the quick-settings panel can change, plus the voice knobs that
// previously lived three menus deep. `apply` is the only place that mutates state, so
// side effects (a session that must restart, a legacy flag that must stay in sync) are
// stated once and shared by the message path, the button path and /set.

const SETTINGS = [
  {
    key: 'voice',
    label: '🔊 קול',
    question: 'איזה מצב קול?',
    aliases: ['קול', 'ווייס', 'voice', 'הקראה', 'להקריא', 'יקריא', 'קולי', 'הודעה קולית',
              'הודעות קוליות', 'voice message', 'tts', 'אודיו', 'audio', 'שמע', 'דיבור'],
    values: [
      V('off', '🔇 כבוי', OFF),
      V('on', '🔘 כפתור (ידני)', ON),
      V('auto', '🎙 אוטומטי', AUTO)
    ],
    current: s => s.voiceMode || 'off',
    apply: (s, id) => { s.voiceMode = id; s.voiceEnabled = id !== 'off'; }
  },
  {
    key: 'stt',
    label: '🎧 תמלול הקלטות',
    question: 'לתמלל הודעות קוליות שאתה שולח?',
    aliases: ['תמלול', 'תמלל', 'transcription', 'transcribe', 'stt', 'הקלטות', 'הכתבה', 'whisper'],
    values: [
      V('off', '🚫 כבוי', OFF),
      V('on', '🎧 דלוק', ON)
    ],
    current: s => s.sttMode || 'off',
    apply: (s, id) => { s.sttMode = id; },
    // The only setting that can fail to take: it needs things that are not npm packages.
    // Check before promising, and fall back rather than leave it on and broken.
    after: (ctx, id) => {
      if (id !== 'on') return;
      const stt = require('../stt');
      const gaps = stt.missing();
      if (gaps.length) {
        ctx.userState.sttMode = 'off';
        scheduleSave();
        ctx.bot.sendMessage(ctx.chatId,
          `⚠️ חסר במכונה שמריצה את הבוט:\n• ${gaps.join('\n• ')}\n\n` +
          `אחרי שתתקין, תדליק שוב. המודל עצמו יורד לבד בפעם הראשונה (בערך 1.5GB).`,
          { parse_mode: 'Markdown' }).catch(() => {});
        return;
      }
      ctx.bot.sendMessage(ctx.chatId,
        '🎧 תמלול דלוק. תשלח הקלטה והיא תיכנס כמו הודעה רגילה.\n' +
        '_הכל רץ מקומית. ההקלטה הראשונה אטית יותר — המודל נטען פעם אחת._',
        { parse_mode: 'Markdown' }).catch(() => {});
    }
  },
  {
    key: 'thought',
    label: '🧠 מחשבה',
    question: 'מה לעשות עם המחשבה?',
    aliases: ['מחשבה', 'מחשבות', 'חשיבה', 'טינקינג', 'thinking', 'thought', 'thoughts', 'reasoning'],
    values: [
      V('off', '🚫 כבוי', OFF),
      V('on', '🔘 כפתור', ON),
      V('auto', '👁 אוטומטי', AUTO)
    ],
    current: s => s.thoughtMode || 'off',
    apply: (s, id) => { s.thoughtMode = id; }
  },
  {
    key: 'stream',
    label: '⌨️ סטרים',
    question: 'איך להזרים את התשובה?',
    aliases: ['סטרים', 'stream', 'streaming', 'הזרמה', 'זרימה', 'שידור'],
    values: [
      V('off', '📦 כבוי (בלוק שלם)', OFF),
      V('on', '⌨️ מודפס', [...ON, 'רגיל', 'normal']),
      V('live', '🔴 לייב (כולל מחשבה)', ['live', 'לייב', 'חי', 'זורם'])
    ],
    current: s => s.streamMode || 'on',
    apply: (s, id) => { s.streamMode = id; }
  },
  {
    key: 'perm',
    label: '⚙️ הרשאות',
    question: 'באיזה מצב הרשאות?',
    // Deliberately not bare "מצב" (too common in ordinary sentences) and not bare "מוד",
    // which in dictation almost always trails another setting's value — "ברו מוד",
    // "יולו מוד". Those resolve through SOLO instead, on the value rather than the noun.
    aliases: ['mode', 'הרשאות', 'permissions', 'perm', 'הרשאה', 'מצב הרשאות'],
    values: [
      V('default', '🔒 Default (שואל)', ['default', 'ברירת מחדל', 'דיפולט', 'בטוח', 'שואל']),
      V('fast', '⚡ Fast', ['fast', 'מהיר', 'פאסט']),
      V('plan', '📋 Plan', ['plan', 'תכנון', 'פלאן', 'תוכנית']),
      V('yolo', '🔥 YOLO', ['yolo', 'יולו', 'חופשי', 'בלי הרשאות'])
    ],
    current: s => s.currentMode || 'yolo',
    apply: (s, id) => { s.currentMode = id; }
  },
  {
    key: 'vocstyle',
    label: '🎙 אופי דיבור',
    question: 'איזה אופי לקול?',
    aliases: ['אופי', 'סגנון', 'סגנון דיבור', 'סגנון קול', 'סטייל', 'style', 'voice style',
              'טון', 'tone', 'פרסונה', 'persona'],
    values: VOICE_STYLE_OPTIONS.map(o => V(o.id, o.name, {
      off: ['רגיל טקסט'],
      normal: ['נורמלי', 'רגיל'],
      casual: ['קזואל', 'קליל', 'שיחתי'],
      very_casual: ['מאוד קזואל', 'טבעי', 'דיבורי', 'very casual'],
      bro: ['ברו', 'אח שלי', 'חבר', 'bro']
    }[o.id] || [])),
    current: s => (s.voiceSettings || {}).responseLevel || 'very_casual',
    apply: (s, id) => { (s.voiceSettings = s.voiceSettings || {}).responseLevel = id; }
  },
  {
    key: 'txtstyle',
    label: '📝 סגנון טקסט',
    question: 'איזה סגנון טקסט?',
    aliases: ['סגנון טקסט', 'טקסט', 'text style', 'סגנון כתיבה', 'כתיבה'],
    values: TEXT_STYLE_OPTIONS.map(o => V(o.id, o.name, {
      off: ['רגיל'],
      concise: ['קצר', 'תמציתי', 'תכלס'],
      detailed: ['מפורט', 'ארוך', 'הסבר מלא'],
      code_only: ['קוד', 'code', 'רק קוד'],
      no_emoji: ['בלי אימוגי', 'ללא אימוגי', 'no emoji', 'אימוגי']
    }[o.id] || [])),
    current: s => (s.voiceSettings || {}).textStyle || 'off',
    apply: (s, id) => { (s.voiceSettings = s.voiceSettings || {}).textStyle = id; }
  },
  {
    key: 'engine',
    label: '🛠 מנוע קול',
    question: 'איזה מנוע TTS?',
    aliases: ['מנוע', 'engine', 'מנוע קול', 'tts engine', 'מנוע הקראה'],
    values: Object.entries(TTS_ENGINES).map(([id, e]) => V(id, `${e.icon} ${e.name}`, {
      piper: ['פייפר', 'מקומי', 'לוקלי'],
      google: ['גוגל'],
      edge: ['אדג', 'edge tts', 'מיקרוסופט'],
      coqui: ['קוקי']
    }[id] || [])),
    current: s => (s.voiceSettings || {}).ttsEngine || 'edge',
    apply: (s, id) => { (s.voiceSettings = s.voiceSettings || {}).ttsEngine = id; }
  },
  {
    key: 'speed',
    label: '🏃 מהירות דיבור',
    question: 'איזו מהירות דיבור?',
    aliases: ['מהירות', 'speed', 'rate', 'קצב', 'קצב דיבור', 'מהירות דיבור'],
    values: SPEED_OPTIONS.map(o => V(o.id, o.name, {
      '-50%': ['מאוד איטי', 'איטי מאוד', 'very slow'],
      '-25%': ['איטי', 'slow'],
      '+0%': ['רגיל', 'רגילה', 'normal', 'נורמלי'],
      '+25%': ['מהיר', 'fast'],
      '+50%': ['מאוד מהיר', 'מהיר מאוד', 'very fast'],
      '+100%': ['הכי מהיר', 'כפול', 'ultra', 'אולטרה']
    }[o.id] || [])),
    // "+25%" survives neither normalisation nor a callback_data round-trip intact, so a
    // literal percentage in the message is read off the raw text instead of the vocabulary.
    raw: (text) => {
      const m = /([+-]?)(\d{1,3})\s*%/.exec(text);
      if (!m) return null;
      const id = `${m[1] === '-' ? '-' : '+'}${m[2]}%`;
      return SPEED_OPTIONS.some(o => o.id === id) ? id : null;
    },
    current: s => (s.voiceSettings || {}).rate || '+25%',
    apply: (s, id) => { (s.voiceSettings = s.voiceSettings || {}).rate = id; }
  },
  {
    key: 'hevoice',
    label: '🇮🇱 קול עברי',
    question: 'איזה קול בעברית?',
    aliases: ['קול עברי', 'קול בעברית', 'hebrew voice', 'דובר', 'דוברת', 'קריין', 'קריינית'],
    values: EDGE_VOICE_OPTIONS.hebrew.map(o => V(o.id, o.name, {
      'he-IL-AvriNeural': ['אברי', 'avri', 'גבר', 'זכר', 'male'],
      'he-IL-HilaNeural': ['הילה', 'hila', 'אישה', 'נקבה', 'female']
    }[o.id] || [])),
    current: s => (s.voiceSettings || {}).hebrewVoice || 'he-IL-HilaNeural',
    apply: (s, id) => { (s.voiceSettings = s.voiceSettings || {}).hebrewVoice = id; }
  },
  {
    key: 'chunk',
    label: '✂️ חיתוך קול',
    question: 'איזה גודל קטעים לקול?',
    aliases: ['חיתוך', 'צאנק', 'chunk', 'chunks', 'קטעים', 'חלוקה', 'גודל קטעים'],
    values: Object.entries(VOICE_CHUNK_PRESETS).map(([id, p]) => V(id, `${p.icon} ${p.name}`, {
      small: ['קטן'], medium: ['בינוני'], large: ['גדול'],
      none: ['בלי חיתוך', 'שלם', 'הודעה שלמה']
    }[id] || [])),
    current: s => (s.voiceSettings || {}).chunkPreset || 'medium',
    apply: (s, id) => { (s.voiceSettings = s.voiceSettings || {}).chunkPreset = id; }
  },
  {
    key: 'session',
    label: '💬 סשן',
    question: 'סשן רציף או חד-פעמי?',
    aliases: ['סשן', 'session', 'שיחה רציפה', 'זיכרון שיחה'],
    values: [
      V('session', '💬 סשן רציף', ['session', 'רציף', 'המשכי', 'continuous', 'on']),
      V('demand', '⚡ חד-פעמי', ['demand', 'on demand', 'חד פעמי', 'חד פעמית', 'נפרד', 'off'])
    ],
    current: s => (s.sessionMode ? 'session' : 'demand'),
    apply: (s, id, ctx) => {
      s.sessionMode = id === 'session';
      if (id !== 'session') {
        try { require('./claude').stopInteractiveSession(s); } catch (e) {}
        try { require('../sessions').clearSession(ctx.chatId); } catch (e) {}
      }
    }
  },
  {
    key: 'interactive',
    label: '🔄 אינטראקטיבי',
    question: 'מצב אינטראקטיבי?',
    aliases: ['אינטראקטיבי', 'interactive', 'תהליך קבוע', 'persistent'],
    values: [
      V('on', '🔄 דלוק', ON),
      V('off', '⏹ כבוי', OFF)
    ],
    current: s => (s.interactiveMode ? 'on' : 'off'),
    apply: (s, id) => {
      s.interactiveMode = id === 'on';
      if (id === 'off' && s.interactiveProc) {
        try { require('./claude').stopInteractiveSession(s); } catch (e) {}
      }
    }
  },
  {
    key: 'model',
    label: '🤖 מודל',
    question: 'איזה מודל?',
    aliases: ['מודל', 'model', 'מנוע קלוד'],
    values: [
      V('claude-opus-4-8', '🧠 Opus 4.8', ['opus', 'אופוס']),
      V('claude-sonnet-5', '🎼 Sonnet 5', ['sonnet', 'סונט']),
      V('claude-haiku-4-5-20251001', '🍃 Haiku 4.5', ['haiku', 'הייקו']),
      V('claude-fable-5', '📖 Fable 5', ['fable', 'פייבל']),
      V('__default', '⚙️ Default (CLI)', ['default', 'ברירת מחדל', 'דיפולט'])
    ],
    current: s => s.model || '__default',
    // A model change only takes effect when the CLI is (re)spawned, so a live session is
    // restarted onto the same transcript — otherwise the setting silently lies until the
    // next session, which is exactly the class of bug this whole file exists to avoid.
    apply: (s, id, ctx) => {
      s.model = id === '__default' ? null : id;
      if (s.interactiveProc) {
        const claude = require('./claude');
        const resumeId = s.interactiveSessionId;
        claude.stopInteractiveSession(s);
        if (resumeId) claude.startInteractiveSession(s, ctx.chatId, ctx.bot, resumeId);
      }
    }
  }
];

const byKey = k => SETTINGS.find(s => s.key === k);

// A handful of values name themselves unambiguously — "יולו" can only be a permission
// mode, "סונט" can only be a model — so they are accepted without the setting word.
// Deliberately tiny: "קוד" and "מהיר" are also values, and also things people say about
// their actual work, which is why they are not here.
const SOLO = [
  ['perm', 'yolo', ['yolo', 'יולו']],
  ['vocstyle', 'bro', ['ברו']],
  ['stream', 'live', ['לייב']],
  ['model', 'claude-opus-4-8', ['אופוס']],
  ['model', 'claude-sonnet-5', ['סונט']],
  ['model', 'claude-haiku-4-5-20251001', ['הייקו']],
  ['model', 'claude-fable-5', ['פייבל']]
].map(([key, value, aliases]) => ({ setting: byKey(key), value, aliases: aliases.map(norm) }));

// ===== Intent detection =====

const INTENT_VERBS = [
  'רוצה', 'תן לי', 'תעשה', 'עשה', 'תשנה', 'שנה', 'שים', 'תשים', 'תדליק', 'להדליק',
  'תכבה', 'לכבות', 'תפעיל', 'להפעיל', 'תעביר', 'העבר', 'תגדיר', 'הגדר', 'תעדכן',
  'עדכן', 'תחזיר', 'אפשר', 'תוריד', 'צריך',
  'set', 'turn', 'enable', 'disable', 'switch', 'make it', 'give me', 'i want', 'want', 'change'
].map(norm);

const EXPLICIT_PREFIX = /^\s*(?:\/set\b|set\s|הגדר\s|תגדיר\s)/i;

/**
 * Split the message at each setting keyword so a value binds to the setting it follows.
 * "קול אוטומטי ומחשבה כבוי" is two independent requests, not one ambiguous pair.
 */
function parse(text) {
  const n = norm(text);
  if (!n) return { hits: [], n };

  const raw = [];
  for (const s of SETTINGS) {
    const hit = findAlias(n, s.aliases);
    if (hit) raw.push({ setting: s, ...hit });
  }

  const solo = () => {
    for (const s of SOLO) {
      if (findAlias(n, s.aliases)) return { hits: [{ setting: s.setting, value: s.value, solo: true }], n };
    }
    return null;
  };

  if (!raw.length) {
    const s = solo();
    if (s) return s;
  }

  // "סגנון טקסט" matches both the text-style setting and the voice-style one ("סגנון"),
  // at the same offset. Two hits on one phrase would split the sentence into an empty
  // segment and lose the value, so overlapping matches collapse to the longest alias.
  raw.sort((a, b) => a.index - b.index || (b.end - b.index) - (a.end - a.index));
  const found = [];
  let lastEnd = -1;
  for (const f of raw) {
    if (f.index < lastEnd) continue;
    found.push(f);
    lastEnd = f.end;
  }

  const hits = found.map((f, i) => {
    // The first segment reaches back to the start so "אוטומטי קול" reads too.
    const from = i === 0 ? 0 : f.index;
    const to = i + 1 < found.length ? found[i + 1].index : n.length;
    const seg = n.slice(from, to);
    const rawSeg = text;

    let value = null;
    if (f.setting.raw) value = f.setting.raw(rawSeg);
    if (!value) {
      let best = null;
      for (const v of f.setting.values) {
        const m = findAlias(seg, v.aliases);
        if (m && (!best || m.alias.length > best.len || (m.alias.length === best.len && m.index < best.index))) {
          best = { id: v.id, len: m.alias.length, index: m.index };
        }
      }
      value = best && best.id;
    }
    return { setting: f.setting, value: value || null };
  });

  // "ברו מוד" reads as the permissions setting with no value, because "מוד" is its word
  // and "ברו" is not one of its values. A self-naming value that fits nothing else is the
  // better answer than a question about the wrong setting.
  if (hits.length && hits.every(h => !h.value)) {
    const s = solo();
    if (s) return s;
  }

  return { hits, n };
}

function shouldHandle(text, parsed) {
  if (!parsed.hits.length) return false;
  if (EXPLICIT_PREFIX.test(text)) return true;
  if (text.length > 140) return false;

  const words = parsed.n.split(' ').length;
  if (words > 12) return false;

  const hasValue = parsed.hits.some(h => h.value);
  const hasVerb = INTENT_VERBS.some(v => aliasRe(v).test(parsed.n));

  // A value standing on its own named no setting, so there is less evidence here than
  // usual — "מה קורה עם הלייב" is a question, not a request. Demand terseness or a verb.
  if (parsed.hits.some(h => h.solo)) return hasVerb || words <= 2;

  // A bare "קול אוטומטי" is unmistakable; anything longer has to say it wants something.
  return hasVerb || hasValue || words <= 3;
}

// ===== Rendering =====

const valueLabel = (setting, id) => (setting.values.find(v => v.id === id) || {}).label || String(id);

function valueKeyboard(setting, current, extraRow) {
  const rows = [];
  setting.values.forEach((v, i) => {
    const mark = v.id === current ? '✓ ' : '';
    rows.push([{ text: `${mark}${v.label}`, callback_data: `nls:v:${setting.key}:${i}` }]);
  });
  if (extraRow) rows.push(extraRow);
  return { inline_keyboard: rows };
}

// Undo needs the value that was in place before the change, and the button that offers it
// can outlive many messages — so it is remembered per chat+setting rather than per message.
const previous = new Map();
const prevKey = (chatId, key) => `${chatId}::${key}`;

function applyOne(ctx, setting, valueId) {
  const before = setting.current(ctx.userState);
  if (before !== valueId) previous.set(prevKey(ctx.chatId, setting.key), before);
  setting.apply(ctx.userState, valueId, ctx);
  scheduleSave();
  if (setting.after) {
    try { setting.after(ctx, valueId, before); } catch (e) { console.log(`[settings] ${e.message}`); }
  }
  return before;
}

/**
 * Change one setting from outside — the quick-settings panel uses this so a row there
 * and a sentence here cannot drift into two different behaviours.
 */
function applySetting(bot, chatId, userState, key, valueId) {
  const setting = byKey(key);
  if (!setting) return false;
  applyOne({ bot, chatId, userState }, setting, valueId);
  return true;
}

// Messages waiting on an answer: the unanswered settings, plus the original message so
// "not a setting" can still deliver it to Claude.
const pending = new Map();

function askFor(bot, chatId, setting, userState) {
  return bot.sendMessage(chatId,
    `${setting.label} — ${setting.question}`,
    {
      reply_markup: valueKeyboard(setting, setting.current(userState), [
        { text: '❌ לא הגדרה — שלח לקלוד', callback_data: 'nls:x' }
      ])
    }
  );
}

// ===== Entry points =====

/**
 * Returns true when the message was a settings request and must not reach Claude.
 */
async function maybeHandle(bot, msg, isAuthorized) {
  if (!msg || !msg.text) return false;
  if (isAuthorized && !isAuthorized(msg)) return false;

  const text = msg.text.replace(/^\s*\/set\b/i, ' ');
  const explicit = EXPLICIT_PREFIX.test(msg.text);
  const parsed = parse(text);

  if (!shouldHandle(msg.text, parsed)) return false;

  const chatId = msg.chat.id;
  const userState = getUserState(chatId);
  const ctx = { bot, chatId, userState };

  const applied = [];
  const unanswered = [];
  for (const h of parsed.hits) {
    if (h.value) {
      applyOne(ctx, h.setting, h.value);
      applied.push(h);
    } else {
      unanswered.push(h.setting);
    }
  }

  if (applied.length) {
    const lines = applied.map(h => `${h.setting.label} → *${valueLabel(h.setting, h.value)}*`);
    const one = applied.length === 1 ? applied[0].setting : null;
    await bot.sendMessage(chatId, `✅ ${lines.join('\n✅ ')}\n\n_חל על ההודעה הבאה, בלי restart._`, {
      parse_mode: 'Markdown',
      reply_markup: one
        ? valueKeyboard(one, one.current(userState), [{ text: '↩️ בטל', callback_data: `nls:u:${one.key}` }])
        : undefined
    }).catch(() => {});
  }

  if (unanswered.length) {
    const first = unanswered[0];
    const sent = await askFor(bot, chatId, first, userState).catch(() => null);
    pending.set(chatId, { msg, queue: unanswered.slice(1), askId: sent && sent.message_id, current: first.key });
  }

  if (!applied.length && !unanswered.length && explicit) {
    await sendOverview(bot, chatId, userState);
  }
  return true;
}

function handleCallback(bot, query, userState) {
  const data = query.data;
  if (!data || !data.startsWith('nls:')) return false;

  const chatId = query.message.chat.id;
  const ctx = { bot, chatId, userState };
  const parts = data.split(':');

  if (parts[1] === 'x') {
    // Not a setting after all — deliver the message that was held back.
    const held = pending.get(chatId);
    pending.delete(chatId);
    bot.answerCallbackQuery(query.id, { text: '↪️ נשלח לקלוד' });
    bot.editMessageText('↪️ נשלח לקלוד כהודעה רגילה.', {
      chat_id: chatId, message_id: query.message.message_id
    }).catch(() => {});
    if (held && held.msg) {
      require('./claude').handleMessage(bot, held.msg, () => true);
    }
    return true;
  }

  if (parts[1] === 'u') {
    const setting = byKey(parts[2]);
    const before = previous.get(prevKey(chatId, parts[2]));
    if (!setting || before === undefined) {
      bot.answerCallbackQuery(query.id, { text: 'אין מה לבטל' });
      return true;
    }
    applyOne(ctx, setting, before);
    bot.answerCallbackQuery(query.id, { text: `↩️ ${valueLabel(setting, before)}` });
    bot.editMessageText(`↩️ ${setting.label} → *${valueLabel(setting, before)}*`, {
      chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown',
      reply_markup: valueKeyboard(setting, before)
    }).catch(() => {});
    return true;
  }

  if (parts[1] === 'v') {
    const setting = byKey(parts[2]);
    const value = setting && setting.values[parseInt(parts[3], 10)];
    if (!setting || !value) {
      bot.answerCallbackQuery(query.id, { text: '?' });
      return true;
    }

    applyOne(ctx, setting, value.id);
    bot.answerCallbackQuery(query.id, { text: `✅ ${setting.key}: ${value.id}` });
    bot.editMessageText(`✅ ${setting.label} → *${value.label}*`, {
      chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown',
      reply_markup: valueKeyboard(setting, value.id, [{ text: '↩️ בטל', callback_data: `nls:u:${setting.key}` }])
    }).catch(() => {});

    // One question per turn: ask the next only once this one is answered.
    const held = pending.get(chatId);
    if (held && held.current === setting.key) {
      if (held.queue.length) {
        const next = held.queue[0];
        askFor(bot, chatId, next, userState).then(sent => {
          pending.set(chatId, { ...held, queue: held.queue.slice(1), askId: sent && sent.message_id, current: next.key });
        }).catch(() => {});
      } else {
        pending.delete(chatId);
      }
    }
    return true;
  }

  return false;
}

function sendOverview(bot, chatId, userState) {
  const lines = SETTINGS.map(s => `${s.label}: *${valueLabel(s, s.current(userState))}*`);
  return bot.sendMessage(chatId,
    `⚙️ *ההגדרות של הסשן הזה*\n\n${lines.join('\n')}\n\n` +
    `כתוב מה לשנות במילים — \`קול אוטומטי\`, \`מחשבה אוטומטי\`, \`סטרים לייב\`, \`מהירות איטי\`.\n` +
    `אם לא תגיד ערך, אשאל אותך שאלה אחת עם הכפתורים.`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

function register(bot, isAuthorized) {
  // Anchored: /settings must keep reaching the panel handler in bot.js.
  bot.onText(/^\/set(?:\s+([\s\S]+))?$/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const arg = (match && match[1] || '').trim();
    if (!arg) return sendOverview(bot, msg.chat.id, getUserState(msg.chat.id));
    const handled = await maybeHandle(bot, { ...msg, text: `set ${arg}` }, isAuthorized);
    if (!handled) {
      bot.sendMessage(msg.chat.id, `לא זיהיתי הגדרה ב"${arg}".`).catch(() => {});
      sendOverview(bot, msg.chat.id, getUserState(msg.chat.id));
    }
  });
}

module.exports = {
  register, maybeHandle, handleCallback, sendOverview, applySetting,
  SETTINGS, parse, shouldHandle, norm
};

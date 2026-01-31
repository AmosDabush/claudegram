/**
 * Voice Commands
 * /voice, /tts, /setvoice, /setvoicespeed, /voiceresponse, /voicechunk
 */

const { getUserState, scheduleSave } = require('../state');
const {
  TTS_ENGINES,
  VOICE_CHUNK_PRESETS,
  EDGE_VOICE_OPTIONS,
  GOOGLE_VOICE_OPTIONS,
  SPEED_OPTIONS,
  GOOGLE_SPEED_OPTIONS,
  TEXT_STYLE_OPTIONS,
  VOICE_STYLE_OPTIONS,
  RESPONSE_STYLE_OPTIONS
} = require('../config');

/**
 * Register voice commands
 */
function register(bot, isAuthorized) {

  // /voice - toggle voice responses (off/on/auto)
  bot.onText(/\/voice(?:\s+(off|on|auto))?/, (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const arg = match[1]?.toLowerCase();

    if (arg === 'auto') {
      userState.voiceMode = 'auto';
      scheduleSave();
      bot.sendMessage(msg.chat.id, '✨ *Voice: AUTO*\nVoice will be generated automatically.', { parse_mode: 'Markdown' });
      return;
    }

    if (arg === 'on') {
      userState.voiceMode = 'on';
      scheduleSave();
      bot.sendMessage(msg.chat.id, '🔊 *Voice: ON*\nClick the Voice button to generate audio.', { parse_mode: 'Markdown' });
      return;
    }

    if (arg === 'off') {
      userState.voiceMode = 'off';
      scheduleSave();
      bot.sendMessage(msg.chat.id, '🔇 *Voice: OFF*\nText-only responses.', { parse_mode: 'Markdown' });
      return;
    }

    // Show current mode with buttons
    const mode = userState.voiceMode || 'off';
    const modeIcons = { off: '🔇', on: '🔊', auto: '✨' };
    const modeNames = { off: 'OFF', on: 'ON (button)', auto: 'AUTO' };
    const engineInfo = TTS_ENGINES[userState.voiceSettings.ttsEngine || 'edge'];
    const chunkPreset = VOICE_CHUNK_PRESETS[userState.voiceSettings.chunkPreset || 'medium'];

    const keyboard = [
      [
        { text: mode === 'off' ? '✓ 🔇 Off' : '🔇 Off', callback_data: 'voicemode:off' },
        { text: mode === 'on' ? '✓ 🔊 On' : '🔊 On', callback_data: 'voicemode:on' },
        { text: mode === 'auto' ? '✓ ✨ Auto' : '✨ Auto', callback_data: 'voicemode:auto' }
      ],
      [{ text: `🔧 Engine: ${engineInfo.icon} ${engineInfo.name}`, callback_data: 'cmd:tts' }],
      [{ text: '🎙 Voice', callback_data: 'cmd:setvoice' }, { text: '⏩ Speed', callback_data: 'cmd:setvoicespeed' }],
      [{ text: `📦 Chunks: ${chunkPreset.icon} ${chunkPreset.name}`, callback_data: 'cmd:voicechunk' }],
      [{ text: '🎭 Style', callback_data: 'cmd:voiceresponse' }]
    ];

    bot.sendMessage(msg.chat.id,
      `🎙 *Voice Settings*\n\nMode: ${modeIcons[mode]} *${modeNames[mode]}*\n\n` +
      `🔇 *Off* - No voice\n` +
      `🔊 *On* - Click button to get voice\n` +
      `✨ *Auto* - Voice auto-generated\n\n` +
      `Engine: ${engineInfo.icon} *${engineInfo.name}*\nChunks: ${chunkPreset.icon} *${chunkPreset.name}*`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
  });

  // /tts - select TTS engine
  bot.onText(/\/tts/, (msg) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const currentEngine = userState.voiceSettings.ttsEngine || 'edge';

    const keyboard = [];
    for (const [id, info] of Object.entries(TTS_ENGINES)) {
      const check = currentEngine === id ? '✓ ' : '';
      keyboard.push([{
        text: `${check}${info.icon} ${info.name} - ${info.description}`,
        callback_data: `tts:${id}`
      }]);
    }

    const currentInfo = TTS_ENGINES[currentEngine];
    bot.sendMessage(msg.chat.id,
      `🔊 *TTS Engine*\n\nCurrent: ${currentInfo.icon} *${currentInfo.name}*\n_${currentInfo.description}_\n\nSelect engine:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
  });

  // /setvoice - change voice settings
  bot.onText(/\/setvoice/, (msg) => {
    if (!isAuthorized(msg)) return;
    sendVoiceSettingsMenu(bot, msg.chat.id, getUserState(msg.chat.id));
  });

  // /setvoicespeed - change voice speed
  bot.onText(/\/setvoicespeed/, (msg) => {
    if (!isAuthorized(msg)) return;
    sendSpeedMenu(bot, msg.chat.id, getUserState(msg.chat.id));
  });

  // /voiceresponse or /voicestyle - change voice response style (for auto voice)
  bot.onText(/\/(voiceresponse|voicestyle)/, (msg) => {
    if (!isAuthorized(msg)) return;
    sendVoiceStyleMenu(bot, msg.chat.id, getUserState(msg.chat.id));
  });

  // /textstyle - change text response style (for non-voice)
  bot.onText(/\/textstyle/, (msg) => {
    if (!isAuthorized(msg)) return;
    sendTextStyleMenu(bot, msg.chat.id, getUserState(msg.chat.id));
  });

  // /voicechunk - change chunk preset
  bot.onText(/\/voicechunk/, (msg) => {
    if (!isAuthorized(msg)) return;
    sendChunkPresetMenu(bot, msg.chat.id, getUserState(msg.chat.id));
  });
}

/**
 * Send voice settings menu
 */
function sendVoiceSettingsMenu(bot, chatId, userState) {
  const currentEngine = userState.voiceSettings.ttsEngine || 'edge';
  const keyboard = [];

  // TTS Engine section
  keyboard.push([{ text: '── TTS Engine ──', callback_data: 'voice:noop' }]);
  for (const [id, info] of Object.entries(TTS_ENGINES)) {
    const check = currentEngine === id ? '✓ ' : '';
    keyboard.push([{ text: `${check}${info.icon} ${info.name} - ${info.description}`, callback_data: `tts:${id}` }]);
  }

  // Show options based on selected engine
  if (currentEngine === 'google') {
    keyboard.push([{ text: '── Google English ──', callback_data: 'voice:noop' }]);
    for (const v of GOOGLE_VOICE_OPTIONS.english) {
      const check = userState.voiceSettings.googleTld === v.id ? '✓ ' : '';
      keyboard.push([{ text: `${check}${v.name}`, callback_data: `googlevoice:${v.id}` }]);
    }
    keyboard.push([{ text: '── Google Hebrew ──', callback_data: 'voice:noop' }]);
    for (const v of GOOGLE_VOICE_OPTIONS.hebrew) {
      const check = userState.voiceSettings.googleHebrewTld === v.id ? '✓ ' : '';
      keyboard.push([{ text: `${check}${v.name}`, callback_data: `googlehebrew:${v.id}` }]);
    }
    keyboard.push([{ text: '── Google Speed ──', callback_data: 'voice:noop' }]);
    for (const s of GOOGLE_SPEED_OPTIONS) {
      const isSelected = (s.id === 'slow') === userState.voiceSettings.googleSlow;
      const check = isSelected ? '✓ ' : '';
      keyboard.push([{ text: `${check}${s.name}`, callback_data: `googlespeed:${s.id}` }]);
    }
  } else if (currentEngine === 'edge') {
    keyboard.push([{ text: '── Edge Voices (English) ──', callback_data: 'voice:noop' }]);
    for (const v of EDGE_VOICE_OPTIONS.english) {
      const check = userState.voiceSettings.voice === v.id ? '✓ ' : '';
      keyboard.push([{ text: `${check}${v.name}`, callback_data: `voice:en:${v.id}` }]);
    }
    keyboard.push([{ text: '── Edge Voices (Hebrew) ──', callback_data: 'voice:noop' }]);
    for (const v of EDGE_VOICE_OPTIONS.hebrew) {
      const check = userState.voiceSettings.hebrewVoice === v.id ? '✓ ' : '';
      keyboard.push([{ text: `${check}${v.name}`, callback_data: `voice:he:${v.id}` }]);
    }
  }

  const engineInfo = TTS_ENGINES[currentEngine];
  let statusText = `🎙 *Voice Settings*\n\nEngine: ${engineInfo.icon} *${engineInfo.name}*`;

  if (currentEngine === 'google') {
    const accentName = GOOGLE_VOICE_OPTIONS.english.find(v => v.id === userState.voiceSettings.googleTld)?.name || userState.voiceSettings.googleTld;
    statusText += `\nAccent: *${accentName}*`;
    statusText += `\nSpeed: *${userState.voiceSettings.googleSlow ? 'Slow' : 'Normal'}*`;
  } else if (currentEngine === 'edge') {
    statusText += `\nEnglish: *${userState.voiceSettings.voice.split('-')[2].replace('Neural', '')}*`;
    statusText += `\nHebrew: *${userState.voiceSettings.hebrewVoice.split('-')[2].replace('Neural', '')}*`;
  } else if (currentEngine === 'piper') {
    statusText += `\nSpeed: *${userState.voiceSettings.piperSpeed === 0.8 ? '1.25x' : userState.voiceSettings.piperSpeed + 'x'}*`;
  }

  bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
}

/**
 * Send speed menu
 */
function sendSpeedMenu(bot, chatId, userState) {
  const keyboard = [];
  for (const s of SPEED_OPTIONS) {
    const check = userState.voiceSettings.rate === s.id ? '✓ ' : '';
    keyboard.push([{ text: `${check}${s.name}`, callback_data: `speed:${s.id}` }]);
  }

  const currentSpeed = SPEED_OPTIONS.find(s => s.id === userState.voiceSettings.rate)?.name || userState.voiceSettings.rate;

  bot.sendMessage(chatId,
    `⏩ *Voice Speed*\n\nCurrent: *${currentSpeed}*`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

/**
 * Send voice style menu (for auto voice mode)
 */
function sendVoiceStyleMenu(bot, chatId, userState) {
  const keyboard = [];
  for (const r of VOICE_STYLE_OPTIONS) {
    const check = userState.voiceSettings.responseLevel === r.id ? '✓ ' : '';
    keyboard.push([{ text: `${check}${r.name}`, callback_data: `voicestyle:${r.id}` }]);
  }

  const currentStyle = VOICE_STYLE_OPTIONS.find(r => r.id === userState.voiceSettings.responseLevel)?.name || userState.voiceSettings.responseLevel;

  bot.sendMessage(chatId,
    `🎙 *Voice Response Style*\n\nCurrent: *${currentStyle}*\n\nThis affects how Claude responds when voice is set to AUTO.\nOptimized for spoken output - no code, no emojis, natural speech.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

/**
 * Send text style menu (for regular text responses)
 */
function sendTextStyleMenu(bot, chatId, userState) {
  const keyboard = [];
  const currentTextStyle = userState.voiceSettings.textStyle || 'off';

  for (const t of TEXT_STYLE_OPTIONS) {
    const check = currentTextStyle === t.id ? '✓ ' : '';
    keyboard.push([{ text: `${check}${t.name}`, callback_data: `textstyle:${t.id}` }]);
  }

  const currentName = TEXT_STYLE_OPTIONS.find(t => t.id === currentTextStyle)?.name || currentTextStyle;

  bot.sendMessage(chatId,
    `📝 *Text Response Style*\n\nCurrent: *${currentName}*\n\nThis affects how Claude responds for regular text messages.\nUsed when voice is OFF or ON (button mode).`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

// Keep for backwards compatibility
function sendResponseStyleMenu(bot, chatId, userState) {
  sendVoiceStyleMenu(bot, chatId, userState);
}

/**
 * Send chunk preset menu
 */
function sendChunkPresetMenu(bot, chatId, userState) {
  const keyboard = [];
  const currentPreset = userState.voiceSettings.chunkPreset || 'medium';

  for (const [id, preset] of Object.entries(VOICE_CHUNK_PRESETS)) {
    const check = currentPreset === id ? '✓ ' : '';
    keyboard.push([{
      text: `${check}${preset.icon} ${preset.name} - ${preset.description}`,
      callback_data: `chunk:${id}`
    }]);
  }

  const current = VOICE_CHUNK_PRESETS[currentPreset];

  bot.sendMessage(chatId,
    `📦 *Voice Chunk Size*\n\nCurrent: ${current.icon} *${current.name}*\n_${current.description}_\n\nSmaller chunks = faster first audio\nLarger chunks = fewer messages`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

/**
 * Handle voice-related callbacks
 */
function handleCallback(bot, query, userState) {
  const data = query.data;
  const chatId = query.message.chat.id;

  // Voice mode selection (off/on/auto)
  if (data.startsWith('voicemode:')) {
    const mode = data.substring(10);
    userState.voiceMode = mode;
    scheduleSave();
    const modeIcons = { off: '🔇', on: '🔊', auto: '✨' };
    const modeNames = { off: 'OFF', on: 'ON', auto: 'AUTO' };
    bot.answerCallbackQuery(query.id, { text: `${modeIcons[mode]} Voice ${modeNames[mode]}` });
    bot.sendMessage(chatId, `${modeIcons[mode]} Voice *${modeNames[mode]}*`, { parse_mode: 'Markdown' });
    return true;
  }

  // Legacy voice toggle (for backwards compatibility)
  if (data.startsWith('voicetoggle:')) {
    const action = data.substring(12);
    userState.voiceMode = action === 'on' ? 'auto' : 'off';
    scheduleSave();
    const icon = userState.voiceMode === 'auto' ? '✨' : '🔇';
    const status = userState.voiceMode === 'auto' ? 'AUTO' : 'OFF';
    bot.answerCallbackQuery(query.id, { text: `${icon} Voice ${status}` });
    bot.sendMessage(chatId, `${icon} Voice *${status}*`, { parse_mode: 'Markdown' });
    return true;
  }

  // TTS engine selection
  if (data.startsWith('tts:')) {
    const engineId = data.substring(4);
    if (TTS_ENGINES[engineId]) {
      userState.voiceSettings.ttsEngine = engineId;
      scheduleSave();
      const engineInfo = TTS_ENGINES[engineId];
      bot.answerCallbackQuery(query.id, { text: `✅ ${engineInfo.name}` });
      bot.sendMessage(chatId, `${engineInfo.icon} TTS engine set to *${engineInfo.name}*\n_${engineInfo.description}_`, { parse_mode: 'Markdown' });
    }
    return true;
  }

  // Voice noop (section headers)
  if (data === 'voice:noop') {
    bot.answerCallbackQuery(query.id);
    return true;
  }

  // Edge voice selection
  if (data.startsWith('voice:en:') || data.startsWith('voice:he:')) {
    const parts = data.split(':');
    const lang = parts[1];
    const voiceId = parts[2];

    if (lang === 'en') {
      userState.voiceSettings.voice = voiceId;
      const voiceName = EDGE_VOICE_OPTIONS.english.find(v => v.id === voiceId)?.name || voiceId;
      bot.answerCallbackQuery(query.id, { text: `✅ English voice: ${voiceName}` });
      bot.sendMessage(chatId, `🎙 English voice set to *${voiceName}*`, { parse_mode: 'Markdown' });
    } else if (lang === 'he') {
      userState.voiceSettings.hebrewVoice = voiceId;
      const voiceName = EDGE_VOICE_OPTIONS.hebrew.find(v => v.id === voiceId)?.name || voiceId;
      bot.answerCallbackQuery(query.id, { text: `✅ Hebrew voice: ${voiceName}` });
      bot.sendMessage(chatId, `🎙 Hebrew voice set to *${voiceName}*`, { parse_mode: 'Markdown' });
    }
    scheduleSave();
    return true;
  }

  // Google voice/accent selection
  if (data.startsWith('googlevoice:')) {
    const tld = data.substring(12);
    userState.voiceSettings.googleTld = tld;
    scheduleSave();
    const accentName = GOOGLE_VOICE_OPTIONS.english.find(v => v.id === tld)?.name || tld;
    bot.answerCallbackQuery(query.id, { text: `✅ ${accentName}` });
    bot.sendMessage(chatId, `🔵 Google accent set to *${accentName}*`, { parse_mode: 'Markdown' });
    return true;
  }

  // Google Hebrew TLD
  if (data.startsWith('googlehebrew:')) {
    const tld = data.substring(13);
    userState.voiceSettings.googleHebrewTld = tld;
    scheduleSave();
    const voiceName = GOOGLE_VOICE_OPTIONS.hebrew.find(v => v.id === tld)?.name || tld;
    bot.answerCallbackQuery(query.id, { text: `✅ ${voiceName}` });
    bot.sendMessage(chatId, `🔵 Google Hebrew set to *${voiceName}*`, { parse_mode: 'Markdown' });
    return true;
  }

  // Google speed
  if (data.startsWith('googlespeed:')) {
    const speedId = data.substring(12);
    userState.voiceSettings.googleSlow = speedId === 'slow';
    scheduleSave();
    const speedName = speedId === 'slow' ? '🐢 Slow' : '🚗 Normal';
    bot.answerCallbackQuery(query.id, { text: `✅ ${speedName}` });
    bot.sendMessage(chatId, `🔵 Google speed set to *${speedName}*`, { parse_mode: 'Markdown' });
    return true;
  }

  // Speed selection
  if (data.startsWith('speed:')) {
    const speedId = data.substring(6);
    userState.voiceSettings.rate = speedId;
    scheduleSave();
    const speedName = SPEED_OPTIONS.find(s => s.id === speedId)?.name || speedId;
    bot.answerCallbackQuery(query.id, { text: `✅ Speed: ${speedName}` });
    bot.sendMessage(chatId, `⏩ Voice speed set to *${speedName}*`, { parse_mode: 'Markdown' });
    return true;
  }

  // Voice style selection (for auto voice mode)
  if (data.startsWith('voicestyle:') || data.startsWith('response:')) {
    const styleId = data.startsWith('voicestyle:') ? data.substring(11) : data.substring(9);
    userState.voiceSettings.responseLevel = styleId;
    scheduleSave();
    const styleName = VOICE_STYLE_OPTIONS.find(r => r.id === styleId)?.name || styleId;
    bot.answerCallbackQuery(query.id, { text: `✅ Voice: ${styleName}` });
    bot.sendMessage(chatId, `🎙 Voice style set to *${styleName}*`, { parse_mode: 'Markdown' });
    return true;
  }

  // Text style selection (for regular text)
  if (data.startsWith('textstyle:')) {
    const styleId = data.substring(10);
    userState.voiceSettings.textStyle = styleId;
    scheduleSave();
    const styleName = TEXT_STYLE_OPTIONS.find(t => t.id === styleId)?.name || styleId;
    bot.answerCallbackQuery(query.id, { text: `✅ Text: ${styleName}` });
    bot.sendMessage(chatId, `📝 Text style set to *${styleName}*`, { parse_mode: 'Markdown' });
    return true;
  }

  // Chunk preset selection
  if (data.startsWith('chunk:')) {
    const presetId = data.substring(6);
    if (VOICE_CHUNK_PRESETS[presetId]) {
      userState.voiceSettings.chunkPreset = presetId;
      scheduleSave();
      const preset = VOICE_CHUNK_PRESETS[presetId];
      bot.answerCallbackQuery(query.id, { text: `✅ ${preset.name}` });
      bot.sendMessage(chatId, `📦 Chunk preset set to ${preset.icon} *${preset.name}*\n_${preset.description}_`, { parse_mode: 'Markdown' });
    }
    return true;
  }

  // Command callbacks
  if (data === 'cmd:voice') {
    bot.answerCallbackQuery(query.id, { text: '/voice' });
    // Cycle through modes: off -> on -> auto -> off
    const mode = userState.voiceMode || 'off';
    const nextMode = { off: 'on', on: 'auto', auto: 'off' };
    userState.voiceMode = nextMode[mode];
    scheduleSave();
    const modeIcons = { off: '🔇', on: '🔊', auto: '✨' };
    const modeNames = { off: 'OFF', on: 'ON', auto: 'AUTO' };
    bot.sendMessage(chatId, `${modeIcons[userState.voiceMode]} Voice *${modeNames[userState.voiceMode]}*`, { parse_mode: 'Markdown' });
    return true;
  }

  if (data === 'cmd:tts') {
    bot.answerCallbackQuery(query.id, { text: '/tts' });
    const currentEngine = userState.voiceSettings.ttsEngine || 'edge';
    const keyboard = [];
    for (const [id, info] of Object.entries(TTS_ENGINES)) {
      const check = currentEngine === id ? '✓ ' : '';
      keyboard.push([{ text: `${check}${info.icon} ${info.name} - ${info.description}`, callback_data: `tts:${id}` }]);
    }
    const currentInfo = TTS_ENGINES[currentEngine];
    bot.sendMessage(chatId, `🔊 *TTS Engine*\n\nCurrent: ${currentInfo.icon} *${currentInfo.name}*\n_${currentInfo.description}_`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    return true;
  }

  if (data === 'cmd:setvoice') {
    bot.answerCallbackQuery(query.id, { text: '/setvoice' });
    sendVoiceSettingsMenu(bot, chatId, userState);
    return true;
  }

  if (data === 'cmd:setvoicespeed') {
    bot.answerCallbackQuery(query.id, { text: '/setvoicespeed' });
    sendSpeedMenu(bot, chatId, userState);
    return true;
  }

  if (data === 'cmd:voiceresponse' || data === 'cmd:voicestyle') {
    bot.answerCallbackQuery(query.id, { text: '/voicestyle' });
    sendVoiceStyleMenu(bot, chatId, userState);
    return true;
  }

  if (data === 'cmd:textstyle') {
    bot.answerCallbackQuery(query.id, { text: '/textstyle' });
    sendTextStyleMenu(bot, chatId, userState);
    return true;
  }

  if (data === 'cmd:voicechunk') {
    bot.answerCallbackQuery(query.id, { text: '/voicechunk' });
    sendChunkPresetMenu(bot, chatId, userState);
    return true;
  }

  return false;
}

module.exports = {
  register,
  handleCallback,
  sendVoiceSettingsMenu,
  sendSpeedMenu,
  sendVoiceStyleMenu,
  sendTextStyleMenu,
  sendResponseStyleMenu,  // backwards compatibility
  sendChunkPresetMenu
};

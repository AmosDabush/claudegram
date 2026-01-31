/**
 * Edge TTS Engine (Cloud - Best quality)
 */

const fs = require('fs');
const path = require('path');
const { EdgeTTS } = require('node-edge-tts');
const { BOT_DIR } = require('../config');
const { containsHebrew } = require('../utils');

/**
 * Generate TTS audio using Edge TTS
 */
async function generateVoice(cleanText, settings, onProgress = null) {
  const voice = containsHebrew(cleanText) ? settings.hebrewVoice : settings.voice;

  if (onProgress) {
    onProgress(`Edge TTS (${voice.split('-')[2].replace('Neural', '')})`);
  }

  console.log(`Voice [Edge]: generating with ${voice}, ${cleanText.length} chars`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const tts = new EdgeTTS({
        voice: voice,
        rate: settings.rate,
        pitch: settings.pitch,
        timeout: 30000
      });

      const audioPath = path.join(BOT_DIR, `temp_audio_${Date.now()}.mp3`);
      await tts.ttsPromise(cleanText, audioPath);

      if (!fs.existsSync(audioPath)) {
        console.log(`Voice [Edge]: audio file not created (attempt ${attempt})`);
        continue;
      }

      const buffer = fs.readFileSync(audioPath);
      // Clean up temp file immediately
      try { fs.unlinkSync(audioPath); } catch (e) {}

      console.log(`Voice [Edge]: success, ${buffer.length} bytes`);
      return { buffer, format: 'mp3' };
    } catch (err) {
      console.log(`Voice [Edge] error (attempt ${attempt}):`, err?.message || err);
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return null;
}

module.exports = { generateVoice };

/**
 * Coqui TTS Engine (Local - English only)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BOT_DIR, COQUI_MODELS } = require('../config');
const { containsHebrew } = require('../utils');

// Import Google TTS for Hebrew fallback
const googleTTS = require('./google');

/**
 * Generate TTS audio using Coqui TTS (local)
 */
async function generateVoice(cleanText, settings, onProgress = null) {
  // Coqui English model doesn't support Hebrew - fall back to Google
  if (containsHebrew(cleanText)) {
    console.log('Voice [Coqui]: Hebrew detected, falling back to Google TTS');
    return googleTTS.generateVoice(cleanText, settings, onProgress);
  }

  if (onProgress) {
    onProgress('Coqui TTS');
  }

  console.log(`Voice [Coqui]: generating, ${cleanText.length} chars`);

  return new Promise((resolve, reject) => {
    const audioPath = path.join(BOT_DIR, `temp_audio_${Date.now()}.wav`);
    const startTime = Date.now();

    const model = COQUI_MODELS.en;

    const proc = spawn('tts', [
      '--text', cleanText,
      '--model_name', model,
      '--out_path', audioPath
    ], { env: process.env });

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      if (code !== 0) {
        console.log(`Voice [Coqui] error: ${stderr.substring(0, 500)}`);
        reject(new Error('Coqui failed'));
        return;
      }

      if (!fs.existsSync(audioPath)) {
        reject(new Error('Coqui did not create output file'));
        return;
      }

      const buffer = fs.readFileSync(audioPath);
      // Clean up temp file immediately
      try { fs.unlinkSync(audioPath); } catch (e) {}

      console.log(`Voice [Coqui]: success in ${duration}ms, ${buffer.length} bytes`);
      resolve({ buffer, format: 'wav' });
    });

    proc.on('error', (err) => {
      reject(new Error(`Coqui TTS not found: ${err.message}`));
    });

    // Timeout (Coqui can be slow)
    setTimeout(() => {
      proc.kill();
      reject(new Error('Coqui timeout'));
    }, 120000);
  });
}

module.exports = { generateVoice };

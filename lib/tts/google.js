/**
 * Google TTS Engine (Cloud - Fast, Free)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BOT_DIR } = require('../config');
const { containsHebrew } = require('../utils');

/**
 * Generate TTS audio using Google TTS (gtts-cli)
 */
async function generateVoice(cleanText, settings, onProgress = null) {
  const isHebrew = containsHebrew(cleanText);
  const lang = isHebrew ? 'iw' : 'en';  // Google uses 'iw' for Hebrew
  const tld = isHebrew ? (settings.googleHebrewTld || 'co.il') : (settings.googleTld || 'com');
  const slow = settings.googleSlow || false;

  if (onProgress) {
    onProgress(`Google TTS (${lang}/${tld})`);
  }

  console.log(`Voice [Google]: generating, ${cleanText.length} chars, lang=${lang}, tld=${tld}, slow=${slow}`);

  return new Promise((resolve, reject) => {
    const audioPath = path.join(BOT_DIR, `temp_audio_${Date.now()}.mp3`);
    const startTime = Date.now();

    const args = [cleanText, '-l', lang, '--tld', tld, '-o', audioPath];
    if (slow) args.push('--slow');

    const proc = spawn('gtts-cli', args, { env: process.env });

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      if (code !== 0) {
        console.log(`Voice [Google] error: ${stderr}`);
        reject(new Error(`Google TTS failed: ${stderr}`));
        return;
      }

      if (!fs.existsSync(audioPath)) {
        reject(new Error('Google TTS did not create output file'));
        return;
      }

      const buffer = fs.readFileSync(audioPath);
      // Clean up temp file immediately
      try { fs.unlinkSync(audioPath); } catch (e) {}

      console.log(`Voice [Google]: success in ${duration}ms, ${buffer.length} bytes`);
      resolve({ buffer, format: 'mp3' });
    });

    proc.on('error', (err) => {
      reject(new Error(`gtts-cli not found: ${err.message}. Install with: pip3 install gtts`));
    });

    // Timeout
    setTimeout(() => {
      proc.kill();
      reject(new Error('Google TTS timeout'));
    }, 30000);
  });
}

module.exports = { generateVoice };

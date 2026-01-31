/**
 * Piper TTS Engine (Local - Fastest)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BOT_DIR, PIPER_MODELS } = require('../config');
const { containsHebrew } = require('../utils');

// Import Google TTS for Hebrew fallback
const googleTTS = require('./google');

/**
 * Generate TTS audio using Piper (local)
 */
async function generateVoice(cleanText, settings, onProgress = null) {
  const isHebrew = containsHebrew(cleanText);
  const model = isHebrew ? PIPER_MODELS.he : PIPER_MODELS.en;

  // Check if model exists
  if (!fs.existsSync(model)) {
    console.log(`Voice [Piper]: Model not found: ${model}`);
    if (isHebrew) {
      console.log('Voice [Piper]: Falling back to Google TTS for Hebrew');
      return googleTTS.generateVoice(cleanText, settings, onProgress);
    }
    throw new Error(`Piper model not found: ${model}`);
  }

  const lengthScale = settings.piperSpeed || 0.8;

  if (onProgress) {
    onProgress(`Piper (${path.basename(model).split('-')[0]})`);
  }

  console.log(`Voice [Piper]: generating with ${path.basename(model)}, ${cleanText.length} chars, speed=${lengthScale}`);

  return new Promise((resolve, reject) => {
    const audioPath = path.join(BOT_DIR, `temp_audio_${Date.now()}.wav`);
    const startTime = Date.now();

    const proc = spawn('piper', [
      '--model', model,
      '--output_file', audioPath,
      '--length-scale', lengthScale.toString()
    ], { env: process.env });

    proc.stdin.write(cleanText);
    proc.stdin.end();

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      if (code !== 0) {
        console.log(`Voice [Piper] error: ${stderr}`);
        reject(new Error(`Piper failed: ${stderr}`));
        return;
      }

      if (!fs.existsSync(audioPath)) {
        reject(new Error('Piper did not create output file'));
        return;
      }

      const buffer = fs.readFileSync(audioPath);
      // Clean up temp file immediately
      try { fs.unlinkSync(audioPath); } catch (e) {}

      console.log(`Voice [Piper]: success in ${duration}ms, ${buffer.length} bytes`);
      resolve({ buffer, format: 'wav' });
    });

    proc.on('error', (err) => {
      reject(new Error(`Piper not found: ${err.message}`));
    });

    // Timeout
    setTimeout(() => {
      proc.kill();
      reject(new Error('Piper timeout'));
    }, 30000);
  });
}

module.exports = { generateVoice };

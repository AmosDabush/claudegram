/**
 * TTS Main Module
 * Routes to correct engine, handles chunking with progress
 */

const { VOICE_CHUNK_PRESETS, DEFAULT_VOICE_SETTINGS } = require('../config');
const { cleanTextForTTS } = require('../utils');

// Import TTS engines
const edgeTTS = require('./edge');
const googleTTS = require('./google');
const piperTTS = require('./piper');
const coquiTTS = require('./coqui');

// Engine map
const engines = {
  edge: edgeTTS,
  google: googleTTS,
  piper: piperTTS,
  coqui: coquiTTS
};

/**
 * Split text into chunks based on preset
 * @param {string} text - Text to split
 * @param {string} presetName - Name of chunk preset (small, medium, large, xl, xxl, xxxl, none)
 * @returns {string[]} Array of text chunks
 */
function splitIntoChunks(text, presetName = 'medium') {
  const lines = text.split('\n').filter(line => line.trim().length > 0);

  // Handle 'none' preset - return full text as single chunk
  const preset = VOICE_CHUNK_PRESETS[presetName] || VOICE_CHUNK_PRESETS.medium;
  if (!preset.pattern) {
    return [lines.join('\n')];
  }

  const chunks = [];
  const { pattern, repeat } = preset;

  let lineIndex = 0;
  let chunkIndex = 0;

  while (lineIndex < lines.length) {
    // Get chunk size from pattern, or use repeat value for subsequent chunks
    const chunkSize = chunkIndex < pattern.length ? pattern[chunkIndex] : repeat;
    const chunkLines = lines.slice(lineIndex, lineIndex + chunkSize);

    if (chunkLines.length > 0) {
      chunks.push(chunkLines.join('\n'));
    }

    lineIndex += chunkSize;
    chunkIndex++;
  }

  return chunks;
}

/**
 * Generate TTS audio using selected engine
 * @param {string} text - Text to convert
 * @param {object} settings - Voice settings
 * @param {function} onProgress - Optional progress callback (receives status string)
 * @returns {Promise<{buffer: Buffer, format: string}>}
 */
async function generateVoice(text, settings = DEFAULT_VOICE_SETTINGS, onProgress = null) {
  console.log('Voice: Original text sample:', text.substring(0, 200));
  let cleanText = cleanTextForTTS(text);
  console.log('Voice: Cleaned text sample:', cleanText.substring(0, 200));

  // Limit length for TTS (max ~5000 chars)
  if (cleanText.length > 5000) {
    cleanText = cleanText.substring(0, 5000) + '... message truncated';
  }

  if (!cleanText || cleanText.length < 2) {
    console.log('Voice: text too short after cleaning');
    return null;
  }

  const engine = settings.ttsEngine || 'edge';
  const ttsModule = engines[engine] || engines.edge;

  console.log(`Voice: Using engine: ${engine}`);

  return ttsModule.generateVoice(cleanText, settings, onProgress);
}

/**
 * Generate TTS for text in chunks, calling callback for each chunk
 * Streams progress updates via onProgress callback
 *
 * @param {string} text - Full text to convert
 * @param {object} settings - Voice settings (includes chunkPreset)
 * @param {function} onChunkReady - Callback when chunk is ready: (buffer, format, chunkNum, totalChunks)
 * @param {function} onProgress - Progress callback: (statusText)
 */
async function generateVoiceChunked(text, settings, onChunkReady, onProgress = null) {
  const presetName = settings.chunkPreset || 'medium';
  const preset = VOICE_CHUNK_PRESETS[presetName] || VOICE_CHUNK_PRESETS.medium;
  const engineInfo = settings.ttsEngine || 'edge';

  // IMPORTANT: Split RAW text first (before cleaning), then clean each chunk
  // This preserves newlines for proper line-based splitting
  if (!text || text.trim().length < 2) {
    console.log('Voice [Chunked]: No text to process');
    return;
  }

  const chunks = splitIntoChunks(text, presetName);  // Split RAW text

  if (chunks.length === 0) {
    console.log('Voice [Chunked]: No chunks to process');
    return;
  }

  const isSingleChunk = chunks.length === 1;
  const chunkSizes = chunks.map((c, i) => `${i + 1}:${c.split('\n').length}L`).join(', ');

  console.log(`Voice [Chunked]: ${presetName} preset, ${chunks.length} chunks (${chunkSizes})`);

  if (onProgress) {
    if (isSingleChunk) {
      onProgress(`🎙 Processing full VM with ${engineInfo}...`);
    } else {
      onProgress(`🎙 Processing VM 1/${chunks.length} with ${engineInfo}...`);
    }
  }

  // Process chunks sequentially
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkNum = i + 1;

    try {
      // Update progress
      if (onProgress && !isSingleChunk) {
        onProgress(`🎙 Processing VM ${chunkNum}/${chunks.length} with ${engineInfo}...`);
      }

      console.log(`Voice [Chunked]: Generating chunk ${chunkNum}/${chunks.length} (${chunk.length} chars)`);

      const result = await generateVoice(chunk, settings, null);

      if (result && result.buffer) {
        await onChunkReady(result.buffer, result.format, chunkNum, chunks.length);
      }
    } catch (err) {
      console.log(`Voice [Chunked]: Error on chunk ${chunkNum}:`, err?.message || err);
      // Continue with next chunk even if one fails
    }
  }

  if (onProgress) {
    onProgress(null); // Signal completion
  }
}

/**
 * Get info about a chunk preset
 */
function getChunkPresetInfo(presetName) {
  return VOICE_CHUNK_PRESETS[presetName] || VOICE_CHUNK_PRESETS.medium;
}

/**
 * Get all chunk presets
 */
function getAllChunkPresets() {
  return VOICE_CHUNK_PRESETS;
}

/**
 * Estimate number of chunks for given text
 */
function estimateChunks(text, presetName = 'medium') {
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  const preset = VOICE_CHUNK_PRESETS[presetName] || VOICE_CHUNK_PRESETS.medium;

  if (!preset.pattern) return 1;

  let lineIndex = 0;
  let chunkCount = 0;
  let patternIndex = 0;

  while (lineIndex < lines.length) {
    const chunkSize = patternIndex < preset.pattern.length
      ? preset.pattern[patternIndex]
      : preset.repeat;
    lineIndex += chunkSize;
    chunkCount++;
    patternIndex++;
  }

  return chunkCount;
}

module.exports = {
  generateVoice,
  generateVoiceChunked,
  splitIntoChunks,
  getChunkPresetInfo,
  getAllChunkPresets,
  estimateChunks
};

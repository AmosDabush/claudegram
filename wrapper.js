#!/usr/bin/env node
/**
 * Bot Wrapper - Auto-restart on crash with try-catch
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BOT_DIR = __dirname;
const LOG_FILE = path.join(BOT_DIR, 'bot.log');
const MAX_RETRIES = 5;
const RETRY_DELAY = 3000; // 3 seconds

let retryCount = 0;
let lastCrashTime = 0;
let botProcess = null;

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[Wrapper ${timestamp}] ${msg}\n`;
  console.log(line.trim());
  fs.appendFileSync(LOG_FILE, line);
}

function startBot() {
  log(`Starting bot (attempt ${retryCount + 1}/${MAX_RETRIES})...`);

  botProcess = spawn('node', ['bot.js'], {
    cwd: BOT_DIR,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env
  });

  // Pipe stdout/stderr to log file
  botProcess.stdout.on('data', (data) => {
    fs.appendFileSync(LOG_FILE, data);
  });

  botProcess.stderr.on('data', (data) => {
    fs.appendFileSync(LOG_FILE, data);
  });

  botProcess.on('error', (err) => {
    log(`Bot process error: ${err.message}`);
    handleCrash();
  });

  botProcess.on('exit', (code, signal) => {
    if (code === 0) {
      log('Bot exited cleanly (code 0)');
      process.exit(0);
    } else {
      log(`Bot crashed with code ${code}, signal ${signal}`);
      handleCrash();
    }
  });

  log(`Bot started with PID ${botProcess.pid}`);
}

function handleCrash() {
  const now = Date.now();

  // Reset retry count if last crash was more than 5 minutes ago
  if (now - lastCrashTime > 5 * 60 * 1000) {
    retryCount = 0;
  }

  lastCrashTime = now;
  retryCount++;

  if (retryCount <= MAX_RETRIES) {
    log(`Restarting in ${RETRY_DELAY / 1000} seconds...`);
    setTimeout(startBot, RETRY_DELAY);
  } else {
    log(`Max retries (${MAX_RETRIES}) reached. Giving up.`);
    process.exit(1);
  }
}

// Handle signals to gracefully stop
process.on('SIGINT', () => {
  log('Received SIGINT, stopping bot...');
  if (botProcess) botProcess.kill('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Received SIGTERM, stopping bot...');
  if (botProcess) botProcess.kill('SIGTERM');
  process.exit(0);
});

// Start the bot
startBot();

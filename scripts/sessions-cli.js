#!/usr/bin/env node

/**
 * Terminal Session Manager
 * View and resume sessions from both Telegram and CLI
 *
 * Usage:
 *   sessions list              - Show all sessions
 *   sessions resume <id>       - Resume a session
 *   sessions telegram          - Show only Telegram sessions
 *   sessions cli               - Show only CLI sessions
 */

const path = require('path');

// Sync CLI sessions first
require('./watch-cli-sessions');

const { getAllSessions, getSessionsBySource, findSessionByShortId, formatTimeAgo, getModeIcon } = require('../lib/unified-sessions');

const command = process.argv[2];
const arg = process.argv[3];

switch (command) {
  case 'list':
  case 'ls':
  case undefined:
    listSessions();
    break;
  case 'resume':
  case 'r':
    resumeSession(arg);
    break;
  case 'telegram':
  case 'tg':
    listSessions('telegram');
    break;
  case 'cli':
  case 'terminal':
    listSessions('cli');
    break;
  case 'move':
  case 'to-telegram':
  case 'send':
    moveToTelegram(arg).catch(e => { console.error('❌', e.message); process.exit(1); });
    break;
  default:
    // If first arg looks like a session ID, try to resume it
    if (command && command.length >= 4) {
      resumeSession(command);
    } else {
      showHelp();
    }
}

function showHelp() {
  console.log(`
📋 Unified Session Manager

Usage:
  sessions                   List all sessions
  sessions list              List all sessions
  sessions resume <id>       Resume a session by ID prefix
  sessions telegram          Show only Telegram sessions
  sessions cli               Show only CLI sessions
  sessions move [id]         Send session to Telegram for resume
  sessions <id>              Resume session (shorthand)

Examples:
  sessions resume abc123
  sessions tg
  sessions move abc123       Send specific session to Telegram
  sessions move              Send most recent CLI session to Telegram
`);
}

function listSessions(filter) {
  const sessions = filter ? getSessionsBySource(filter) : getAllSessions();

  if (sessions.length === 0) {
    console.log('\n📭 No sessions found.\n');
    return;
  }

  console.log('\n📋 All Sessions\n');

  const telegram = filter === 'cli' ? [] : sessions.filter(s => s.source === 'telegram');
  const cli = filter === 'telegram' ? [] : sessions.filter(s => s.source === 'cli');

  if (telegram.length > 0) {
    console.log('📱 Telegram Sessions:');
    console.log('─'.repeat(50));
    telegram.forEach((s, i) => {
      const shortId = s.id.substring(0, 8);
      const timeAgo = formatTimeAgo(s.lastUsed);
      const modeIcon = getModeIcon(s.mode);
      const project = path.basename(s.projectPath);
      console.log(`  ${i + 1}. [${shortId}] ${s.topic} ${modeIcon}`);
      console.log(`     📁 ${project} | ${s.messageCount} msgs | ${timeAgo}`);
      console.log('');
    });
  }

  if (cli.length > 0) {
    console.log('🖥  Terminal Sessions:');
    console.log('─'.repeat(50));
    cli.forEach((s, i) => {
      const shortId = s.id.substring(0, 8);
      const timeAgo = formatTimeAgo(s.lastUsed);
      const project = path.basename(s.projectPath);
      console.log(`  ${i + 1}. [${shortId}] ${s.topic}`);
      console.log(`     📁 ${project} | ${s.messageCount} msgs | ${timeAgo}`);
      console.log('');
    });
  }

  console.log('To resume: sessions resume <id>');
  console.log('');
}

function resumeSession(idPrefix) {
  if (!idPrefix) {
    console.error('❌ Please provide a session ID (or prefix)');
    process.exit(1);
  }

  const session = findSessionByShortId(idPrefix);

  if (!session) {
    console.error(`❌ Session not found: ${idPrefix}`);
    console.log('Run "sessions list" to see available sessions.');
    process.exit(1);
  }

  const sourceIcon = session.source === 'telegram' ? '📱' : '🖥';
  console.log(`\n${sourceIcon} Resuming: ${session.topic}`);
  console.log(`   Path: ${session.projectPath}`);
  console.log(`   Mode: ${session.mode}`);

  // Build resume command
  const flags = (session.flags || []).join(' ');
  const cmd = `cd "${session.projectPath}" && claude --resume '${session.id}' ${flags}`.trim();

  console.log(`\n   Command:\n   ${cmd}\n`);

  // Execute
  const { execSync } = require('child_process');
  try {
    execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });
  } catch (error) {
    // Don't show error for normal exit
    if (error.status !== 0 && error.status !== null) {
      console.error('\n❌ Session ended with error');
      process.exit(1);
    }
  }
}

async function moveToTelegram(idPrefix) {
  const { summarizeSession, encodeProjectPath } = require('../lib/sessions');
  const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME || require('os').homedir(), '.claude', 'projects');

  let session;

  if (idPrefix) {
    session = findSessionByShortId(idPrefix);
    if (!session) {
      console.error(`❌ Session not found: ${idPrefix}`);
      process.exit(1);
    }
  } else {
    // Use most recent CLI session
    const cliSessions = getAllSessions().filter(s => s.source === 'cli');
    if (cliSessions.length === 0) {
      console.error('❌ No CLI sessions found');
      process.exit(1);
    }
    session = cliSessions[0];
  }

  const project = path.basename(session.projectPath);
  const shortId = session.id.substring(0, 8);

  // Generate AI summary
  const encodedPath = encodeProjectPath(session.projectPath);
  const sessionFile = path.join(CLAUDE_PROJECTS_DIR, encodedPath, `${session.id}.jsonl`);

  let summary = session.topic;
  const fs = require('fs');
  if (fs.existsSync(sessionFile)) {
    console.log('🤖 Generating summary...');
    summary = await summarizeSession(sessionFile);
  }

  // Escape Markdown special chars in summary
  const safeSummary = summary.replace(/[*_`\[\]]/g, '');

  const message = [
    '🖥 *Session from Terminal*',
    '',
    `📝 *${safeSummary}*`,
    `📁 Project: ${project}`,
    `💬 Messages: ${session.messageCount}`,
    '',
    'Use /sessions to resume this session here.',
    `Session ID: ${shortId}`
  ].join('\n');

  // Save summary back to unified registry
  const { updateSession } = require('../lib/unified-sessions');
  updateSession(session.id, { topic: summary });

  console.log(`\n📱 Sending to Telegram: ${summary}`);

  // Use Telegram API directly to avoid shell escaping issues
  const https = require('https');

  // Load .env
  const envPath = path.join(__dirname, '..', '.env');
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const env = {};
  envContent.split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && vals.length) env[key.trim()] = vals.join('=').trim();
  });

  const botToken = env.BOT_TOKEN;
  const chatId = env.OWNER_CHAT_ID || env.ALLOWED_USER_IDS?.split(',')[0]?.trim();

  if (!botToken || !chatId) {
    console.error('❌ BOT_TOKEN or ALLOWED_USER_IDS not found in .env');
    process.exit(1);
  }

  const postData = JSON.stringify({
    chat_id: chatId,
    text: message,
    parse_mode: 'Markdown'
  });

  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${botToken}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, (res) => {
    if (res.statusCode === 200) {
      console.log('✅ Sent! Open Telegram and use /sessions to resume.\n');
    } else {
      console.error(`❌ Telegram API error: ${res.statusCode}`);
    }
  });

  req.on('error', (e) => {
    console.error('❌ Failed to send:', e.message);
    process.exit(1);
  });

  req.write(postData);
  req.end();
}

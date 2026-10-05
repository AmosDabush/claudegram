#!/usr/bin/env node

/**
 * Interactive Setup Wizard for Claude Telegram Bot
 *
 * This script guides users through first-time setup:
 * - Checks dependencies (Node.js, Claude CLI)
 * - Creates .env file interactively
 * - Validates configuration
 * - Provides helpful next steps
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const readline = require('readline');

// The same module the bot uses to find things on disk. Setup asking the question a
// different way is how you get a wizard that passes and a bot that cannot start.
const platform = require('./lib/platform');

const IS_WIN = process.platform === 'win32';

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Promisify readline question
function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

function print(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function printHeader(text) {
  console.log('\n' + '='.repeat(60));
  print(`  ${text}`, 'bright');
  console.log('='.repeat(60) + '\n');
}

/**
 * Is this command on PATH?
 *
 * `which` is not a Windows command. cmd and PowerShell both have `where`, and Git Bash
 * ships a `which` that only sees its own PATH — so a wizard that hardcodes `which`
 * reports every dependency missing on Windows and exits before asking anything. The
 * first thing a Windows user saw of this project was it telling them Node is not
 * installed, from inside Node.
 */
function checkCommand(command) {
  try {
    execSync(`${IS_WIN ? 'where' : 'which'} ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** npm is npm.cmd on Windows, and spawn() without a shell will not find it otherwise. */
const NPM = IS_WIN ? 'npm.cmd' : 'npm';

function getCommandVersion(command, flag = '--version') {
  try {
    const output = execSync(`${command} ${flag}`, { encoding: 'utf-8' });
    return output.trim();
  } catch {
    return 'unknown';
  }
}

async function checkDependencies() {
  printHeader('📋 Checking Dependencies');

  let allGood = true;

  // Check Node.js
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0]);

  if (nodeMajor >= 18) {
    print(`✅ Node.js ${nodeVersion} (OK)`, 'green');
  } else {
    print(`❌ Node.js ${nodeVersion} (need 18+)`, 'red');
    print('   Install from: https://nodejs.org/', 'yellow');
    allGood = false;
  }

  // Check npm
  if (checkCommand('npm', 'npm')) {
    const npmVersion = getCommandVersion('npm');
    print(`✅ npm ${npmVersion}`, 'green');
  } else {
    print(`❌ npm not found`, 'red');
    allGood = false;
  }

  // Check Claude CLI, by asking the module the bot asks.
  //
  // Not `which claude`: on Windows that finds the claude.cmd shim npm puts on PATH, and
  // a .cmd can only be run through a shell, which mangles every argument with a space in
  // it. The bot needs the real executable, so the check has to be for the real one too —
  // otherwise setup passes and the first message to Claude arrives as a single word.
  const claudePath = platform.claudeBin();
  if (path.isAbsolute(claudePath) && fs.existsSync(claudePath)) {
    print(`✅ Claude CLI ${getCommandVersion(`"${claudePath}"`)}`, 'green');
    print(`   at ${claudePath}`, 'cyan');
  } else if (checkCommand('claude')) {
    print(`⚠️  Claude CLI is on PATH but not where the bot looks for it`, 'yellow');
    print('   Setup will write CLAUDE_BIN_PATH below; point it at the folder holding', 'cyan');
    print(`   ${IS_WIN ? 'claude.exe' : 'claude'} itself, not the npm shim.`, 'cyan');
  } else {
    print(`❌ Claude CLI not found`, 'red');
    print('   Install from: https://github.com/anthropics/claude-code', 'yellow');
    print('   Or run: npm install -g @anthropic-ai/claude-code', 'yellow');
    allGood = false;
  }

  // Check optional: edge-tts (for voice)
  if (checkCommand('edge-tts', 'Edge TTS')) {
    print(`✅ edge-tts (optional, for voice features)`, 'green');
  } else {
    print(`⚠️  edge-tts not found (optional - only needed for voice)`, 'yellow');
    print('   Install: pip install edge-tts', 'cyan');
  }

  return allGood;
}

async function getBotToken() {
  printHeader('🤖 Telegram Bot Token');

  print('You need to create a Telegram bot to get a token.\n', 'cyan');
  print('Steps:', 'bright');
  print('1. Open Telegram and search for @BotFather');
  print('2. Send: /newbot');
  print('3. Follow instructions to create your bot');
  print('4. Copy the token BotFather gives you');
  print('5. Paste it here\n');

  let token = '';
  while (!token) {
    token = await question('Enter your bot token: ');
    token = token.trim();

    if (!token) {
      print('❌ Token cannot be empty', 'red');
    } else if (!token.match(/^\d+:[A-Za-z0-9_-]+$/)) {
      print('❌ Invalid token format. Should look like: 1234567890:ABCdefGhIjKlmNoPqRsTuVwXyZ', 'red');
      token = '';
    }
  }

  return token;
}

async function getUserIds() {
  printHeader('🆔 Telegram User ID');

  print('You need your Telegram user ID so only YOU can use the bot.\n', 'cyan');
  print('Steps:', 'bright');
  print('1. In Telegram, search for @userinfobot');
  print('2. Start a chat with it');
  print('3. It will reply with your user ID');
  print('4. Copy the ID number');
  print('5. Paste it here\n');

  let userIds = '';
  while (!userIds) {
    userIds = await question('Enter your Telegram user ID: ');
    userIds = userIds.trim();

    if (!userIds) {
      print('❌ User ID cannot be empty', 'red');
    } else if (!userIds.match(/^\d+(,\d+)*$/)) {
      print('❌ Invalid format. Enter numbers only (or comma-separated for multiple: 123,456)', 'red');
      userIds = '';
    }
  }

  return userIds;
}

async function getClaudeBinPath() {
  printHeader('📍 Claude CLI Path');

  // platform.claudeBin() is what the bot itself calls, and it already knows the places
  // Claude installs on each OS. Asking it here means setup cannot detect one path while
  // the bot looks in another. The old code ran `which claude` and fell back to a literal
  // '~/.local/bin' when HOME was unset — which is always, on Windows.
  const detected = platform.claudeBin();
  if (path.isAbsolute(detected) && fs.existsSync(detected)) {
    const dir = path.dirname(detected);
    print(`Found Claude CLI in: ${dir}`, 'green');
    const useDetected = await question('Use this? (Y/n): ');
    if (useDetected.toLowerCase() !== 'n' && useDetected.toLowerCase() !== 'no') return dir;
  } else {
    print('Could not find the Claude CLI automatically.', 'yellow');
    print(`Looking for ${IS_WIN ? 'claude.exe' : 'claude'} in the usual places turned up nothing.\n`, 'yellow');
  }

  const fallback = IS_WIN
    ? path.join(platform.HOME, 'AppData', 'Roaming', 'npm', 'node_modules',
                '@anthropic-ai', 'claude-code', 'bin')
    : path.join(platform.HOME, '.local', 'bin');

  print(`Default: ${fallback}`, 'cyan');
  const usePath = await question('Press Enter for that, or type the folder holding the executable: ');

  return usePath.trim() || fallback;
}

/**
 * The second bot: one supergroup, one topic per session.
 *
 * It has to be a second bot, not the same one twice. Telegram serves getUpdates to one
 * consumer per token, so a single token cannot poll for a direct chat and a group at
 * once — the two fight and both get 409s.
 *
 * The group chat id is the part nobody can look up by hand, so it is detected rather than
 * asked for: once the bot is in the group and anything has been said, the id is in the
 * first update it receives.
 */
function callTelegram(token, method, params = {}) {
  const https = require('https');
  return new Promise((resolve) => {
    const body = JSON.stringify(params);
    const req = https.request({
      host: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ ok: false, description: 'bad response' }); }
      });
    });
    req.on('error', err => resolve({ ok: false, description: err.message }));
    req.end(body);
  });
}

async function detectGroupChat(token) {
  print('\nWaiting for a message in the group...', 'cyan');
  print('(send anything in any topic there — this reads it and stops)\n');

  for (let attempt = 0; attempt < 30; attempt++) {
    const updates = await callTelegram(token, 'getUpdates', { timeout: 0, limit: 20 });
    if (updates.ok) {
      for (const update of updates.result || []) {
        const msg = update.message || update.edited_message || update.channel_post;
        const chat = msg && msg.chat;
        if (chat && (chat.type === 'supergroup' || chat.type === 'group')) {
          print(`✅ Found the group: "${chat.title}" (${chat.id})`, 'green');
          if (chat.type === 'group') {
            print('⚠️  That is a plain group, not a supergroup — topics need a supergroup', 'yellow');
            print('   In Telegram: group settings → enable Topics. It converts automatically.', 'cyan');
          } else if (!chat.is_forum) {
            print('⚠️  Topics are off in that group, so every session would share one thread', 'yellow');
            print('   In Telegram: group settings → Topics → on', 'cyan');
          }
          return String(chat.id);
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  print('⚠️  Nothing arrived in 60 seconds.', 'yellow');
  return null;
}

async function getGroupBot() {
  printHeader('👥 Second bot: a topic per session (optional)');

  print('This is what lets you run several Claude sessions at once, each in its own', 'cyan');
  print('Telegram topic, instead of one conversation in the direct chat.\n', 'cyan');
  print('It needs a SECOND bot. Telegram only lets one connection poll a token, so one', 'bright');
  print('bot cannot serve both the direct chat and the group.\n', 'bright');

  const wanted = await question('Set it up now? (y/N): ');
  if (wanted.toLowerCase() !== 'y' && wanted.toLowerCase() !== 'yes') {
    print('Skipped. The direct chat works without it; rerun setup to add it later.', 'cyan');
    return { groupToken: '', groupChat: '' };
  }

  print('\nSteps, in Telegram:', 'bright');
  print('1. @BotFather → /newbot → make a SECOND bot, and copy its token');
  print('2. Create a group, open its settings and turn Topics ON');
  print('3. Add the new bot to that group');
  print('4. Make it an admin, with "Manage Topics" allowed');
  print('5. Turn Group Privacy OFF for it: @BotFather → /mybots → the new bot →');
  print('   Bot Settings → Group Privacy → Turn off');
  print('   (with privacy on, it only receives messages that start with a slash)\n');

  let groupToken = '';
  while (!groupToken) {
    groupToken = (await question('Paste the second bot token (or Enter to skip): ')).trim();
    if (!groupToken) return { groupToken: '', groupChat: '' };
    if (!groupToken.match(/^\d+:[A-Za-z0-9_-]+$/)) {
      print('❌ That does not look like a token. Expected 1234567890:ABCdef...', 'red');
      groupToken = '';
    }
  }

  const me = await callTelegram(groupToken, 'getMe');
  if (!me.ok) {
    print(`❌ Telegram rejected that token: ${me.description}`, 'red');
    return { groupToken: '', groupChat: '' };
  }
  print(`✅ Token belongs to @${me.result.username}`, 'green');

  let groupChat = await detectGroupChat(groupToken);
  if (!groupChat) {
    groupChat = (await question('Enter the group chat id by hand (or Enter to skip): ')).trim();
  }

  // Being an admin is not optional here: without Manage Topics it cannot open a topic for
  // a session, and the failure only shows up much later, as a refusal from Telegram.
  if (groupChat) {
    const member = await callTelegram(groupToken, 'getChatMember', { chat_id: Number(groupChat), user_id: me.result.id });
    if (member.ok && member.result.status !== 'administrator') {
      print('⚠️  The bot is in the group but is not an admin — it cannot create topics', 'yellow');
      print('   Group settings → Administrators → add it, with "Manage Topics"', 'cyan');
    } else if (member.ok && !member.result.can_manage_topics) {
      print('⚠️  It is an admin but without "Manage Topics", so it cannot open one', 'yellow');
    } else if (member.ok) {
      print('✅ Admin, with Manage Topics', 'green');
    }
  }

  return { groupToken, groupChat };
}

/**
 * Where new topic sessions get their folders.
 *
 * Each topic needs one of its own, because Claude keeps session history per folder:
 * two topics sharing a folder share a history and answer into each other.
 *
 * Asked rather than assumed. The default used to be ~/git/telegram-topics, which is
 * only sensible if you keep your repositories in ~/git — a layout the author has and
 * most people do not. Anybody who does keep one will recognise it in the prompt and
 * type it; everybody else gets a folder in their home directory and never thinks
 * about it again.
 */
async function getChatsDir(hasGroupBot) {
  const fallback = path.join(platform.HOME, 'claudegram-topics');
  if (!hasGroupBot) return fallback;

  printHeader('📁 Where topic sessions live');

  print('Every topic gets its own folder here, and Claude runs in it. It is the working', 'cyan');
  print('directory for that conversation, so point it wherever you keep code.\n', 'cyan');
  print(`Default: ${fallback}`, 'cyan');

  const answer = (await question('Press Enter for that, or type a folder: ')).trim();
  const dir = answer ? answer.replace(/^~/, platform.HOME) : fallback;

  try {
    fs.mkdirSync(dir, { recursive: true });
    print(`✅ ${dir}`, 'green');
  } catch (e) {
    print(`⚠️  Could not create ${dir}: ${e.message}`, 'yellow');
    print('   The bot will try again when it first needs it.', 'cyan');
  }

  return dir;
}

/**
 * More than one machine in the same group.
 *
 * Only asked when somebody says they have a second machine, because for one machine
 * every answer here is a default and the question is noise.
 *
 * Two things go wrong if this is skipped by somebody who does have two. Telegram serves
 * getUpdates to one consumer per token, so a second machine that copies the first one's
 * .env verbatim starts a second poll loop and the two fight until both get 409s — the
 * machine that was working breaks because somebody set up a laptop. And with no fallback
 * agreed between them, both claim every topic nobody bound and answer it twice.
 */
async function getMachineIdentity(hasGroupBot) {
  if (!hasGroupBot) return {};

  printHeader('🖥  A second machine (optional)');

  print('Skip this if the bot will only ever run on this one computer.\n', 'cyan');
  print('If you run it on two — a desktop and a laptop, a Mac and a PC — they share the', 'cyan');
  print('group, and each topic is pinned to the machine that should answer it.\n', 'cyan');

  const wanted = await question('Will you run this on more than one machine? (y/N): ');
  if (wanted.toLowerCase() !== 'y' && wanted.toLowerCase() !== 'yes') {
    print('Skipped. Everything runs here, which is what one machine means.', 'cyan');
    return {};
  }

  const suggested = IS_WIN ? 'windows' : process.platform === 'darwin' ? 'mac' : require('os').hostname();
  print(`\nWhat is THIS machine called? It is a label on a button, so make it readable.`, 'cyan');
  const hostName = (await question(`Name (Enter for "${suggested}"): `)).trim() || suggested;

  print('\nThe others, and how to reach them over ssh. One per line is not supported —', 'cyan');
  print('use commas:  mac=you@studio.local,laptop=you@192.168.1.40', 'cyan');
  print('(Enter to leave blank and fill it in later.)', 'cyan');
  const remoteHosts = (await question('Other machines: ')).trim();

  print('\nLast one. When a topic has never been told which machine it belongs to,', 'cyan');
  print('exactly one machine has to pick it up, or both answer it twice. Put the SAME', 'bright');
  print('name here on every machine — usually whichever one is always on.\n', 'bright');
  const fallback = (await question(`Which machine answers unclaimed topics? (Enter for "${hostName}"): `)).trim() || hostName;

  // The group token is the one that cannot be shared. Say so here rather than letting it
  // be discovered as a 409 loop at two in the morning.
  print('\nOn the OTHER machine, copy this .env but set GROUP_BOT_SEND_ONLY=1 there.', 'yellow');
  print('Only one machine may poll the group token. The other can still push sessions', 'yellow');
  print('into topics — that goes over plain HTTPS and never polls.\n', 'yellow');

  return { hostName, remoteHosts, fallbackHost: fallback };
}

async function createEnvFile(config) {
  const envPath = path.join(__dirname, '.env');

  // Check if .env already exists
  if (fs.existsSync(envPath)) {
    print('\n⚠️  .env file already exists!', 'yellow');
    const overwrite = await question('Overwrite it? (y/N): ');

    if (overwrite.toLowerCase() !== 'y' && overwrite.toLowerCase() !== 'yes') {
      print('Keeping existing .env file.', 'cyan');
      return false;
    }

    // Backup existing
    const backupPath = `${envPath}.backup.${Date.now()}`;
    fs.copyFileSync(envPath, backupPath);
    print(`Backed up existing .env to: ${backupPath}`, 'cyan');
  }

  // Everything, not just what was asked about.
  //
  // This used to write five keys. The optional two thirds of the file — voice notes, the
  // workspace folder, the second machine — existed only in .env.example, which nobody
  // opens again after copying it once. A setting you cannot find is a setting you do not
  // have, so the generated file carries all of them, commented, with the answers filled
  // in where there were answers.
  const envContent = `# Claudegram configuration
# Written by \`node setup.js\` on ${new Date().toISOString()}
#
# Everything optional is listed here too, commented, so you can find it later without
# going back to .env.example. The bot re-reads this file only on restart.

# ── Direct chat ──────────────────────────────────────────────────────────────
# Your bot token from @BotFather.
BOT_TOKEN=${config.botToken}

# Telegram user ids allowed to talk to it, comma separated. Everyone else is ignored.
# Get yours from @userinfobot.
ALLOWED_USER_IDS=${config.userIds}

# The folder holding the claude executable itself — not the npm shim.
CLAUDE_BIN_PATH=${config.claudePath}

# macOS only: keep the machine awake while there has been activity within this many
# hours, then let it sleep. Ignored on Windows.
IDLE_TIMEOUT_HOURS=24

# ── Second bot: a topic per session ──────────────────────────────────────────
# A DIFFERENT bot from BOT_TOKEN. Telegram serves getUpdates to one consumer per
# token, so one bot cannot serve the direct chat and the group at once — they fight
# and both get 409s. Leave blank to run with the direct chat alone.
GROUP_BOT_TOKEN=${config.groupToken || ''}

# The supergroup it lives in, e.g. -1001234567890.
GROUP_CHAT_ID=${config.groupChat || ''}

# Hold the group token without listening on it. Set this to 1 on every machine
# EXCEPT the one that answers in the group. A machine with this on can still push a
# session into a topic; it just never polls.
GROUP_BOT_SEND_ONLY=${config.sendOnly || ''}

# ── More than one machine ────────────────────────────────────────────────────
# What this machine is called. A label on buttons and in lists.
HOST_NAME=${config.hostName || ''}

# The others, as name=ssh-destination, comma separated.
#   REMOTE_HOSTS=mac=you@studio.local,laptop=you@192.168.1.40
REMOTE_HOSTS=${config.remoteHosts || ''}

# Which machine picks up a topic that was never bound to one. Must read the SAME on
# every machine, or both answer the same topic twice. Empty means this one.
GROUP_FALLBACK_HOST=${config.fallbackHost || ''}

# ── Topic workspaces ─────────────────────────────────────────────────────────
# Base folder for new topic sessions — each topic gets a subfolder, because Claude
# keeps its history per folder. Topics created before you change this keep the
# folder already recorded for them.
CLAUDEGRAM_CHATS_DIR=${config.chatsDir || ''}

# ── Voice notes in (optional, off by default) ────────────────────────────────
# Send a voice message and it is transcribed locally and treated as if typed.
# Nothing leaves the machine. Turned on per chat from the settings panel, which
# checks the host first and names what is missing: \`pip install faster-whisper\`
# and ffmpeg on PATH. The model downloads itself on first use.
#
# Whichever python has faster-whisper. Defaults to \`python\` on Windows, \`python3\` elsewhere.
STT_PYTHON=
# tiny | base | small | medium | large-v3. Uses a CUDA card if it finds one, else CPU.
# medium is the sweet spot on a GPU, small stays usable on CPU alone.
STT_MODEL=medium
# Spoken language of your voice notes.
STT_LANG=he
# Load the model at startup instead of on the first voice note. Costs memory
# permanently, saves a warmup that can be half a minute on a cold GPU.
STT_PRELOAD=0
# Drop the model after this many idle minutes. 0 keeps it loaded forever.
STT_IDLE_MINUTES=20

# ── Optional ─────────────────────────────────────────────────────────────────
# A session /resume_pinned falls back to. Nothing is pinned unless set here or
# with /pin in the bot.
PINNED_SESSION_ID=
PINNED_SESSION_PATH=
`;

  fs.writeFileSync(envPath, envContent);
  print('✅ Created .env file', 'green');

  return true;
}

async function installDependencies() {
  printHeader('📦 Installing Dependencies');

  const install = await question('Install npm packages now? (Y/n): ');

  if (install && install.toLowerCase() === 'n') {
    print('Skipped. Run "npm install" manually later.', 'yellow');
    return false;
  }

  print('\nInstalling... This may take a minute.\n', 'cyan');

  return new Promise((resolve) => {
    // NPM, not 'npm': on Windows the thing on PATH is npm.cmd, and spawn() without a
    // shell does not append extensions. Plain 'npm' here failed with ENOENT, which
    // reads as "npm is not installed" three lines after setup said it was.
    const npm = spawn(NPM, ['install'], {
      stdio: 'inherit',
      cwd: __dirname
    });

    npm.on('close', (code) => {
      if (code === 0) {
        print('\n✅ Dependencies installed successfully', 'green');
        resolve(true);
      } else {
        print('\n❌ Installation failed. Try running "npm install" manually.', 'red');
        resolve(false);
      }
    });
  });
}

async function testBot() {
  printHeader('🧪 Testing Bot');

  const test = await question('Start the bot to test? (Y/n): ');

  if (test && test.toLowerCase() === 'n') {
    print('Skipped. Run "./start.sh" manually to start the bot.', 'yellow');
    return;
  }

  print('\nStarting bot... Check your Telegram!', 'cyan');
  print('Send /start to your bot to test.\n', 'cyan');
  print('Press Ctrl+C to stop the bot when done testing.\n', 'yellow');

  const bot = spawn('node', ['bot.js'], {
    stdio: 'inherit',
    cwd: __dirname,
    env: { ...process.env }
  });

  // Wait for Ctrl+C
  await new Promise((resolve) => {
    process.on('SIGINT', () => {
      bot.kill();
      resolve();
    });
  });
}

async function printNextSteps(config) {
  printHeader('🎉 Setup Complete!');

  print('Your bot is configured and ready to use.\n', 'green');

  // There is no ./start.sh on Windows, and telling somebody to run one is how a finished
  // setup ends in a file-not-found.
  const startCmd = IS_WIN ? '.\\start.ps1' : './start.sh';

  print('Next steps:', 'bright');
  print('1. Start the bot:', 'cyan');
  print(`   ${startCmd}\n`);

  print('2. Open Telegram and find your bot', 'cyan');
  print('   (search for the username you gave it)\n');

  print('3. Send /start to begin', 'cyan');
  print('   Try: /help for commands\n');

  print('4. Explore features:', 'cyan');
  print('   • Send any message → Ask Claude');
  print('   • /projects → Quick directory navigation');
  print('   • /settings → Configure the bot');
  print('   • /voice → Enable voice responses\n');

  if (config && config.groupToken) {
    print('5. In the group, open a topic and say something:', 'cyan');
    print('   each topic is its own session, with its own folder and its own history.');
    print(`   New topics get a folder under ${config.chatsDir}\n`);
  }

  print('Documentation:', 'bright');
  print('• Install, from nothing: SETUP.md');
  print('• What it can do: README.md');
  print('• Commands: docs/COMMANDS.md, or /all in Telegram');
  print('• How it works inside: ARCHITECTURE.md\n');

  print('Need help?', 'bright');
  print(`• Logs: ${IS_WIN ? 'Get-Content bot.log -Wait -Tail 40' : 'tail -f bot.log'}`);
  print('• Check your setup any time: node scripts/doctor.js');
  print('• Issues: https://github.com/AmosDabush/claudegram/issues\n');

  print('Enjoy your Claude Telegram Bot! 🚀', 'green');
}

async function main() {
  console.clear();

  print(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║         Claude Telegram Bot - Setup Wizard                ║
║                                                           ║
║  This will guide you through first-time setup            ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`, 'cyan');

  print('\nWelcome! Let\'s get your bot up and running.\n', 'bright');

  try {
    // Step 1: Check dependencies
    const depsOk = await checkDependencies();

    if (!depsOk) {
      print('\n❌ Please install missing dependencies first, then run setup again.', 'red');
      print('Run: node setup.js\n', 'yellow');
      rl.close();
      process.exit(1);
    }

    // Step 2: Get bot configuration
    const botToken = await getBotToken();
    const userIds = await getUserIds();
    const claudePath = await getClaudeBinPath();
    const { groupToken, groupChat } = await getGroupBot();
    const chatsDir = await getChatsDir(Boolean(groupToken));
    const machine = await getMachineIdentity(Boolean(groupToken));

    const config = {
      botToken,
      userIds,
      claudePath,
      groupToken,
      groupChat,
      chatsDir,
      hostName: machine.hostName,
      remoteHosts: machine.remoteHosts,
      fallbackHost: machine.fallbackHost
    };

    // Step 3: Create .env file
    await createEnvFile(config);

    // Step 4: Install dependencies
    const installed = await installDependencies();

    if (!installed) {
      print('\n⚠️  Remember to run "npm install" before starting the bot.', 'yellow');
    }

    // Step 5: Optional test
    // await testBot(); // Commented out - can be overwhelming

    // Step 6: Done!
    await printNextSteps(config);

  } catch (error) {
    print(`\n❌ Setup failed: ${error.message}`, 'red');
    print('Please try again or check the documentation.\n', 'yellow');
  }

  rl.close();
}

// Run setup
if (require.main === module) {
  main();
}

module.exports = { main };

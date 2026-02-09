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

function checkCommand(command, name) {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

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

  // Check Claude CLI
  if (checkCommand('claude', 'Claude CLI')) {
    const claudeVersion = getCommandVersion('claude', '--version');
    print(`✅ Claude CLI ${claudeVersion}`, 'green');
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

  // Try to detect automatically
  const defaultPath = process.env.HOME ? `${process.env.HOME}/.local/bin` : '~/.local/bin';

  let detectedPath = '';
  try {
    detectedPath = execSync('which claude', { encoding: 'utf-8' }).trim();
    detectedPath = path.dirname(detectedPath);
  } catch {
    // Not found
  }

  if (detectedPath) {
    print(`Detected Claude CLI at: ${detectedPath}`, 'green');
    const useDetected = await question(`Use this path? (Y/n): `);

    if (!useDetected || useDetected.toLowerCase() === 'y' || useDetected.toLowerCase() === 'yes') {
      return detectedPath;
    }
  }

  print(`\nDefault path: ${defaultPath}`, 'cyan');
  const usePath = await question(`Press Enter for default, or type custom path: `);

  return usePath.trim() || defaultPath;
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

  const envContent = `# Telegram Bot Configuration
# Generated by setup wizard on ${new Date().toISOString()}

# Your bot token from @BotFather
BOT_TOKEN=${config.botToken}

# Your Telegram user ID(s) - only these users can access the bot
# Get from @userinfobot on Telegram
ALLOWED_USER_IDS=${config.userIds}

# Idle timeout for caffeinate (hours)
# Bot keeps Mac awake only when there's been activity within this time
IDLE_TIMEOUT_HOURS=24

# Claude CLI binary path
# Path to directory containing claude executable
CLAUDE_BIN_PATH=${config.claudePath}
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
    const npm = spawn('npm', ['install'], {
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

async function printNextSteps() {
  printHeader('🎉 Setup Complete!');

  print('Your bot is configured and ready to use.\n', 'green');

  print('Next steps:', 'bright');
  print('1. Start the bot:', 'cyan');
  print('   ./start.sh\n');

  print('2. Open Telegram and find your bot', 'cyan');
  print('   (search for the username you gave it)\n');

  print('3. Send /start to begin', 'cyan');
  print('   Try: /help for commands\n');

  print('4. Explore features:', 'cyan');
  print('   • Send any message → Ask Claude');
  print('   • /projects → Quick directory navigation');
  print('   • /settings → Configure the bot');
  print('   • /voice → Enable voice responses\n');

  print('Documentation:', 'bright');
  print('• Full guide: README.md');
  print('• Commands: /all (in Telegram)');
  print('• Troubleshooting: Check bot.log\n');

  print('Need help?', 'bright');
  print('• Check logs: tail -f bot.log');
  print('• GitHub issues: [your repo URL]\n');

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

    // Step 3: Create .env file
    await createEnvFile({
      botToken,
      userIds,
      claudePath
    });

    // Step 4: Install dependencies
    const installed = await installDependencies();

    if (!installed) {
      print('\n⚠️  Remember to run "npm install" before starting the bot.', 'yellow');
    }

    // Step 5: Optional test
    // await testBot(); // Commented out - can be overwhelming

    // Step 6: Done!
    await printNextSteps();

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

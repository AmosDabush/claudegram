#!/usr/bin/env node

/**
 * Test setup wizard - validates everything works without user interaction
 */

const { execSync } = require('child_process');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
};

function print(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function checkCommand(command) {
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

console.log('\n🧪 Testing Setup Wizard Components\n');

let allGood = true;

// Test 1: Node.js
const nodeVersion = process.version;
const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0]);

if (nodeMajor >= 18) {
  print(`✅ Node.js ${nodeVersion}`, 'green');
} else {
  print(`❌ Node.js ${nodeVersion} (need 18+)`, 'red');
  allGood = false;
}

// Test 2: npm
if (checkCommand('npm')) {
  const npmVersion = getCommandVersion('npm');
  print(`✅ npm ${npmVersion}`, 'green');
} else {
  print(`❌ npm not found`, 'red');
  allGood = false;
}

// Test 3: Claude CLI
if (checkCommand('claude')) {
  const claudeVersion = getCommandVersion('claude');
  print(`✅ Claude CLI ${claudeVersion}`, 'green');
} else {
  print(`❌ Claude CLI not found`, 'red');
  allGood = false;
}

// Test 4: Optional - edge-tts
if (checkCommand('edge-tts')) {
  print(`✅ edge-tts (optional)`, 'green');
} else {
  print(`⚠️  edge-tts not found (optional)`, 'yellow');
}

// Test 5: Check if setup.js exists
const fs = require('fs');
const path = require('path');

if (fs.existsSync(path.join(__dirname, 'setup.js'))) {
  print(`✅ setup.js exists`, 'green');
} else {
  print(`❌ setup.js not found`, 'red');
  allGood = false;
}

// Test 6: Check if .env.example exists
if (fs.existsSync(path.join(__dirname, '.env.example'))) {
  print(`✅ .env.example exists`, 'green');
} else {
  print(`❌ .env.example not found`, 'red');
  allGood = false;
}

// Test 7: Check package.json has setup script
const packageJson = require('./package.json');
if (packageJson.scripts && packageJson.scripts.setup) {
  print(`✅ npm run setup configured`, 'green');
} else {
  print(`❌ setup script not in package.json`, 'red');
  allGood = false;
}

// Summary
console.log('\n' + '='.repeat(50));
if (allGood) {
  print('✅ All checks passed! Setup wizard is ready.', 'green');
  print('\nTo run the interactive setup:', 'cyan');
  print('  npm run setup', 'cyan');
} else {
  print('❌ Some checks failed. Please fix the issues above.', 'red');
}
console.log('='.repeat(50) + '\n');

process.exit(allGood ? 0 : 1);

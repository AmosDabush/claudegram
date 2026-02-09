# Setup Wizard - Example Session

This document shows what the interactive setup wizard looks like.

## Running the Wizard

```bash
npm run setup
```

---

## Step-by-Step Example

### Welcome Screen

```
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║         Claude Telegram Bot - Setup Wizard                ║
║                                                           ║
║  This will guide you through first-time setup            ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝

Welcome! Let's get your bot up and running.
```

---

### Dependency Check

```
============================================================
  📋 Checking Dependencies
============================================================

✅ Node.js v18.0.0 (OK)
✅ npm 9.0.0
✅ Claude CLI 2.1.37 (Claude Code)
⚠️  edge-tts not found (optional - only needed for voice)
   Install: pip install edge-tts
```

**If dependencies are missing:**

```
❌ Claude CLI not found
   Install from: https://github.com/anthropics/claude-code
   Or run: npm install -g @anthropic-ai/claude-code

❌ Please install missing dependencies first, then run setup again.
Run: node setup.js
```

---

### Get Bot Token

```
============================================================
  🤖 Telegram Bot Token
============================================================

You need to create a Telegram bot to get a token.

Steps:
1. Open Telegram and search for @BotFather
2. Send: /newbot
3. Follow instructions to create your bot
4. Copy the token BotFather gives you
5. Paste it here

Enter your bot token:
```

**User types:** `1234567890:ABCdefGhIjKlmNoPqRsTuVwXyZ1234567890`

**Validation:**
- ✅ Valid format → continues
- ❌ Invalid format → shows error and asks again

```
❌ Invalid token format. Should look like: 1234567890:ABCdefGhIjKlmNoPqRsTuVwXyZ
Enter your bot token:
```

---

### Get User ID

```
============================================================
  🆔 Telegram User ID
============================================================

You need your Telegram user ID so only YOU can use the bot.

Steps:
1. In Telegram, search for @userinfobot
2. Start a chat with it
3. It will reply with your user ID
4. Copy the ID number
5. Paste it here

Enter your Telegram user ID:
```

**User types:** `123456789`

**For multiple users:** `123456789,987654321`

**Validation:**
- ✅ Numbers only → continues
- ❌ Invalid format → shows error

```
❌ Invalid format. Enter numbers only (or comma-separated for multiple: 123,456)
Enter your Telegram user ID:
```

---

### Claude CLI Path

```
============================================================
  📍 Claude CLI Path
============================================================

Detected Claude CLI at: /Users/yourname/.local/bin
Use this path? (Y/n):
```

**Option 1:** Press Enter (uses detected path)

**Option 2:** Type custom path

```
Press Enter for default, or type custom path: /opt/homebrew/bin
```

---

### Create .env File

```
✅ Created .env file
```

**If .env already exists:**

```
⚠️  .env file already exists!
Overwrite it? (y/N): y
Backed up existing .env to: .env.backup.1675432100000
✅ Created .env file
```

---

### Install Dependencies

```
============================================================
  📦 Installing Dependencies
============================================================

Install npm packages now? (Y/n):
```

**Press Enter to install:**

```
Installing... This may take a minute.

added 45 packages, and audited 46 packages in 15s

✅ Dependencies installed successfully
```

**Or skip:**

```
Install npm packages now? (Y/n): n
Skipped. Run "npm install" manually later.
```

---

### Setup Complete!

```
============================================================
  🎉 Setup Complete!
============================================================

Your bot is configured and ready to use.

Next steps:
1. Start the bot:
   ./start.sh

2. Open Telegram and find your bot
   (search for the username you gave it)

3. Send /start to begin
   Try: /help for commands

4. Explore features:
   • Send any message → Ask Claude
   • /projects → Quick directory navigation
   • /settings → Configure the bot
   • /voice → Enable voice responses

Documentation:
• Full guide: README.md
• Commands: /all (in Telegram)
• Troubleshooting: Check bot.log

Need help?
• Check logs: tail -f bot.log
• GitHub issues: [your repo URL]

Enjoy your Claude Telegram Bot! 🚀
```

---

## Error Scenarios

### Missing Node.js 18+

```
❌ Node.js v16.0.0 (need 18+)
   Install from: https://nodejs.org/

❌ Please install missing dependencies first, then run setup again.
```

### Claude CLI Not Found

```
❌ Claude CLI not found
   Install from: https://github.com/anthropics/claude-code
   Or run: npm install -g @anthropic-ai/claude-code
```

### Invalid Bot Token

```
Enter your bot token: 12345
❌ Invalid token format. Should look like: 1234567890:ABCdefGhIjKlmNoPqRsTuVwXyZ
Enter your bot token:
```

### Invalid User ID

```
Enter your Telegram user ID: abc123
❌ Invalid format. Enter numbers only (or comma-separated for multiple: 123,456)
Enter your Telegram user ID:
```

---

## What Gets Created

After successful setup, you'll have:

```
.env                    # Your bot configuration (BOT_TOKEN, USER_IDS, etc.)
node_modules/           # Installed dependencies
```

Your `.env` will look like:

```env
# Telegram Bot Configuration
# Generated by setup wizard on 2026-02-09T...

# Your bot token from @BotFather
BOT_TOKEN=1234567890:ABCdefGhIjKlmNoPqRsTuVwXyZ1234567890

# Your Telegram user ID(s) - only these users can access the bot
# Get from @userinfobot on Telegram
ALLOWED_USER_IDS=123456789

# Idle timeout for caffeinate (hours)
# Bot keeps Mac awake only when there's been activity within this time
IDLE_TIMEOUT_HOURS=24

# Claude CLI binary path
# Path to directory containing claude executable
CLAUDE_BIN_PATH=/Users/yourname/.local/bin
```

---

## Tips

**Tip 1:** You can re-run setup anytime
```bash
npm run setup
```
It will backup your existing .env if you choose to overwrite.

**Tip 2:** Validate setup without interaction
```bash
node test-setup.js
```

**Tip 3:** Manual .env editing
If you need to change something, just edit `.env` directly:
```bash
nano .env
```

**Tip 4:** Test your configuration
After setup, test with:
```bash
./start.sh
```
Then send `/start` to your bot in Telegram.

---

## Troubleshooting

**Q: Setup says "command not found"**
- A: Make sure Node.js 18+ is installed: `node --version`

**Q: Setup can't find Claude CLI**
- A: Install it: `npm install -g @anthropic-ai/claude-code`
- Or verify it's in PATH: `which claude`

**Q: Invalid token format**
- A: Copy the full token from @BotFather, including the colon and everything after

**Q: Bot doesn't respond after setup**
- A: Check your user ID is correct: ask @userinfobot
- Check logs: `tail -f bot.log`

**Q: Want to start over?**
- A: Delete `.env` and run `npm run setup` again

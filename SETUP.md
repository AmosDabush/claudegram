# Setup Guide - Claudegram

Complete step-by-step guide for setting up Claudegram from scratch.

---

## 🚀 Quick Start (Recommended)

We have an **interactive setup wizard** that does everything for you!

```bash
# 1. Clone the repository
git clone https://github.com/AmosDabush/claudegram.git
cd claudegram

# 2. Run the setup wizard
npm run setup
```

The wizard will:
- ✅ Check all dependencies
- ✅ Guide you through getting bot token
- ✅ Help you get your user ID
- ✅ Create .env file automatically
- ✅ Install packages
- ✅ Test everything

**That's it!** The wizard handles everything interactively.

---

## 📋 Prerequisites

Before running setup, make sure you have:

- **macOS** (tested on macOS 14+)
- **Node.js 18+** - [Download here](https://nodejs.org/)
- **Claude CLI** installed and working - [Installation guide](https://github.com/anthropics/claude-code)
- **Telegram account** on your phone

The setup wizard will check these for you.

---

## 📱 Manual Installation (Advanced)

If you prefer manual setup or the wizard doesn't work:

---

## 🤖 Step 1: Create Your Telegram Bot

### 1.1 Open Telegram and find BotFather

1. Open Telegram on your phone or desktop
2. Search for `@BotFather` (official bot with a blue checkmark)
3. Start a chat with BotFather

### 1.2 Create a new bot

Send this command to BotFather:
```
/newbot
```

BotFather will ask you for:

1. **Bot name** - The display name (can be anything)
   ```
   Example: My Claude Assistant
   ```

2. **Bot username** - Must be unique and end with `bot`
   ```
   Example: my_claude_assistant_bot
   ```

### 1.3 Save your bot token

BotFather will reply with a message like:
```
Done! Congratulations on your new bot...

Use this token to access the HTTP API:
1234567890:ABCdefGhIjKlmNoPqRsTuVwXyZ1234567890

For a description of the Bot API, see this page:
https://core.telegram.org/bots/api
```

**⚠️ IMPORTANT:** Copy and save the token! You'll need it in step 3.

---

## 🆔 Step 2: Get Your Telegram User ID

You need your Telegram user ID so only YOU can control the bot.

### 2.1 Find your user ID

1. In Telegram, search for `@userinfobot`
2. Start a chat and send any message
3. The bot will reply with your user ID:
   ```
   Id: 123456789
   First name: Your Name
   ...
   ```

**Save this ID number!** You'll need it in step 3.

### 2.2 (Optional) Add more authorized users

If you want to allow other people to use your bot:
- Get their user IDs using `@userinfobot`
- You'll add all IDs as a comma-separated list in step 3

---

## 💻 Step 3: Install the Bot

### 3.1 Clone/Download the repository

```bash
# Option 1: Clone with git
git clone https://github.com/AmosDabush/claudegram.git
cd claudegram

# Option 2: Download ZIP and extract
# Then:
cd claudegram
```

### 3.2 Install dependencies

```bash
npm install
```

This will install:
- `node-telegram-bot-api` - Telegram bot library
- `dotenv` - Environment variables
- `edge-tts` - Text-to-speech (Microsoft voices)
- `node-pty` - Terminal emulation

### 3.3 Create your configuration file

Copy the example configuration:
```bash
cp .env.example .env
```

Now edit the `.env` file:
```bash
nano .env
# or use any text editor:
# code .env
# vim .env
```

Fill in your values:
```env
# Your bot token from BotFather (Step 1.3)
BOT_TOKEN=1234567890:ABCdefGhIjKlmNoPqRsTuVwXyZ1234567890

# Your Telegram user ID from @userinfobot (Step 2.1)
# For multiple users: 123456789,987654321
ALLOWED_USER_IDS=123456789

# Optional: Idle timeout (hours) - default is 24
IDLE_TIMEOUT_HOURS=24

# Optional: Claude CLI path - default is ~/.local/bin
CLAUDE_BIN_PATH=$HOME/.local/bin
```

**Save and close** the file (in nano: `Ctrl+X`, then `Y`, then `Enter`)

---

## ✅ Step 4: Verify Claude CLI is Working

Before starting the bot, make sure Claude CLI works:

```bash
# Test that claude command is found
which claude
# Should output: /Users/yourname/.local/bin/claude

# Test Claude with a simple prompt
claude -p "Say hello"
# Should get a response from Claude
```

If `claude` command is not found:
1. Make sure Claude CLI is installed: https://github.com/anthropics/claude-code
2. Check that it's in `~/.local/bin/`
3. Or update `CLAUDE_BIN_PATH` in `.env` to point to the correct location

---

## 🚀 Step 5: Start the Bot

### 5.1 First run

```bash
./start.sh
```

You should see:
```
🔍 Checking syntax...
✅ Syntax OK
⚡ Recent activity (0h ago)
   Starting with caffeinate (Mac stays awake for 24h)
✅ Telegram bot started (PID: 12345)
☕ Mac stays awake while bot has recent activity (<24h idle)
```

### 5.2 Test the bot

1. Open Telegram
2. Search for your bot's username (e.g., `@my_claude_assistant_bot`)
3. Start a chat with it
4. Send: `/start`

You should get a welcome message with instructions!

### 5.3 Try your first prompt

Send a message to the bot:
```
Hello! Can you explain what you are?
```

Claude should respond through the bot! 🎉

---

## 🎛️ Step 6: Basic Configuration

### 6.1 View current settings

Send: `/settings`

This shows:
- Voice mode (off/on/auto)
- Session mode (on-demand vs persistent)
- Permission mode (default/fast/plan/yolo)
- Interactive mode (on/off)

### 6.2 Recommended first-time settings

```
/session on          # Enable session memory
/interactive on      # Enable fast responses (default)
/voice off           # Start without voice (enable later)
```

### 6.3 Set your working directory

```
/projects            # Browse available projects
# or
/cd ~/git            # Change to your projects folder
/pwd                 # Check current directory
```

---

## 📖 Step 7: Learn the Commands

### Essential commands:

- `/help` - Show help message
- `/menu` - Show main menu with buttons
- `/pwd` - Show current directory
- `/cd <path>` - Change directory
- Send any text - Ask Claude anything
- `/cancel` - Cancel current request

### Useful commands:

- `/sessions` - View conversation history
- `/new` - Start a new conversation
- `/mode` - Change permission mode
- `/settings` - Quick settings panel

**Full command list:** Send `/all`

---

## 🔧 Troubleshooting

### Bot doesn't respond

**Check if bot is running:**
```bash
ps aux | grep "node.*bot.js"
```

**View logs:**
```bash
tail -f ~/.claude/telegram-bot/bot.log
# or
./logs.sh
```

**Restart the bot:**
```bash
./start.sh
```

### "Unauthorized" error

- Make sure your user ID in `.env` matches your actual Telegram user ID
- Get your ID again from `@userinfobot` and update `.env`
- Restart the bot after changing `.env`

### Claude commands not working

**Verify PATH:**
```bash
# In your bot directory:
cat .env | grep CLAUDE_BIN_PATH

# Test the path:
$HOME/.local/bin/claude -p "test"
```

**Update if needed:**
```bash
# Edit .env:
CLAUDE_BIN_PATH=/path/to/your/claude/bin
```

### Bot keeps crashing

**Check Node.js version:**
```bash
node --version
# Should be 18.0.0 or higher
```

**Reinstall dependencies:**
```bash
rm -rf node_modules package-lock.json
npm install
```

**Check for errors:**
```bash
node bot.js
# Run directly to see errors
```

---

## 🛡️ Security Best Practices

### ✅ DO:
- ✅ Keep your `.env` file secret
- ✅ Use a strong bot token
- ✅ Only add trusted users to `ALLOWED_USER_IDS`
- ✅ Keep the bot running only on your personal Mac
- ✅ Regularly check logs for unauthorized access attempts

### ❌ DON'T:
- ❌ Share your bot token publicly
- ❌ Commit `.env` to git (already in .gitignore)
- ❌ Deploy the bot on a public server (it's designed for personal use)
- ❌ Use "yolo" mode unless you trust Claude completely
- ❌ Add unknown user IDs to ALLOWED_USER_IDS

---

## 🎯 Next Steps

### Explore features:

1. **Voice mode** - Have Claude read responses aloud
   ```
   /voice auto
   /setvoice         # Choose English/Hebrew voice
   ```

2. **Projects** - Set up your work directories
   ```
   /add myproject ~/code/myproject
   /projects         # Quick switch between projects
   ```

3. **Git integration** - Check repo status
   ```
   /status           # Git status
   /branch           # Current branch
   ```

4. **Parallel operations** - Get multiple perspectives
   ```
   /perspectives Should I use React or Vue?
   ```

### Customize:

- Edit `data/projects.json` to add your favorite directories
- Adjust voice speed: `/setvoicespeed`
- Try different response styles: `/textstyle` or `/voicestyle`

---

## 📚 Additional Resources

- **Full documentation:** See [README.md](./README.md)
- **Architecture:** See [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Development:** See [DEVELOPMENT.md](./DEVELOPMENT.md)
- **Claude CLI:** https://github.com/anthropics/claude-code

---

## 💬 Getting Help

If you encounter issues:

1. Check the logs: `tail -f bot.log`
2. Review this guide again
3. Check Claude CLI is working: `claude -p "test"`
4. Verify your `.env` file has correct values
5. Try restarting: `./start.sh`

---

## 🎉 You're All Set!

Your Claude Telegram Bot is now running. You can control Claude from anywhere using your phone!

**Quick reference card:**
- 💬 Send any message → Ask Claude
- 📂 `/projects` → Switch directories
- 🔄 `/sessions` → View history
- ⚙️ `/settings` → Configure bot
- ❓ `/help` → Get help

Enjoy! 🚀

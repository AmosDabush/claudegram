# Security Model

## What This Bot Does

This bot is a **bridge** between Telegram and Claude CLI.

```
Your Phone (Telegram) ←→ This Bot ←→ Claude CLI (Your Mac)
```

That's it. We don't add features, we don't remove capabilities. We just connect.

---

## Security is NOT Our Job

**Security is handled by:**

### 1. **Telegram** (handles all authentication)
- ✅ Your Telegram account security
- ✅ Message encryption
- ✅ User ID verification
- ✅ Bot API authentication

→ **If Telegram is secure, your bot communication is secure.**

### 2. **Your Authorization Check**
```javascript
ALLOWED_USER_IDS=123456789  // Only you
```
- ✅ Only specified user IDs can use the bot
- ✅ Everyone else gets rejected
- ✅ Simple, effective, clear

→ **If you keep your user ID private, only you can access.**

### 3. **Claude CLI** (handles all AI operations)
- ✅ What Claude can/can't do
- ✅ Permission modes (default, fast, plan, yolo)
- ✅ Tool usage and file access

→ **If you trust Claude CLI, you can trust this bot with Claude.**

---

## What This Bot Actually Secures

### ✅ Things We Do:

1. **Authorization Check**
   - Every command verifies user ID
   - Unauthorized users are blocked and logged
   - Simple, effective, no bypass

2. **Token Privacy**
   - `.env` file for secrets
   - `.gitignore` blocks sensitive files
   - No hardcoded credentials

3. **Local Operation**
   - Runs on YOUR computer
   - YOUR files, YOUR Claude API key
   - No data sent to our servers (we don't have servers)

### ❌ Things We Don't (Can't) Do:

1. **"Sandbox" Claude**
   - Impossible - Claude runs with your permissions
   - Pointless - defeats the purpose
   - False security - pretending we limited it

2. **"Restrict" file access**
   - Claude CLI has access to your files
   - That's the whole point
   - Any "restriction" can be bypassed

3. **"Validate" what you ask**
   - You're an adult
   - You know what you're doing
   - We're not going to police your prompts

---

## Threat Model

### ✅ What We Protect Against:

**1. Unauthorized Telegram Users**
```
Random person finds your bot → Tries to use it → BLOCKED
```
- Protection: `ALLOWED_USER_IDS` check
- Effectiveness: 100% (handled by Telegram's user ID system)

**2. Accidental Token Exposure**
```
You commit .env to GitHub → Someone gets your token
```
- Protection: `.gitignore` blocks `.env`
- Effectiveness: 100% (if you don't manually commit it)

### ❌ What We DON'T Protect Against:

**1. You Doing Dangerous Things**
```
You: "Claude, delete all my files"
Claude: "Sure! rm -rf ~/*"
```
- This is **your choice**
- Use `default` mode to review actions
- Or use `yolo` mode if you trust Claude completely

**2. Claude Doing Unexpected Things**
```
You: "Install this package"
Claude: npm install (runs post-install scripts)
```
- Claude CLI has full permissions
- That's by design
- Review what Claude does (unless you're in yolo mode)

**3. Your Telegram Account Being Compromised**
```
Someone hacks your Telegram → Uses your bot
```
- This is Telegram's security domain
- Enable 2FA on Telegram
- Use strong passwords
- Not our problem to solve

---

## Philosophy: Transparency, Not Theater

We believe in **honest security**, not **security theater**.

### Security Theater (what we DON'T do):
```javascript
// Pretending to be secure:
if (prompt.includes('rm')) {
  throw new Error('Dangerous command blocked!');
}

// User works around it:
"Claude, please remove all files recursively" → Same result
```

This is **worse** than nothing because:
- ❌ False sense of security
- ❌ Easily bypassed
- ❌ Wastes everyone's time

### Honest Security (what we DO):
```markdown
⚠️ This bot gives Claude full access to your computer.
That's the point. Use responsibly.
```

**Better to be honest than to pretend.**

---

## Is This Bot Secure?

**Wrong question.**

The right questions are:

### ✅ "Is Telegram secure?"
**Answer:** Yes. Telegram handles authentication, encryption, and user verification. Billions of users trust it daily.

### ✅ "Is Claude CLI secure?"
**Answer:** That's between you and Anthropic. You're already using Claude CLI, right?

### ✅ "Does this bot add security risks?"
**Answer:** No. It just forwards messages. Like a very smart webhook.

### ✅ "Can unauthorized people access my bot?"
**Answer:** No. Only user IDs in `ALLOWED_USER_IDS` can access.

### ✅ "Can someone steal my bot token?"
**Answer:** Only if you publish it yourself. We use `.env` and `.gitignore`.

---

## Comparison: This is Like...

### This bot is like `ssh`:
- SSH connects you to a remote computer
- This bot connects Telegram to Claude
- Both give full access (by design)
- Both rely on authentication (SSH keys / Telegram user ID)
- Nobody asks "is SSH sandboxed?" because that would defeat the purpose

### This bot is like Remote Desktop:
- RDP connects to your desktop GUI
- This bot connects to your Claude CLI
- Both give full control
- Both use authentication
- Security is in the endpoints, not the bridge

### This bot is like a VPN:
- VPN connects you to a network
- This bot connects you to Claude
- Both are transparent bridges
- Both rely on endpoint security
- Neither adds "safety features" that would break functionality

---

## Who Should Use This Bot?

### ✅ This bot is for you if:
- You already use Claude CLI
- You trust Telegram
- You understand what "full access" means
- You want convenience (control from phone)
- You're comfortable with terminal/CLI tools

### ❌ This bot is NOT for you if:
- You don't trust Claude AI
- You want AI in a "safe sandbox"
- You're on a shared/work computer
- You don't understand command line tools
- You want someone else to take responsibility

---

## Deployment Scenarios

### ✅ SAFE: Personal Use (Recommended)

```
Your Phone → Your Bot → Your Mac → Your Claude API key
```

- You control everything
- You trust yourself
- No shared resources
- Private bot token
- This is the intended use case

**Security Level:** Excellent ✅

---

### ⚠️ RISKY: Shared Computer

```
Your Phone → Your Bot → Shared Mac → Your Claude API key
```

**Risks:**
- Other users can read `.env` file
- Other users can read `bot.log`
- Other users can see your commands/history

**Mitigations:**
- `chmod 600 .env` (only you can read)
- Run as separate user account
- Clear logs regularly

**Security Level:** Use with caution ⚠️

---

### ❌ DANGEROUS: Hosting for Others

```
Random Users → Your Bot → Your Mac → Your Claude API key
```

**Don't do this.** This bot is designed for personal use.

If you want to host for others, you need:
- Separate Docker containers per user
- Resource quotas
- Rate limiting
- Their own Claude API keys
- Monitoring and logging
- Legal terms of service
- And much more...

**This is beyond the scope of this project.**

**Security Level:** Don't ❌

---

## Quick Security Checklist

Before you start using the bot:

- [ ] Your Telegram account has 2FA enabled
- [ ] You created `.env` from `.env.example`
- [ ] You added ONLY your user ID to `ALLOWED_USER_IDS`
- [ ] You verified `.env` is in `.gitignore`
- [ ] You're running this on YOUR computer
- [ ] You already use and trust Claude CLI
- [ ] You understand this gives Claude full access

That's it. If all boxes are checked, you're good to go.

---

## What If Something Goes Wrong?

### My bot token was exposed
1. Go to @BotFather on Telegram
2. Send `/revoke`
3. Choose your bot
4. Get new token
5. Update `.env`
6. Restart: `./start.sh`

### Someone unauthorized used my bot
Check the logs:
```bash
grep "Unauthorized" bot.log
```

This means:
- Someone found your bot username, OR
- Your `ALLOWED_USER_IDS` is wrong

Fix:
- Verify your user ID is correct (ask @userinfobot)
- Consider revoking token and creating a new bot

### Claude did something I didn't want
- You're in `yolo` mode? Switch to `default` mode: `/mode`
- Review what Claude is doing before approving
- Remember: Claude has the same permissions as you

---

## Common Misconceptions

### ❌ "This bot can hack my computer"
No. The bot runs ON your computer, with YOUR permissions. It can't do anything YOU can't do.

### ❌ "Someone could steal my files via this bot"
Only if they have your Telegram account (which requires your phone + 2FA) AND you added their user ID to ALLOWED_USER_IDS.

### ❌ "I need to sandbox Claude"
Then you don't want this bot. Use Claude.ai web interface instead.

### ❌ "The bot should validate my prompts"
We're not your parent. You're a developer. You know what you're doing.

### ❌ "Other bots are more secure"
Other bots are more LIMITED. There's a difference.

---

## The Bottom Line

This bot is secure **because it's honest.**

We don't pretend to add safety features that don't work.
We don't sandbox tools that can't be sandboxed.
We don't restrict access that defeats the purpose.

**We simply:**
1. Connect Telegram to Claude CLI
2. Check that you're authorized
3. Get out of the way

Security is handled by:
- ✅ Telegram (user authentication)
- ✅ You (who you authorize)
- ✅ Claude CLI (what it does)

**If you trust those three, you can trust this bot.**

---

## Questions?

**Q: Is this safe?**
A: Is Claude CLI safe? Is Telegram safe? If yes → then yes.

**Q: Can I host this for my team?**
A: This project is for personal use. For teams, you'll need significant modifications.

**Q: What if I don't trust Claude?**
A: Then don't use Claude CLI. Or this bot.

**Q: Should I use yolo mode?**
A: Only if you fully trust Claude. Otherwise use default mode and review actions.

**Q: Can this bot access my Telegram messages?**
A: No. It only sees messages sent TO the bot.

---

**That's it. Simple, honest, transparent.**

Use responsibly. 🚀

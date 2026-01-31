# Claude Telegram Bot

בוט טלגרם שמחבר אותך ל-Claude AI מכל מקום דרך הטלפון.

## ארכיטקטורה

```
+---------------+          +------------------+          +----------------+
|   Telegram    |  Long    |   Bot Server     |  spawn   |   Claude CLI   |
|   (טלפון)     | <------> |   (המאק שלך)     | <------> | (~/.local/bin) |
+---------------+ Polling  +------------------+          +----------------+
                                                                |
                                                                | API
                                                                v
                                                        +----------------+
                                                        |   Anthropic    |
                                                        |   Servers      |
                                                        +----------------+
```

**הבוט רץ על המאק שלך** ומקשיב לטלגרם. כשמגיעה הודעה, הוא מריץ את `claude` בטרמינל ושולח את התשובה בחזרה.

## מבנה הקבצים

```
~/.claude/telegram-bot/
├── bot.js                 # Entry point - Main bot logic, menus, callbacks
├── start.sh               # Script להפעלה/ריסטארט
├── .env                   # BOT_TOKEN, ALLOWED_USER_IDS
├── bot.log                # לוגים
├── package.json           # dependencies
│
├── data/                  # נתונים שמורים (auto-created)
│   ├── sessions.json      # היסטוריית sessions של Claude
│   ├── user-state.json    # הגדרות המשתמש (per chat)
│   ├── projects.json      # פרויקטים מותאמים אישית
│   ├── bot.pid            # PID של התהליך הנוכחי
│   ├── restart-notify.txt # Chat ID for restart notification
│   └── images/            # תמונות שנשלחו (last 20 kept)
│
└── lib/
    ├── config.js          # קונפיגורציה - TTS engines, presets, defaults
    ├── state.js           # ניהול state + persistence + reset functions
    ├── sessions.js        # ניהול sessions של Claude (bot + CLI)
    ├── utils.js           # פונקציות עזר - sendLongMessage, getModeFlag
    │
    ├── commands/
    │   ├── claude.js      # הלוגיקה המרכזית - messages, streaming, interactive
    │   ├── navigation.js  # /projects, /browse, /cd, /pwd, /add
    │   ├── git.js         # /status, /branch, /repo, /ls, /tree, /git
    │   ├── voice.js       # /voice, /tts, /setvoice, /textstyle, /voicestyle
    │   └── parallel.js    # /perspectives, /investigate, /cancelall
    │
    └── tts/
        ├── index.js       # Router + chunking logic
        ├── edge.js        # Edge TTS (Microsoft) - Best quality
        ├── google.js      # Google TTS - Fast
        ├── piper.js       # Piper (local) - Fastest, no Hebrew
        └── coqui.js       # Coqui (local) - English only
```

## התקנה

### דרישות
- Node.js 18+
- Claude CLI מותקן (`~/.local/bin/claude`)
- Telegram Bot Token (מ-@BotFather)

### שלבים

1. **צור את קובץ .env:**
```bash
cd ~/.claude/telegram-bot
cat > .env << 'EOF'
BOT_TOKEN=your-telegram-bot-token
ALLOWED_USER_IDS=123456789,987654321
EOF
```

2. **התקן dependencies:**
```bash
npm install
```

3. **הפעל:**
```bash
./start.sh
```

---

## כל הפקודות

### 📂 ניווט (Navigation)
| פקודה | תיאור |
|-------|--------|
| `/projects` | בחירת פרויקט מרשימה (כפתורים) |
| `/project <name>` | מעבר ישיר לפרויקט |
| `/browse` | דפדוף בתיקיות עם כפתורים |
| `/browse <path>` | דפדוף החל מנתיב מסוים |
| `/pwd` | הצגת נתיב נוכחי + מצב |
| `/cd <path>` | מעבר לתיקייה |
| `/add <name> <path>` | הוספת פרויקט חדש |

### 🤖 Claude AI
| פקודה | תיאור |
|-------|--------|
| (טקסט חופשי) | שליחה ל-Claude |
| `-r <msg>` | שליחה עם force resume (המשך session) |
| `/sessions` | רשימת sessions (טלגרם + Mac CLI) |
| `/session` | החלפה בין On-Demand/Session mode |
| `/session on/off` | הפעלה/כיבוי ישיר |
| `/new` | התחלת session חדש |
| `/mode` | בחירת permission mode (default/fast/plan/yolo) |
| `/cancel` | ביטול בקשה נוכחית |
| `/fast <question>` | תשובה מהירה ללא tools |
| `/claude` | תפריט Claude מלא |

### 🔄 Interactive Mode
| פקודה | תיאור |
|-------|--------|
| `/interactive` | הפעלה/כיבוי מצב אינטראקטיבי |
| `/interactive on/off` | הפעלה/כיבוי ישיר |
| `/terminal` | החלפה בין iTerm לרקע |
| `/terminal on/off` | הפעלה/כיבוי ישיר |
| `/resume` | חידוש session (= /sessions) |
| `/persist` | שמירת session אחרי restart |
| `/persist on/off` | הפעלה/כיבוי ישיר |

### 📋 Process Logs
| פקודה | תיאור |
|-------|--------|
| `/thought` | הגדרת מצב process log |
| `/thought off` | ללא לוגים (רק ספירה) |
| `/thought on` | כפתורים לחיצים לצפייה בלוגים |
| `/thought auto` | הצגה אוטומטית אחרי כל תשובה |
| `/t` | הצגת status log אחרון |

**סיכום אחרי תשובה (כש-thoughtMode=on):**
```
Done (5s) [🔧3, 📝5, 📋8, 🔊]
```

**כפתורים:**
- `🔧` - **Tools**: פעולות מפורטות (Read: /path, Bash: cmd)
- `📝` - **Status**: מה הוצג בסטטוס בזמן עיבוד
- `📋` - **Full Log**: כל התהליך המלא (JSON events)
- `🔊` - **Voice**: יצירת קול (רק כש-voiceMode=on)

### 🎙 Voice (TTS)
| פקודה | תיאור |
|-------|--------|
| `/voice` | הגדרת מצב קול (off/on/auto) |
| `/voice off` | ללא קול |
| `/voice on` | כפתור 🔊 לחיץ לקבלת קול |
| `/voice auto` | קול אוטומטי אחרי כל תשובה |
| `/v` | יצירת קול מתשובה אחרונה |
| `/get_voice` | = `/v` |
| `/tts` | בחירת TTS engine |
| `/setvoice` | בחירת קול (English/Hebrew) |
| `/setvoicespeed` | מהירות דיבור |
| `/voicechunk` | גודל chunks לפיצול |
| `/voicestyle` | סגנון תשובה לקול (casual, bro, etc.) |
| `/voiceresponse` | = `/voicestyle` |
| `/textstyle` | סגנון תשובה לטקסט (concise, code_only, etc.) |

### 🌿 Git ופקודות מהירות
| פקודה | תיאור |
|-------|--------|
| `/git` | תפריט Git |
| `/status` או `/gs` | Git status |
| `/branch` | Branch נוכחי |
| `/branches` | כל ה-branches |
| `/repo` | מידע על repo |
| `/ls` | תוכן תיקייה |
| `/ls <path>` | תוכן תיקייה מסוימת |
| `/tree` | מבנה תיקיות (depth 2) |
| `/tree <n>` | מבנה תיקיות עם עומק n |
| `/files` | חיפוש קבצים |
| `/files <pattern>` | חיפוש קבצים לפי pattern |

### 🔀 Parallel Operations
| פקודה | תיאור |
|-------|--------|
| `/perspectives <question>` | קבלת 3 נקודות מבט (ברירת מחדל) |
| `/perspectives <n> <question>` | קבלת n נקודות מבט (2-5) |
| `/investigate <problem>` | פירוק בעיה וחקירה במקביל |
| `/cancelall` | ביטול כל ה-agents הפעילים |

### 📜 Logs
| פקודה | תיאור |
|-------|--------|
| `/logs` | 50 שורות אחרונות |
| `/logs <n>` | n שורות אחרונות |
| `/logfile` | הורדת קובץ log מלא |
| `/clearlogs` | ניקוי log |

### ⚙️ מערכת
| פקודה | תיאור |
|-------|--------|
| `/start` | הודעת פתיחה |
| `/help` או `/?` | עזרה |
| `/all` | רשימת כל הפקודות |
| `/menu` | תפריט ראשי עם כפתורים |
| `/settings` | הגדרות מהירות (Quick Settings) |
| `/reset` | איפוס מצב תקוע (ללא restart) |
| `/restart` | restart רגיל (שומר session לחידוש) |
| `/restart clean` | restart נקי (מנקה הכל) |
| `/close` | סגירת הבוט (כל ה-instances) |

### 📷 תמונות
| פעולה | תיאור |
|-------|--------|
| שליחת תמונה | Claude מנתח את התמונה |
| תמונה + caption | Claude מנתח לפי ה-caption |

---

## מצבי עבודה

### Voice Mode (מצב קול)

| מצב | תיאור | סגנון |
|-----|--------|-------|
| `off` | ללא קול | Text Style משמש |
| `on` | כפתור 🔊 לחיץ | Text Style משמש |
| `auto` | קול אוטומטי | Voice Style משמש |

**Text Style Options** (כשקול off/on):
- `off` - Default Claude
- `concise` - תשובות קצרות
- `detailed` - הסברים מפורטים
- `code_only` - מינימום טקסט, מקסימום קוד
- `no_emoji` - ללא אימוג'ים

**Voice Style Options** (כשקול auto):
- `off` - טקסט רגיל
- `normal` - פורמט קל
- `casual` - שיחתי
- `very_casual` - דיבור טבעי (ברירת מחדל)
- `bro` - שיחת חבר

### Session Mode vs On-Demand

**On-Demand:**
- כל הודעה היא שיחה נפרדת
- Claude לא זוכר הודעות קודמות
- מהיר יותר

**Session Mode:**
- Claude זוכר את כל השיחה
- אפשר להמשיך מאיפה שהפסקת
- משתמש ב-`--resume` של Claude CLI

### Interactive Mode

**Interactive ON (ברירת מחדל):**
- Claude רץ כתהליך מתמשך (stream-json)
- תקשורת דרך stdin/stdout
- הכי מהיר לשיחות רציפות
- Session נשמר אוטומטית

**Interactive OFF:**
- כל הודעה מפעילה תהליך חדש
- איטי יותר, אבל יציב יותר

### Permission Modes

| מצב | Flag | תיאור |
|-----|------|--------|
| `default` | (none) | Claude מבקש אישור לפעולות |
| `fast` | `--allowedTools ""` | תשובות מהירות, ללא כלים |
| `plan` | `--plan` | רק תכנון, ללא ביצוע |
| `yolo` | `--dangerously-skip-permissions` | ללא אישורים (מסוכן!) |

---

## TTS Engines

| Engine | Icon | תיאור | עברית | מהירות |
|--------|------|--------|-------|--------|
| Edge TTS | ☁️ | Microsoft, איכות הכי טובה | כן | בינונית |
| Google TTS | 🔵 | מהיר, טוב | כן | מהיר |
| Piper | 🏠 | מקומי, הכי מהיר | לא | הכי מהיר |
| Coqui | 🐸 | מקומי, אנגלית בלבד | לא | איטי |

### Voice Chunk Presets

הבוט מחלק תשובות ארוכות ל-chunks ושולח אודיו בהדרגה:

| Preset | Icon | Pattern | תיאור |
|--------|------|---------|--------|
| Small | 🔹 | 1-2-3-4-5-5... | אודיו ראשון הכי מהיר |
| Medium | 🔸 | 2-4-8-8... | ברירת מחדל |
| Large | 🟠 | 2-4-8-12-12... | פחות הודעות |
| XL | 🟡 | 4-4-8-8-10-12-14... | chunks גדולים |
| XXL | 🟢 | 5-10-15-20-20... | chunks גדולים מאוד |
| XXXL | 🔵 | 10-20-40-40... | chunks ענקיים |
| None | ⬜ | Full | הכל בבת אחת |

---

## Quick Settings Menu

הגדרות מהירות (`/settings`) מציג:

```
Voice: 🔇/🔊/✨  [off] [on] [auto]
TxtStyle: 📝/⚡/💻/🚫
VoiceStyle: 📝/💬/🎙/🤙
Thought: 🔇/🧠/✨  [off] [on] [auto]
Session: ⚡/💬  [demand] [session]
Mode: 🔒/⚡/📋/🔥  [default/fast/plan/yolo]
Interactive: ⚡/🔄  [off] [on]
```

לחיצה על הכותרת (Voice:, Mode:, וכו') פותחת את התפריט היעודי.

---

## Restart Mechanism

### `/restart` (רגיל)
1. שולח הודעת "Restarting..."
2. קורא ל-`resetAllUsersRuntime({ keepSessionId: true })`
   - הורג processes רצים
   - שומר `interactiveSessionId` לחידוש אוטומטי
3. שומר state לקובץ (`saveNow()`)
4. שומר chat ID לקובץ `restart-notify.txt`
5. מפעיל תהליך חדש: `spawn('node', ['bot.js'], { detached: true })`
6. יוצא מהתהליך הישן
7. התהליך החדש:
   - הורג instance ישן אם קיים (לפי PID file)
   - טוען state מהקובץ
   - שולח הודעת "Bot restarted successfully!"
   - בהודעה הבאה - מחדש session אוטומטית

### `/restart clean`
1-7 כמו רגיל, אבל:
- קורא ל-`resetAllUsersRuntime({ keepSessionId: false, clearSessions: true })`
- מנקה קובץ sessions.json
- מתחיל ממצב נקי לגמרי

### `/reset`
איפוס מצב ללא restart:
- הורג processes רצים
- מנקה state
- **לא** מפעיל מחדש

---

## State Management

### User State (per chat)
```javascript
{
  // Navigation
  currentProject: 'home',
  currentPath: '/Users/...',

  // Claude
  currentMode: 'default',      // default/fast/plan/yolo
  sessionMode: true,           // session vs on-demand
  persistSession: false,       // survive restart

  // Voice
  voiceMode: 'off',            // off/on/auto
  voiceSettings: {
    ttsEngine: 'edge',
    voice: 'en-US-JennyNeural',
    hebrewVoice: 'he-IL-HilaNeural',
    rate: '+25%',
    responseLevel: 'very_casual',  // voice style
    textStyle: 'off',              // text style
    chunkPreset: 'medium'
  },

  // Interactive
  interactiveMode: true,
  showTerminal: false,
  interactiveSessionId: null,  // for auto-resume

  // Thought
  thoughtMode: 'off',          // off/on/auto

  // Runtime (not persisted)
  isProcessing: false,
  currentClaudeProc: null,
  interactiveProc: null,
  pendingMessage: null,
  interactiveThinkingMsgId: null,
  interactiveStartTime: null,
  interactiveToolsUsed: []
}
```

**נשמר ב:** `data/user-state.json`

### Sessions
```javascript
{
  sessionId: "uuid-...",
  projectPath: "/Users/.../project",
  topic: "first message...",
  messageCount: 5,
  createdAt: "2024-...",
  lastUsed: "2024-..."
}
```

**נשמר ב:** `data/sessions.json`

---

## Callback System

### Callback Data Prefixes
| Prefix | Handler | תיאור |
|--------|---------|--------|
| `proj:` | navigation | בחירת פרויקט |
| `browse:` | navigation | ניווט בתיקיות |
| `mode:` | claude | בחירת permission mode |
| `session:` | claude | on/off session mode |
| `interactive:` | claude | on/off interactive mode |
| `terminal:` | claude | on/off terminal display |
| `persist:` | claude | on/off persistence |
| `thought:` | claude | off/on/auto thought mode |
| `resume:` | claude | חידוש session |
| `cli:` | claude | חידוש Mac CLI session |
| `clibrowse:` | claude | browse CLI projects |
| `cliproj:` | claude | בחירת session מפרויקט |
| `voicemode:` | voice | off/on/auto voice |
| `tts:` | voice | בחירת TTS engine |
| `voice:en:` | voice | בחירת קול אנגלית |
| `voice:he:` | voice | בחירת קול עברית |
| `speed:` | voice | מהירות דיבור |
| `voicestyle:` | voice | סגנון קול |
| `textstyle:` | voice | סגנון טקסט |
| `chunk:` | voice | chunk preset |
| `qset:` | bot.js | Quick Settings toggle |
| `all:` | bot.js | Main menu sections |
| `cmd:` | various | הפעלת פקודה (opens menu) |
| `git:` | git | פעולות Git |

### Callback Flow
```
1. User clicks button
2. bot.on('callback_query') triggered
3. Check each module's handleCallback():
   - navigationCommands.handleCallback()
   - gitCommands.handleCallback()
   - voiceCommands.handleCallback()
   - await claudeCommands.handleCallback()  // async!
   - parallelCommands.handleCallback()
4. If none handled, check:
   - qset: (Quick Settings)
   - all: (Menu sections)
   - cmd: (Command shortcuts)
5. Return appropriate response
```

**חשוב:** `claudeCommands.handleCallback` הוא async וחייב await!

---

## Message Flow (Interactive Mode)

```
1. User sends message
2. handleMessage() in claude.js
3. Check interactiveMode
4. If interactiveProc exists:
   a. Send "Processing..." message with cancel button
   b. Apply style prompt (voiceStyle or textStyle)
   c. sendToInteractive() - write JSON to stdin
   d. Stream response, update message
   e. On result:
      - Send final text
      - If voiceMode='auto': sendVoiceResponse()
      - Send summary: "✅ Done (Xs) [(n)🧠, 🔊]"
5. If no proc:
   a. Check for resume session
   b. startInteractiveSession(resumeId, initialMessage)
   c. Wait for 'init' event
   d. Continue from step 4
```

---

## פתרון בעיות

### הבוט לא מגיב
```bash
# בדוק אם רץ
ps aux | grep "node bot.js"

# ראה לוגים
tail -f ~/.claude/telegram-bot/bot.log

# הפעל מחדש
~/.claude/telegram-bot/start.sh
```

### Claude לא מגיב
```bash
# בדוק ש-claude CLI עובד
claude -p "test"

# ראה שה-PATH נכון
which claude
```

### מצב תקוע
```bash
# מטלגרם
/reset

# או הרוג ידנית
pkill -f "node.*bot.js"
./start.sh
```

### TTS לא עובד
```bash
# בדוק edge-tts
edge-tts --text "test" --voice en-US-AriaNeural --write-media /tmp/test.mp3

# בדוק piper
~/.local/bin/piper --model ~/.local/share/piper-voices/en_US-amy-medium.onnx --output_file /tmp/test.wav <<< "test"
```

---

## אבטחה

- **ALLOWED_USER_IDS:** רק משתמשים מורשים יכולים להשתמש בבוט
- **אל תשתף את BOT_TOKEN**
- **YOLO mode מסוכן:** נותן ל-Claude לעשות הכל ללא אישור

---

## קבצים נוספים

- [ARCHITECTURE.md](./ARCHITECTURE.md) - תיעוד טכני מפורט
- [DEVELOPMENT.md](./DEVELOPMENT.md) - מדריך להוספת תכונות חדשות

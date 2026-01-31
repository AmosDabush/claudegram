/**
 * Parallel Commands
 * /perspectives, /investigate - Multi-instance Claude features
 */

const { spawn } = require('child_process');
const { getUserState, scheduleSave } = require('../state');
const { sendLongMessage, getModeFlag } = require('../utils');
const { getSession, setSession } = require('../sessions');
const { generateVoice } = require('../tts');

// Track active parallel operations
const activeOperations = new Map();

/**
 * Register parallel commands
 */
function register(bot, isAuthorized) {

  // /perspectives alone - show help
  bot.onText(/^\/perspectives?\s*$/, (msg) => {
    if (!isAuthorized(msg)) return;
    bot.sendMessage(msg.chat.id,
      `🔀 *Perspectives*\n\n` +
      `Get multiple viewpoints on the same question.\n\n` +
      `*Usage:* \`/perspectives [count] <question>\`\n\n` +
      `*Examples:*\n` +
      `• \`/perspectives what is the best auth approach?\`\n` +
      `• \`/perspectives 4 how to optimize this?\`\n\n` +
      `Count: 2-5 (default: 3)`,
      { parse_mode: 'Markdown' }
    );
  });

  // /perspectives <count> <question> - Get multiple viewpoints
  bot.onText(/\/perspectives?\s+(\d)?\s*(.+)/s, async (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const count = parseInt(match[1]) || 3;  // Default 3 perspectives
    const question = match[2].trim();

    if (count < 2 || count > 5) {
      bot.sendMessage(msg.chat.id, '❌ Count must be between 2 and 5');
      return;
    }

    if (userState.isProcessing) {
      bot.sendMessage(msg.chat.id, '⏳ Already processing. Use /cancel first.');
      return;
    }

    userState.isProcessing = true;

    const statusMsg = await bot.sendMessage(msg.chat.id,
      `🔀 *Perspectives*\n\nGetting ${count} different viewpoints...\n\n${Array(count).fill('⏳').map((_, i) => `${i + 1}. Thinking...`).join('\n')}`,
      { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
    );

    try {
      const results = await runPerspectives(
        question,
        userState.currentPath,
        count,
        userState.currentMode,
        (index, status) => {
          // Update status for each perspective
          updatePerspectivesStatus(bot, msg.chat.id, statusMsg.message_id, count, index, status);
        }
      );

      // Send results
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const header = `🔀 *Perspective ${i + 1}/${count}*\n\n`;

        if (result.error) {
          bot.sendMessage(msg.chat.id, `${header}❌ Error: ${result.error}`, { parse_mode: 'Markdown' });
        } else {
          await sendLongMessage(bot, msg.chat.id, `${header}${result.text}`);
        }
      }

      // Delete status message
      try { await bot.deleteMessage(msg.chat.id, statusMsg.message_id); } catch (e) {}

    } catch (error) {
      bot.editMessageText(`❌ Error: ${error.message}`, {
        chat_id: msg.chat.id,
        message_id: statusMsg.message_id
      });
    } finally {
      userState.isProcessing = false;
    }
  });

  // /investigate alone - show help
  bot.onText(/^\/investigate\s*$/, (msg) => {
    if (!isAuthorized(msg)) return;
    bot.sendMessage(msg.chat.id,
      `🌳 *Parallel Investigation*\n\n` +
      `Breaks down a problem and investigates each branch in parallel.\n\n` +
      `*Usage:* \`/investigate <problem>\`\n\n` +
      `*Examples:*\n` +
      `• \`/investigate slow rendering on dashboard\`\n` +
      `• \`/investigate memory leak in worker\`\n` +
      `• \`/investigate auth failures in prod\`\n\n` +
      `Claude will:\n` +
      `1. Break problem into 3-5 branches\n` +
      `2. Investigate all in parallel\n` +
      `3. Provide summary`,
      { parse_mode: 'Markdown' }
    );
  });

  // /investigate <problem> - Break down and investigate in parallel with separate streaming messages
  bot.onText(/\/investigate\s+(.+)/s, async (msg, match) => {
    if (!isAuthorized(msg)) return;

    const userState = getUserState(msg.chat.id);
    const problem = match[1].trim();

    if (userState.isProcessing) {
      bot.sendMessage(msg.chat.id, '⏳ Already processing. Use /cancel first.');
      return;
    }

    userState.isProcessing = true;

    const mainMsg = await bot.sendMessage(msg.chat.id,
      `🌳 *Parallel Investigation*\n\n🔍 Analyzing problem and creating investigation branches...`,
      { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
    );

    try {
      // Step 1: Ask Claude to break down the problem
      const breakdownPrompt = `You are helping investigate a problem. Break it down into 3-5 parallel investigation branches.

Problem: ${problem}

Respond ONLY with a JSON array of investigation branches. Each branch should be a focused sub-task.
Format: ["branch 1 description", "branch 2 description", ...]

Example for "slow dashboard rendering":
["Investigate backend API response times and database query performance", "Analyze client-side React component rendering and re-renders", "Check network requests, payload sizes, and caching", "Review browser performance metrics and memory usage"]

Return ONLY the JSON array, nothing else.`;

      const breakdownResult = await runClaudeSimple(breakdownPrompt, userState.currentPath, userState.currentMode);

      // Parse branches
      let branches;
      try {
        const jsonMatch = breakdownResult.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('No JSON array found');
        branches = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(branches) || branches.length < 2) throw new Error('Invalid branches');
      } catch (e) {
        bot.editMessageText(`❌ Failed to parse investigation branches. Try rephrasing the problem.`, {
          chat_id: msg.chat.id,
          message_id: mainMsg.message_id
        });
        userState.isProcessing = false;
        return;
      }

      // Update main message with branches list
      const branchList = branches.map((b, i) => `${i + 1}. ${b.substring(0, 60)}${b.length > 60 ? '...' : ''}`).join('\n');
      await bot.editMessageText(
        `🌳 *Parallel Investigation*\n\n📋 *${branches.length} branches identified:*\n\n${branchList}\n\n🔄 Investigating all branches in parallel...`,
        { chat_id: msg.chat.id, message_id: mainMsg.message_id, parse_mode: 'Markdown' }
      );

      // Step 2: Create a message for each branch
      const branchMessages = [];
      for (let i = 0; i < branches.length; i++) {
        const branchMsg = await bot.sendMessage(msg.chat.id,
          `🔹 *Branch ${i + 1}:* ${branches[i].substring(0, 50)}...\n\n⏳ Starting investigation...`,
          { parse_mode: 'Markdown' }
        );
        branchMessages.push(branchMsg);
      }

      // Step 3: Spawn ALL Claude processes simultaneously (truly parallel)
      const branchState = branches.map(() => ({
        lastText: '',
        lastUpdate: 0
      }));

      // Create all promises at once - this spawns all Claude processes simultaneously
      const branchPromises = branches.map((branch, index) => {
        const branchPrompt = `You are investigating one specific aspect of a larger problem.

Main Problem: ${problem}

Your specific investigation focus: ${branch}

Investigate this thoroughly. Look at relevant code, configs, and patterns. Provide specific findings and recommendations.
Be concise but thorough. Focus only on your assigned area.`;

        // Spawn immediately - don't wait
        return runClaudeWithProgressParallel(
          branchPrompt,
          userState.currentPath,
          userState.currentMode,
          (progressText) => {
            // Non-blocking update - fire and forget
            const state = branchState[index];
            const now = Date.now();
            if (progressText && progressText !== state.lastText && now - state.lastUpdate > 800) {
              state.lastUpdate = now;
              state.lastText = progressText;
              const displayText = progressText.length > 3800
                ? progressText.substring(0, 3800) + '...'
                : progressText;
              bot.editMessageText(
                `🔹 *Branch ${index + 1}:* ${branch.substring(0, 40)}...\n\n${displayText} ▌`,
                { chat_id: msg.chat.id, message_id: branchMessages[index].message_id, parse_mode: 'Markdown' }
              ).catch(() => {});
            }
          }
        ).then(async (result) => {
          const finalText = result.text.length > 3800
            ? result.text.substring(0, 3800) + '...\n\n_(truncated)_'
            : result.text;
          bot.editMessageText(
            `✅ *Branch ${index + 1}:* ${branch.substring(0, 40)}...\n\n${finalText}`,
            { chat_id: msg.chat.id, message_id: branchMessages[index].message_id, parse_mode: 'Markdown' }
          ).catch(() => {});

          // Generate voice for this branch (reply to branch message)
          if (userState.voiceEnabled && result.text) {
            try {
              const voiceResult = await generateVoice(result.text, userState.voiceSettings);
              if (voiceResult && voiceResult.buffer) {
                await bot.sendVoice(msg.chat.id, voiceResult.buffer, {
                  caption: `🔊 Branch ${index + 1}`,
                  reply_to_message_id: branchMessages[index].message_id
                }, {
                  filename: `branch-${index + 1}.${voiceResult.format}`,
                  contentType: voiceResult.format === 'wav' ? 'audio/wav' : 'audio/mpeg'
                });
              }
            } catch (voiceErr) {
              console.log(`[Investigate] Voice error branch ${index + 1}:`, voiceErr?.message);
            }
          }

          return { branch, result, index };
        }).catch(error => {
          bot.editMessageText(
            `❌ *Branch ${index + 1}:* ${branch.substring(0, 40)}...\n\nError: ${error.message}`,
            { chat_id: msg.chat.id, message_id: branchMessages[index].message_id, parse_mode: 'Markdown' }
          ).catch(() => {});
          return { branch, error: error.message, index };
        });
      });

      // All processes are now running in parallel - wait for all to complete
      const results = await Promise.all(branchPromises);

      // Update main message to show completion
      await bot.editMessageText(
        `🌳 *Investigation Complete*\n\n📋 Problem: _${problem.substring(0, 80)}${problem.length > 80 ? '...' : ''}_\n\n${branchList}\n\n✅ All ${branches.length} branches completed`,
        { chat_id: msg.chat.id, message_id: mainMsg.message_id, parse_mode: 'Markdown' }
      );

      // Generate and send summary
      const summaryPrompt = `Based on these investigation findings, provide a brief summary and recommended next steps:

Problem: ${problem}

Findings:
${results.map(r => `- ${r.branch}: ${r.error || r.result?.text?.substring(0, 500) || 'No findings'}`).join('\n')}

Provide a 3-5 sentence summary and prioritized action items.`;

      const summaryResult = await runClaudeSimple(summaryPrompt, userState.currentPath, userState.currentMode);
      const summaryMsg = await bot.sendMessage(msg.chat.id, `📊 *Summary*\n\n${summaryResult}`, { parse_mode: 'Markdown' });

      // Generate voice for summary (reply to summary message)
      if (userState.voiceEnabled && summaryResult) {
        try {
          const voiceResult = await generateVoice(summaryResult, userState.voiceSettings);
          if (voiceResult && voiceResult.buffer) {
            await bot.sendVoice(msg.chat.id, voiceResult.buffer, {
              caption: '🔊 Summary',
              reply_to_message_id: summaryMsg.message_id
            }, {
              filename: `summary.${voiceResult.format}`,
              contentType: voiceResult.format === 'wav' ? 'audio/wav' : 'audio/mpeg'
            });
          }
        } catch (voiceErr) {
          console.log('[Investigate] Voice error:', voiceErr?.message);
        }
      }

    } catch (error) {
      bot.editMessageText(`❌ Error: ${error.message}`, {
        chat_id: msg.chat.id,
        message_id: mainMsg.message_id
      });
    } finally {
      userState.isProcessing = false;
    }
  });

  // /cancelall - Cancel all parallel operations
  bot.onText(/\/cancelall/, (msg) => {
    if (!isAuthorized(msg)) return;

    const ops = activeOperations.get(msg.chat.id);
    if (ops && ops.length > 0) {
      ops.forEach(proc => {
        try { proc.kill(); } catch (e) {}
      });
      activeOperations.delete(msg.chat.id);
      bot.sendMessage(msg.chat.id, `🛑 Cancelled ${ops.length} parallel operations`);
    } else {
      bot.sendMessage(msg.chat.id, '✅ No active parallel operations');
    }
  });
}

/**
 * Update perspectives status message
 */
async function updatePerspectivesStatus(bot, chatId, messageId, count, index, status) {
  try {
    const statusLines = [];
    for (let i = 0; i < count; i++) {
      if (i < index) {
        statusLines.push(`${i + 1}. ✅ Done`);
      } else if (i === index) {
        statusLines.push(`${i + 1}. 🔄 ${status || 'Processing...'}`);
      } else {
        statusLines.push(`${i + 1}. ⏳ Waiting...`);
      }
    }

    await bot.editMessageText(
      `🔀 *Perspectives*\n\nGetting ${count} different viewpoints...\n\n${statusLines.join('\n')}`,
      { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
    );
  } catch (e) {}
}

/**
 * Update investigation status message
 */
async function updateInvestigationStatus(bot, chatId, messageId, branches, index, status) {
  try {
    const statusLines = branches.map((b, i) => {
      const shortBranch = b.substring(0, 40) + (b.length > 40 ? '...' : '');
      if (status === 'done' && i === index) {
        return `${i + 1}. ✅ ${shortBranch}`;
      } else if (i === index) {
        return `${i + 1}. 🔄 ${shortBranch}`;
      } else {
        return `${i + 1}. ⏳ ${shortBranch}`;
      }
    });

    await bot.editMessageText(
      `🌳 *Parallel Investigation*\n\n📋 *${branches.length} branches:*\n\n${statusLines.join('\n')}\n\n🔄 Investigating...`,
      { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
    );
  } catch (e) {}
}

/**
 * Run multiple Claude instances in parallel for perspectives
 */
async function runPerspectives(question, cwd, count, mode, onProgress) {
  const perspectivePrompts = [
    `Answer this question with a practical, implementation-focused perspective:\n\n${question}`,
    `Answer this question with a thorough, analytical perspective, considering edge cases:\n\n${question}`,
    `Answer this question with a creative, alternative approach perspective:\n\n${question}`,
    `Answer this question with a critical, devil's advocate perspective - what could go wrong:\n\n${question}`,
    `Answer this question with a simplified, beginner-friendly explanation perspective:\n\n${question}`
  ];

  const promises = [];
  for (let i = 0; i < count; i++) {
    const prompt = perspectivePrompts[i] || `Perspective ${i + 1}: ${question}`;

    promises.push(
      runClaudeWithProgress(prompt, cwd, mode, (status) => onProgress(i, status))
        .then(result => {
          onProgress(i, 'done');
          return result;
        })
        .catch(error => ({ error: error.message }))
    );
  }

  return Promise.all(promises);
}

/**
 * Run Claude with progress - truly parallel version
 * Spawns process immediately, non-blocking callbacks
 */
function runClaudeWithProgressParallel(prompt, cwd, mode, onProgress) {
  return new Promise((resolve, reject) => {
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const modeFlag = getModeFlag(mode);
    const cmd = `claude -p '${escapedPrompt}' --output-format stream-json --verbose ${modeFlag} < /dev/null`;

    // Spawn immediately
    const proc = spawn('bash', ['-c', cmd], {
      cwd: cwd,
      env: { ...process.env, PATH: `/Users/amosdabush/.local/bin:${process.env.PATH}` },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let fullText = '';
    let buffer = '';

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.type === 'assistant' && json.message?.content) {
            for (const block of json.message.content) {
              if (block.type === 'text' && block.text) {
                fullText = block.text;
                // Non-blocking callback
                setImmediate(() => onProgress(fullText));
              }
            }
          } else if (json.type === 'result' && json.result) {
            fullText = json.result;
            setImmediate(() => onProgress(fullText));
          }
        } catch (e) {}
      }
    });

    proc.stderr.on('data', () => {}); // Ignore stderr

    proc.on('close', (code) => {
      resolve({ text: fullText || 'No response', code });
    });

    proc.on('error', reject);

    // Timeout
    setTimeout(() => {
      proc.kill();
      reject(new Error('Timeout'));
    }, 3 * 60 * 1000);
  });
}

/**
 * Run Claude with progress callback (streaming)
 */
function runClaudeWithProgress(prompt, cwd, mode, onProgress) {
  return new Promise((resolve, reject) => {
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const modeFlag = getModeFlag(mode);
    const cmd = `claude -p '${escapedPrompt}' --output-format stream-json --verbose ${modeFlag} < /dev/null`;

    console.log(`[Parallel] Starting Claude: ${prompt.substring(0, 50)}...`);

    const proc = spawn('bash', ['-c', cmd], {
      cwd: cwd,
      env: { ...process.env, PATH: `/Users/amosdabush/.local/bin:${process.env.PATH}` }
    });

    let fullText = '';
    let buffer = '';
    let stderr = '';
    let lastUpdate = Date.now();

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.type === 'assistant' && json.message?.content) {
            for (const block of json.message.content) {
              if (block.type === 'text' && block.text) {
                fullText = block.text;
                // Pass full text to progress callback for streaming updates
                onProgress(fullText);
              }
            }
          } else if (json.type === 'result' && json.result) {
            fullText = json.result;
            onProgress(fullText);
          }
        } catch (e) {
          // Not JSON, might be raw output
          if (line.length > 10 && !line.startsWith('{')) {
            fullText += line + '\n';
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log(`[Parallel] stderr: ${data.toString().substring(0, 200)}`);
    });

    proc.on('close', (code) => {
      console.log(`[Parallel] Completed with code ${code}, text length: ${fullText.length}`);
      if (code !== 0 && !fullText) {
        resolve({ text: `Error (code ${code}): ${stderr.substring(0, 200)}` });
      } else {
        resolve({ text: fullText || 'No response' });
      }
    });

    proc.on('error', (err) => {
      console.log(`[Parallel] Process error: ${err.message}`);
      reject(err);
    });

    // Timeout
    setTimeout(() => {
      proc.kill();
      reject(new Error('Timeout'));
    }, 3 * 60 * 1000);
  });
}

/**
 * Run Claude simple (non-streaming, for quick operations)
 */
function runClaudeSimple(prompt, cwd, mode) {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const modeFlag = getModeFlag(mode);
    const cmd = `claude -p '${escapedPrompt}' ${modeFlag} < /dev/null`;

    exec(cmd, {
      cwd,
      env: { ...process.env, PATH: `/Users/amosdabush/.local/bin:${process.env.PATH}` },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60 * 1000
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout || 'No response');
    });
  });
}

/**
 * Handle parallel-related callbacks
 */
function handleCallback(bot, query, userState) {
  const data = query.data;
  const chatId = query.message.chat.id;

  if (data === 'cmd:perspectives') {
    bot.answerCallbackQuery(query.id, { text: '🔀 Perspectives' });
    bot.sendMessage(chatId,
      `🔀 *Perspectives*\n\nGet multiple viewpoints on the same question.\n\n` +
      `Usage: \`/perspectives [count] <question>\`\n\n` +
      `Examples:\n` +
      `• \`/perspectives what is the best way to handle auth?\`\n` +
      `• \`/perspectives 4 how should we structure the API?\`\n\n` +
      `Count: 2-5 (default: 3)`,
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  if (data === 'cmd:investigate') {
    bot.answerCallbackQuery(query.id, { text: '🌳 Investigate' });
    bot.sendMessage(chatId,
      `🌳 *Parallel Investigation*\n\nBreaks down a problem into branches and investigates each in parallel.\n\n` +
      `Usage: \`/investigate <problem>\`\n\n` +
      `Examples:\n` +
      `• \`/investigate slow rendering on main dashboard\`\n` +
      `• \`/investigate memory leak in background worker\`\n` +
      `• \`/investigate authentication failures in production\`\n\n` +
      `Claude will:\n` +
      `1. Analyze and break down the problem\n` +
      `2. Create 3-5 investigation branches\n` +
      `3. Run all branches in parallel\n` +
      `4. Provide findings and summary`,
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  return false;
}

module.exports = {
  register,
  handleCallback,
  runPerspectives,
  runClaudeWithProgress,
  runClaudeSimple
};

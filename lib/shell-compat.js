/**
 * shell-compat.js — the shell plumbing around the /git and /ls commands.
 *
 * Those handlers run real command lines through runQuickCommand. The commands
 * themselves are portable (git is git), but the plumbing around them is not:
 * `2>/dev/null || echo`, `| head -n`, `ls -la`, `find -type f`, `sed`. None of
 * that exists in PowerShell.
 *
 * Each helper returns a command STRING for the current platform, so the call
 * sites stay one-liners and macOS keeps the exact text it ran before.
 */
const platform = require('./platform');

const IS_WIN = platform.IS_WIN;

/** Current origin URL, or the words "No remote" when there is none. */
const REMOTE_URL = IS_WIN
  ? '$u = git remote get-url origin 2>$null; if ($u) { $u } else { "No remote" }'
  : 'git remote get-url origin 2>/dev/null || echo "No remote"';

/** First n lines of a command's output. */
function head(cmd, n) {
  return IS_WIN ? `${cmd} | Select-Object -First ${n}` : `${cmd} | head -${n}`;
}

/** Long-format directory listing. */
function listDir(dir) {
  return IS_WIN
    ? `Get-ChildItem -Force -LiteralPath "${dir}" | Format-Table Mode, LastWriteTime, Length, Name -AutoSize`
    : `ls -la "${dir}"`;
}

/** Files matching a glob under cwd, capped at n results. */
function findFiles(pattern, n) {
  return IS_WIN
    ? `Get-ChildItem -Recurse -File -Filter "${pattern}" -ErrorAction SilentlyContinue | `
      + `Select-Object -First ${n} | ForEach-Object { Resolve-Path -Relative $_.FullName }`
    : `find . -type f -name "${pattern}" | head -${n}`;
}

/**
 * Directory tree to `depth` levels, hidden dirs excluded, indented per level.
 *
 * The macOS form pipes find through sed to turn each path segment into two
 * spaces of indent; PowerShell has no sed, so the same shape is produced by
 * counting separators in the relative path.
 */
function tree(depth, limit = 50) {
  if (!IS_WIN) {
    return `find . -maxdepth ${depth} -type d -not -path '*/\\.*' 2>/dev/null `
         + `| head -${limit} | sed 's|[^/]*/|  |g'`;
  }
  return `Get-ChildItem -Recurse -Directory -Depth ${depth - 1} -ErrorAction SilentlyContinue `
       + `| Where-Object { $_.FullName -notmatch '\\\\\\.' } `
       + `| Select-Object -First ${limit} `
       + `| ForEach-Object { $r = Resolve-Path -Relative $_.FullName; `
       + `'  ' * (($r -split '\\\\').Count - 2) + $_.Name }`;
}

module.exports = { REMOTE_URL, head, listDir, findFiles, tree };

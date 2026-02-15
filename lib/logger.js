/**
 * Simple logger module
 *
 * Provides different log levels and optional debug mode.
 * Set DEBUG=true in .env to see debug logs.
 */

const DEBUG = process.env.DEBUG === 'true';

/**
 * Info - always logged (important events)
 */
function info(message, ...args) {
  console.log(message, ...args);
}

/**
 * Debug - only logged if DEBUG=true (verbose details)
 */
function debug(message, ...args) {
  if (DEBUG) {
    console.log(`[DEBUG] ${message}`, ...args);
  }
}

/**
 * Error - always logged (errors and warnings)
 */
function error(message, ...args) {
  console.error(message, ...args);
}

/**
 * Warn - always logged (warnings)
 */
function warn(message, ...args) {
  console.warn(message, ...args);
}

module.exports = {
  info,
  debug,
  error,
  warn,
  DEBUG
};

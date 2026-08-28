'use strict';

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(process.cwd(), 'logs', 'audit.log');

/** Append-only JSON-lines log of every backup action, for after-the-fact abuse review. */
async function logAuditEvent(event) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  try {
    await fs.promises.mkdir(path.dirname(LOG_PATH), { recursive: true });
    await fs.promises.appendFile(LOG_PATH, line + '\n');
  } catch (err) {
    console.error('Failed to write audit log entry:', err);
  }
}

module.exports = { logAuditEvent };

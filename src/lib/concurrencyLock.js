'use strict';

// Prevents two /backup runs from hammering the same guild at once
// (accidental resource exhaustion / self-inflicted rate limiting).
const busyGuilds = new Set();

function tryAcquire(guildId) {
  if (busyGuilds.has(guildId)) return false;
  busyGuilds.add(guildId);
  return true;
}

function release(guildId) {
  busyGuilds.delete(guildId);
}

module.exports = { tryAcquire, release };

'use strict';

/**
 * Throttled progress updates for a deferred interaction. Edits are chained
 * so they can never overtake each other or the final reply: call `flush()`
 * before sending the final result.
 */
function createProgressReporter(interaction, intervalMs, render) {
  let lastSentAt = 0;
  let inflight = Promise.resolve();

  return {
    report(data) {
      const now = Date.now();
      if (now - lastSentAt < intervalMs) return;
      lastSentAt = now;
      inflight = inflight.then(() => interaction.editReply(render(data))).catch(() => {});
    },
    flush() {
      return inflight;
    },
  };
}

module.exports = { createProgressReporter };

'use strict';

// Used when Owl Browser credentials are absent. run() is a backstop: the
// runner refuses to queue a task before calling it, so a missing key never
// becomes a successful fake browsing session.

const DEFAULT_MISSING = ['OWL_BROWSER_URL', 'OWL_BROWSER_TOKEN'];

function createUnconfiguredExecutor(missing = DEFAULT_MISSING) {
  const names = Array.isArray(missing) && missing.length ? missing.slice() : DEFAULT_MISSING.slice();
  return {
    name: 'unconfigured',
    simulated: false,
    configured: false,
    missing: names,
    maxWaitMs: 60000,
    async run() {
      const error = new Error('Автоматизация не настроена.');
      error.code = 'automation_not_configured';
      throw error;
    },
  };
}

module.exports = { createUnconfiguredExecutor, DEFAULT_MISSING };

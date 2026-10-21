'use strict';

const NAME = 'local-simulation';

// Kept only so jobs created by older builds can be read. It does not invent a
// video: the next read marks the job failed and names the real providers.
function createLocalSimulationProvider() {
  return {
    name: NAME,
    realVideoGeneration: false,
    start() {},
    refresh(job, now = Date.now()) {
      if (job.status === 'failed' || job.status === 'succeeded') return null;
      return {
        status: 'failed',
        progress: 0,
        completedAt: new Date(now).toISOString(),
        result: null,
        error: {
          code: 'provider_not_configured',
          message:
            'Видео не создано: локальная имитация отключена. Задайте VIDEO_PROVIDER=replicate и REPLICATE_API_TOKEN либо SEEDANCE_API_KEY и SEEDANCE_MODEL.',
        },
      };
    },
    close() {},
  };
}

module.exports = { createLocalSimulationProvider, NAME };

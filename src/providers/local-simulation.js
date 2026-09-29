'use strict';

const NAME = 'local-simulation';

// Local simulation provider: makes no network calls and produces no video.
// Progress is derived lazily from the job's creation time whenever it is read.
function createLocalSimulationProvider({ simulationDurationMs }) {
  return {
    name: NAME,
    realVideoGeneration: false,
    start() {},
    refresh(job, now = Date.now()) {
      if (job.status === 'succeeded') return null;
      const elapsed = now - new Date(job.createdAt).getTime();
      if (elapsed >= simulationDurationMs) {
        return {
          status: 'succeeded',
          progress: 100,
          completedAt: new Date(now).toISOString(),
          result: {
            simulated: true,
            videoUrl: null,
            note:
              'No video was generated. This service runs a local simulation only and is not connected to any video provider.',
          },
        };
      }
      const progress = Math.min(99, Math.floor((elapsed / simulationDurationMs) * 100));
      if (job.status === 'processing' && progress === job.progress) return null;
      return { status: 'processing', progress };
    },
    close() {},
  };
}

module.exports = { createLocalSimulationProvider, NAME };

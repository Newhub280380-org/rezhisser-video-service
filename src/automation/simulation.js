'use strict';

// Local simulation executor: used when Owl Browser is not configured. It does
// not open the site or make any network request; it only walks through the
// steps a real run would take so the dashboard, run history and desktop app
// can be tried end to end. Runs are marked `simulated: true`.

const NAME = 'simulation';

function createSimulationExecutor({ durationMs = 3000, sleep } = {}) {
  const stepMs = Math.max(0, Math.floor(durationMs / 3));
  const wait = sleep || ((ms, signal) => new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  }));

  async function step(ms, signal) {
    await wait(ms, signal);
    if (signal && signal.aborted) {
      const error = new Error('Запуск остановлен: сервер завершает работу.');
      error.code = 'cancelled';
      throw error;
    }
  }

  return {
    name: NAME,
    simulated: true,
    maxWaitMs: durationMs + 60000,
    async run(task, { log = async () => {}, signal } = {}) {
      await log('Режим симуляции: Owl Browser не настроен, сайт не открывается');
      await step(stepMs, signal);
      await log(`Симуляция: открыть ${task.url} (регион ${task.region})`);
      await step(stepMs, signal);
      await log('Симуляция: AI-агент разбирает инструкцию');
      await step(stepMs, signal);
      return {
        summary: 'Симуляция завершена. Чтобы реально выполнять задачи, настройте OWL_BROWSER_URL и OWL_BROWSER_TOKEN.',
      };
    },
  };
}

module.exports = { createSimulationExecutor, NAME };

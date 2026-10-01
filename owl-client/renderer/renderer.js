'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const form = $('task-form');
  const task = $('task');
  const startUrl = $('start-url');
  const run = $('run');
  const stop = $('stop');
  const status = $('status');
  const log = $('log');
  const connection = $('connection');
  const settingsForm = $('settings-form');
  const url = $('url');
  const token = $('token');
  const clearToken = $('clear-token');
  const settingsStatus = $('settings-status');

  function append(text, kind) {
    const line = document.createElement('div');
    if (kind) line.className = kind;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function timeOf(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
  }

  function showConnection(info) {
    connection.textContent = `${info.apiBase} · ${info.hasToken ? 'токен задан' : 'без токена'}`;
    url.value = info.url;
  }

  function setRunning(value) {
    run.disabled = value;
    stop.disabled = !value;
    task.disabled = value;
    startUrl.disabled = value;
    status.textContent = value ? 'Выполняется…' : '';
  }

  window.owl.onLog((entry) => append(`[${timeOf(entry.time)}] ${entry.line}`));

  window.owl.getSettings().then((info) => {
    task.maxLength = info.maxTaskChars;
    showConnection(info);
  }).catch(() => {
    connection.textContent = 'Не удалось загрузить настройки.';
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!task.value.trim()) {
      task.focus();
      return;
    }
    setRunning(true);
    append(`▶ ${task.value.trim()}`, 'task');
    try {
      const result = await window.owl.runTask({ task: task.value, startUrl: startUrl.value });
      if (result.ok) {
        append('✔ Результат:', 'ok');
        append(result.summary, 'result');
      } else {
        append(`✖ ${result.error}`, 'error');
      }
    } catch {
      append('✖ Внутренняя ошибка приложения.', 'error');
    } finally {
      setRunning(false);
    }
  });

  stop.addEventListener('click', () => {
    stop.disabled = true;
    status.textContent = 'Остановка…';
    window.owl.stopTask().catch(() => null);
  });

  $('clear').addEventListener('click', () => {
    log.replaceChildren();
  });

  settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    settingsStatus.textContent = 'Сохранение…';
    const result = await window.owl.saveSettings({ url: url.value, token: token.value, clearToken: clearToken.checked });
    token.value = '';
    clearToken.checked = false;
    if (!result.ok) {
      settingsStatus.textContent = result.error;
      return;
    }
    showConnection(result);
    settingsStatus.textContent = result.tokenPersisted
      ? 'Сохранено.'
      : 'Сохранено. Токен не удалось зашифровать — он действует до закрытия приложения.';
  });
})();

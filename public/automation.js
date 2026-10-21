'use strict';
(function () {
  var TOKEN_KEY = 'rezhisser.token.v1';
  var POLL_MS = 5000;
  var state = { token: null, tasks: [], runs: [], executor: null, editingId: null, pollTimer: null };
  var STATUS_LABELS = { queued: 'В очереди', running: 'Выполняется', succeeded: 'Готово', failed: 'Ошибка' };
  var $ = function (id) { return document.getElementById(id); };

  function showError(node, message) {
    node.textContent = message;
    node.hidden = !message;
  }

  async function api(path, method, body) {
    var headers = { Authorization: 'Bearer ' + state.token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    var response = await fetch(path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    var payload = await response.json();
    if (!response.ok) {
      if (response.status === 401) {
        window.localStorage.removeItem(TOKEN_KEY);
        state.token = null;
        showLogin();
      }
      var messages = {
        invalid_url: 'Укажите корректный адрес http или https.',
        invalid_region: 'Выберите доступный регион.',
        name_required: 'Введите название задачи.',
        instruction_required: 'Добавьте инструкцию.',
        too_many_automation_tasks: 'Можно сохранить не более 100 задач.',
        automation_task_disabled: 'Задача приостановлена. Включите её, чтобы запустить.',
        automation_run_active: 'Эта задача уже выполняется.',
        too_many_active_runs: 'Слишком много одновременных запусков. Дождитесь завершения текущих.',
        automation_busy: 'Очередь запусков заполнена. Попробуйте позже.',
        rate_limit_exceeded: 'Слишком много запросов. Подождите минуту.',
      };
      throw new Error(messages[payload.error] || 'Не удалось выполнить запрос.');
    }
    return payload;
  }

  function showLogin() {
    $('login-required').hidden = Boolean(state.token);
    $('workspace').hidden = !state.token;
  }

  function makeButton(label, handler) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'button';
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
  }

  function isActive(run) {
    return run.status === 'queued' || run.status === 'running';
  }

  function lastRunFor(taskId) {
    for (var i = 0; i < state.runs.length; i += 1) {
      if (state.runs[i].taskId === taskId) return state.runs[i];
    }
    return null;
  }

  function formatTime(value) {
    var date = new Date(value);
    return isNaN(date.getTime()) ? '' : date.toLocaleString('ru-RU');
  }

  function renderExecutor() {
    if (!state.executor) return;
    $('executor-note').textContent = state.executor.configured === false
      ? 'Owl Browser не настроен. Запуск не имитируется. Не задано: ' + (state.executor.missing || ['OWL_BROWSER_URL', 'OWL_BROWSER_TOKEN']).join(', ') + '.'
      : 'Задачи выполняет Owl Browser: он открывает сайт в изолированном контексте, и его AI-агент следует инструкции. Результат и журнал появятся в разделе «Запуски и журнал».';
  }

  function renderRuns() {
    var list = $('run-list');
    list.replaceChildren();
    $('runs-empty').hidden = state.runs.length > 0;
    state.runs.forEach(function (run) {
      var item = document.createElement('li');
      item.className = 'run';
      var titleRow = document.createElement('div');
      titleRow.className = 'task-title-row';
      var title = document.createElement('h3');
      title.textContent = run.taskName;
      var status = document.createElement('span');
      status.className = 'run-status ' + run.status;
      status.textContent = STATUS_LABELS[run.status] || run.status;
      titleRow.append(title, status);
      var meta = document.createElement('p');
      meta.className = 'task-meta';
      meta.textContent = formatTime(run.createdAt) + ' · ' + (run.simulated ? 'Симуляция' : 'Owl Browser') + ' · ' + run.url;
      item.append(titleRow, meta);
      if (run.summary) {
        var summary = document.createElement('p');
        summary.className = 'run-summary';
        summary.textContent = run.summary;
        item.append(summary);
      }
      if (run.error) {
        var error = document.createElement('p');
        error.className = 'error';
        error.textContent = run.error.message;
        item.append(error);
      }
      if (Array.isArray(run.log) && run.log.length > 0) {
        var details = document.createElement('details');
        var label = document.createElement('summary');
        label.textContent = 'Журнал (' + run.log.length + ')';
        var log = document.createElement('ol');
        log.className = 'run-log';
        run.log.forEach(function (entry) {
          var line = document.createElement('li');
          line.textContent = formatTime(entry.at) + ' — ' + entry.message;
          log.append(line);
        });
        details.append(label, log);
        item.append(details);
      }
      list.append(item);
    });
  }

  function schedulePoll() {
    if (state.pollTimer) window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
    if (state.token && state.runs.some(isActive)) state.pollTimer = window.setTimeout(loadRuns, POLL_MS);
  }

  async function loadRuns() {
    showError($('runs-error'), '');
    try {
      var result = await api('/api/automation/runs', 'GET');
      state.runs = result.runs;
      state.executor = result.executor;
      renderExecutor();
      renderRuns();
      renderTasks();
    } catch (error) {
      showError($('runs-error'), error.message);
    }
    schedulePoll();
  }

  async function runTask(task) {
    showError($('list-error'), '');
    try {
      var result = await api('/api/automation/tasks/' + encodeURIComponent(task.id) + '/runs', 'POST');
      state.runs.unshift(result.run);
      renderRuns();
      renderTasks();
      schedulePoll();
    } catch (error) {
      showError($('list-error'), error.message);
    }
  }

  function renderTasks() {
    var list = $('task-list');
    list.replaceChildren();
    var filter = $('task-filter').value;
    var tasks = state.tasks.filter(function (task) {
      return filter === 'all' || (filter === 'enabled' ? task.enabled : !task.enabled);
    });
    $('empty-state').hidden = tasks.length > 0;
    tasks.forEach(function (task) {
      var item = document.createElement('li');
      item.className = 'task';
      var titleRow = document.createElement('div');
      titleRow.className = 'task-title-row';
      var title = document.createElement('h3');
      title.textContent = task.name;
      var stateLabel = document.createElement('span');
      stateLabel.className = 'task-state' + (task.enabled ? '' : ' paused');
      stateLabel.textContent = task.enabled ? 'Активна' : 'Приостановлена';
      titleRow.append(title, stateLabel);
      var link = document.createElement('a');
      link.className = 'task-url';
      link.href = task.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = task.url;
      var instruction = document.createElement('p');
      instruction.className = 'task-instruction';
      instruction.textContent = task.instruction;
      var meta = document.createElement('p');
      meta.className = 'task-meta';
      var lastRun = lastRunFor(task.id);
      meta.textContent = 'Регион: ' + task.region + ' · ' + (lastRun ? 'Последний запуск: ' + (STATUS_LABELS[lastRun.status] || lastRun.status) : 'Запусков ещё не было');
      var actions = document.createElement('div');
      actions.className = 'task-actions';
      var runButton = makeButton(lastRun && isActive(lastRun) ? 'Выполняется…' : 'Запустить', function () { runTask(task); });
      runButton.classList.add('primary');
      runButton.disabled = !task.enabled || Boolean(lastRun && isActive(lastRun));
      if (!task.enabled) runButton.title = 'Задача приостановлена';
      actions.append(
        runButton,
        makeButton('Изменить', function () { editTask(task); }),
        makeButton('Удалить', function () { deleteTask(task); }),
      );
      item.append(titleRow, link, instruction, meta, actions);
      list.append(item);
    });
  }

  async function loadTasks() {
    showError($('list-error'), '');
    try {
      var result = await api('/api/automation/tasks', 'GET');
      state.tasks = result.tasks;
      renderTasks();
    } catch (error) {
      showError($('list-error'), error.message);
    }
  }

  function resetForm() {
    state.editingId = null;
    $('task-form').reset();
    $('task-enabled').checked = true;
    $('form-title').textContent = 'Новая задача';
    $('save-button').textContent = 'Сохранить';
    $('cancel-edit').hidden = true;
    showError($('form-error'), '');
  }

  function editTask(task) {
    state.editingId = task.id;
    $('task-name').value = task.name;
    $('task-url').value = task.url;
    $('task-instruction').value = task.instruction;
    $('task-region').value = task.region;
    $('task-enabled').checked = task.enabled;
    $('form-title').textContent = 'Изменить задачу';
    $('save-button').textContent = 'Сохранить изменения';
    $('cancel-edit').hidden = false;
    $('task-name').focus();
  }

  async function deleteTask(task) {
    if (!window.confirm('Удалить задачу «' + task.name + '»?')) return;
    try {
      await api('/api/automation/tasks/' + encodeURIComponent(task.id), 'DELETE');
      state.tasks = state.tasks.filter(function (item) { return item.id !== task.id; });
      state.runs = state.runs.filter(function (run) { return run.taskId !== task.id; });
      renderTasks();
      renderRuns();
      if (state.editingId === task.id) resetForm();
    } catch (error) {
      showError($('list-error'), error.message);
    }
  }

  $('task-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    var payload = {
      name: $('task-name').value,
      url: $('task-url').value,
      instruction: $('task-instruction').value,
      region: $('task-region').value,
      enabled: $('task-enabled').checked,
    };
    var button = $('save-button');
    var submittedId = state.editingId;
    button.disabled = true;
    showError($('form-error'), '');
    try {
      var path = '/api/automation/tasks' + (submittedId ? '/' + encodeURIComponent(submittedId) : '');
      var result = await api(path, submittedId ? 'PUT' : 'POST', payload);
      if (submittedId) state.tasks = state.tasks.map(function (task) { return task.id === result.task.id ? result.task : task; });
      else state.tasks.unshift(result.task);
      renderTasks();
      if (state.editingId === submittedId) resetForm();
    } catch (error) {
      showError($('form-error'), error.message);
    } finally {
      button.disabled = false;
    }
  });

  $('cancel-edit').addEventListener('click', resetForm);
  $('task-filter').addEventListener('change', renderTasks);
  $('refresh-runs').addEventListener('click', loadRuns);
  try {
    state.token = window.localStorage.getItem(TOKEN_KEY);
  } catch {
    state.token = null;
  }
  showLogin();
  if (state.token) loadTasks().then(loadRuns);
}());

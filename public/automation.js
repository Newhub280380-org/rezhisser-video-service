'use strict';
(function () {
  var TOKEN_KEY = 'rezhisser.token.v1';
  var state = { token: null, tasks: [], editingId: null };
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
      meta.textContent = 'Регион: ' + task.region + ' · Запуск не настроен';
      var actions = document.createElement('div');
      actions.className = 'task-actions';
      actions.append(
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
      renderTasks();
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
  try {
    state.token = window.localStorage.getItem(TOKEN_KEY);
  } catch {
    state.token = null;
  }
  showLogin();
  if (state.token) loadTasks();
}());

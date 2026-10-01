'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_DIR, ROUTES } = require('../src/static.js');
const { fakeServices, productionOptions, accountClient, withServer } = require('./helpers/production.js');

test('automation task API requires login and supports user-isolated create, edit, list and delete', async () => {
  const services = fakeServices();
  await withServer(productionOptions(services), async ({ base }) => {
    assert.equal((await accountClient(base).get('/api/automation/tasks')).status, 401);

    const alice = accountClient(base);
    const bob = accountClient(base);
    assert.equal((await alice.register('automation-alice@example.com')).status, 201);
    assert.equal((await bob.register('automation-bob@example.com')).status, 201);

    const created = await alice.post('/api/automation/tasks', {
      name: 'Example task',
      url: 'https://example.com/work',
      instruction: 'Review the page and stop before submitting.',
      region: 'EU',
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.task.region, 'EU');
    assert.equal(created.json.task.enabled, true);
    assert.equal(created.json.task.userId, undefined);
    const taskId = created.json.task.id;

    assert.deepEqual((await alice.get('/api/automation/tasks')).json.tasks.map((task) => task.id), [taskId]);
    assert.deepEqual((await bob.get('/api/automation/tasks')).json.tasks, []);
    assert.equal((await bob.request('PUT', `/api/automation/tasks/${taskId}`, { enabled: false })).status, 404);

    const updated = await alice.request('PUT', `/api/automation/tasks/${taskId}`, { enabled: false, name: 'Updated task' });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.task.name, 'Updated task');
    assert.equal(updated.json.task.enabled, false);
    assert.equal((await alice.del(`/api/automation/tasks/${taskId}`)).status, 200);
    assert.deepEqual((await alice.get('/api/automation/tasks')).json.tasks, []);
  });
});

test('automation tasks validate URLs, regions, and required instructions', async () => {
  const services = fakeServices();
  await withServer(productionOptions(services), async ({ base }) => {
    const api = accountClient(base);
    assert.equal((await api.register('automation-validation@example.com')).status, 201);
    const valid = { name: 'Task', url: 'https://example.com', instruction: 'Do a safe check.' };
    for (const [changes, error] of [
      [{ url: 'javascript:alert(1)' }, 'invalid_url'],
      [{ url: '******example.com' }, 'invalid_url'],
      [{ region: 'XX' }, 'invalid_region'],
      [{ instruction: '   ' }, 'instruction_required'],
      [{ enabled: 'false' }, 'invalid_enabled'],
    ]) {
      const result = await api.post('/api/automation/tasks', { ...valid, ...changes });
      assert.equal(result.status, 400);
      assert.equal(result.json.error, error);
    }
  });
});

test('concurrent automation task creates enforce the per-account limit', async () => {
  const services = fakeServices();
  await withServer(productionOptions(services), async ({ base, app }) => {
    const api = accountClient(base);
    const email = 'automation-limit@example.com';
    assert.equal((await api.register(email)).status, 201);
    const user = await app.db.getUserByEmail(email);
    for (let i = 0; i < 99; i += 1) {
      await app.db.createAutomationTask({
        id: crypto.randomUUID(),
        userId: user.id,
        name: `Task ${i}`,
        url: 'https://example.com/',
        instruction: 'Review the page.',
        region: 'US',
      });
    }

    const payload = { name: 'Final task', url: 'https://example.com/', instruction: 'Review the page.' };
    const results = await Promise.all([
      api.post('/api/automation/tasks', payload),
      api.post('/api/automation/tasks', payload),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    assert.equal((await app.db.listAutomationTasks(user.id, { limit: 101 })).length, 100);
  });
});

test('automation task routes report missing rows when mutations lose a race', async () => {
  const services = fakeServices();
  await withServer(productionOptions(services), async ({ base, app }) => {
    const api = accountClient(base);
    assert.equal((await api.register('automation-race@example.com')).status, 201);
    const created = await api.post('/api/automation/tasks', {
      name: 'Task',
      url: 'https://example.com/',
      instruction: 'Review the page.',
    });
    const { id } = created.json.task;

    const malformedId = await api.del('/api/automation/tasks/%');
    assert.equal(malformedId.status, 404);
    assert.equal(malformedId.json.error, 'automation_task_not_found');

    const update = app.db.updateAutomationTask;
    app.db.updateAutomationTask = async () => null;
    const updated = await api.request('PUT', `/api/automation/tasks/${id}`, { name: 'Updated task' });
    assert.equal(updated.status, 404);
    assert.equal(updated.json.error, 'automation_task_not_found');
    app.db.updateAutomationTask = update;

    app.db.deleteAutomationTask = async () => false;
    const deleted = await api.del(`/api/automation/tasks/${id}`);
    assert.equal(deleted.status, 404);
    assert.equal(deleted.json.error, 'automation_task_not_found');
  });
});

test('automation dashboard is allowlisted and uses safe same-origin API rendering', async () => {
  const services = fakeServices();
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'automation.html'), 'utf8');
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'automation.js'), 'utf8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'automation.css'), 'utf8');
  assert.ok(ROUTES['/automation']);
  assert.ok(ROUTES['/assets/automation.js']);
  assert.ok(ROUTES['/assets/automation.css']);
  assert.match(html, /Исполнение задач/);
  assert.match(html, /Запуски и журнал/);
  assert.match(html, /id="run-list"/);
  assert.match(js, /\/api\/automation\/tasks/);
  assert.match(js, /\/api\/automation\/runs/);
  assert.match(js, /'\/runs', 'POST'/);
  assert.match(js, /textContent/);
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(']) assert.ok(!js.includes(sink));
  assert.doesNotMatch(html + js + css, /https?:\/\/(?!example\.com)/i);

  await withServer(productionOptions(services), async ({ base }) => {
    const page = await fetch(`${base}/automation`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(await page.text(), /режиме симуляции/);
    assert.equal((await fetch(`${base}/assets/automation.js`)).status, 200);
    assert.equal((await fetch(`${base}/assets/automation.css`)).status, 200);
  });
});

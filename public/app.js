/* Режиссёр — клиент. Без зависимостей. Все пользовательские строки выводятся
   только через textContent / DOM API (никакого innerHTML). Никаких секретов:
   ключ беты отправляется на сервер один раз и не сохраняется. */
(function () {
  'use strict';

  var HISTORY_KEY = 'rezhisser.history.v1';
  var REQUEST_TIMEOUT_MS = 20000;
  var POLL_INTERVAL_MS = 4000;
  var POLL_MAX_MS = 20 * 60 * 1000;

  var STATUS_LABELS = {
    queued: 'В очереди',
    processing: 'Идёт рендер',
    succeeded: 'Готово',
    failed: 'Ошибка',
  };

  var ERROR_MESSAGES = {
    product_required: 'Укажите, что рекламируем.',
    rate_limit_exceeded: 'Слишком много запросов. Подождите немного и повторите.',
    auth_required: 'Нужен вход в закрытую бету.',
    csrf_failed: 'Сессия устарела. Обновите страницу и войдите снова.',
    paid_generation_locked: 'Платная генерация закрыта на сервере.',
    invalid_access_key: 'Неверный ключ доступа.',
    too_many_login_attempts: 'Слишком много попыток входа. Попробуйте позже.',
    access_control_not_configured: 'Вход в бету на сервере не настроен.',
    provider_busy: 'Сейчас уже идёт платная генерация. Попробуйте через минуту.',
    quote_expired: 'Оценка устарела — запросите новую.',
    quote_mismatch: 'Бриф изменился после оценки — запросите новую.',
    payload_too_large: 'Слишком большой запрос (вероятно, фото).',
    job_not_found: 'Задание не найдено: сервер перезапускался, а хранилище на бесплатном тарифе не сохраняется.',
  };

  var state = {
    config: null,
    session: { authenticated: false, csrfToken: null },
    plan: null,
    selection: null,
    image: null,
    quote: null,
    idempotencyKey: null,
    stale: false,
    aspectTouched: false,
    pollTimer: null,
    pollJobId: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'text') node.textContent = String(value);
        else if (key === 'className') node.className = value;
        else if (key === 'dataset') Object.keys(value).forEach(function (k) { node.dataset[k] = value[k]; });
        else if (key.indexOf('on') === 0 && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : String(value));
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function show(node, visible) {
    node.hidden = !visible;
  }

  function setBusy(button, busy) {
    button.disabled = Boolean(busy);
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function showError(node, message) {
    if (!message) {
      node.textContent = '';
      show(node, false);
      return;
    }
    node.textContent = message;
    show(node, true);
  }

  function formatUsd(value) {
    return '$' + Number(value).toFixed(2);
  }

  function isHttpsUrl(value) {
    if (typeof value !== 'string') return false;
    try {
      return new URL(value).protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  function randomKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function errorText(data, status) {
    var message = '';
    if (data && data.message) message = data.message;
    else if (data && data.error && ERROR_MESSAGES[data.error]) message = ERROR_MESSAGES[data.error];
    else if (status >= 500) message = 'Сервер ответил ошибкой (' + status + '). Попробуйте ещё раз.';
    else message = 'Не получилось выполнить запрос' + (data && data.error ? ' (' + data.error + ')' : '') + '.';
    if (data && data.missing && data.missing.length) message += ' Не задано: ' + data.missing.join(', ') + '.';
    return message;
  }

  // fetch wrapper: same-origin only, timeout, JSON in/out, CSRF header.
  function api(path, options) {
    options = options || {};
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, options.timeoutMs || REQUEST_TIMEOUT_MS);
    var headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.csrf && state.session.csrfToken) headers['X-CSRF-Token'] = state.session.csrfToken;
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () { return null; })
          .then(function (data) {
            return { ok: res.ok, status: res.status, data: data, retryAfter: Number(res.headers.get('Retry-After')) || 0 };
          });
      })
      .catch(function (error) {
        var timedOut = error && error.name === 'AbortError';
        var err = new Error(
          timedOut
            ? 'Сервер не ответил вовремя. На бесплатном тарифе Render сервис «просыпается» до минуты — попробуйте ещё раз.'
            : 'Нет связи с сервером. Проверьте интернет и попробуйте снова.',
        );
        err.network = true;
        throw err;
      })
      .finally(function () { clearTimeout(timer); });
  }

  /* ---------------- Config & session ---------------- */

  function loadConfig() {
    showError($('global-error-text'), '');
    show($('global-error'), false);
    return api('/api/config')
      .then(function (res) {
        if (!res.ok) throw new Error(errorText(res.data, res.status));
        state.config = res.data;
        state.session.authenticated = Boolean(res.data.auth && res.data.auth.authenticated);
        populateForm(res.data.options);
        return state.session.authenticated ? refreshSession() : null;
      })
      .then(function () {
        renderModeBadge();
        renderModels();
      })
      .catch(function (error) {
        $('global-error-text').textContent = 'Не удалось загрузить настройки. ' + error.message;
        show($('global-error'), true);
      });
  }

  function refreshSession() {
    return api('/api/session').then(function (res) {
      if (res.ok && res.data && res.data.authenticated) {
        state.session = { authenticated: true, csrfToken: res.data.csrfToken, spend: res.data.spend };
      } else {
        state.session = { authenticated: false, csrfToken: null };
      }
    });
  }

  function paidAvailable() {
    return Boolean(state.config && state.config.paid && state.config.paid.available && state.session.authenticated);
  }

  function renderModeBadge() {
    var badge = $('mode-badge');
    var note = $('honesty-note');
    var paid = paidAvailable();
    badge.dataset.mode = paid ? 'paid' : 'demo';
    badge.textContent = paid ? 'Бета: доступна платная генерация (с подтверждением)' : 'Провайдер не настроен';
    note.dataset.mode = paid ? 'paid' : 'demo';
    clear(note);
    if (paid) {
      note.appendChild(el('strong', { text: 'Внимание: платная генерация включена. ' }));
      note.appendChild(document.createTextNode('Режим «Настоящее видео» обращается к внешнему провайдеру и тратит деньги. Перед каждым запуском вы увидите оценку и подтвердите её.'));
    } else {
      note.appendChild(document.createTextNode('Раскадровка строится по правилам, без нейросети. Видео не имитируется: если провайдер не настроен, сервис перечисляет, какие ключи не заданы.'));
      var missing = [];
      var integrations = state.config && state.config.integrations;
      if (integrations) {
        ['replicate', 'seedance'].forEach(function (name) {
          var item = integrations[name];
          if (item && item.missing) missing = missing.concat(item.missing);
        });
      }
      if (missing.length) note.appendChild(document.createTextNode(' Не задано: ' + missing.join(', ') + '.'));
    }

    show($('beta-chip'), state.session.authenticated);
    show($('logout-btn'), state.session.authenticated);
    show($('login-btn'), !state.session.authenticated);

    var paidRadio = $('tier-paid');
    paidRadio.disabled = !paid;
    if (!paid && paidRadio.checked) document.querySelector('input[name="tier"][value="demo"]').checked = true;
    var reason = $('tier-paid-reason');
    if (paid) {
      reason.textContent = 'Платно · только с подтверждением';
    } else if (state.config && state.config.paid && !state.config.paid.available) {
      var first = state.config.paid.reasons && state.config.paid.reasons[0];
      reason.textContent = 'Закрыто: ' + (first ? first.message : 'сервер не настроен');
    } else {
      reason.textContent = 'Закрыто: войдите в бету';
    }
  }

  /* ---------------- Form ---------------- */

  function populateForm(options) {
    fillSelect($('f-goal'), options.goals, 'awareness');
    fillSelect($('f-platform'), options.platforms, 'reels');
    fillSelect($('f-voice'), options.voices, 'none');
    fillSelect(
      $('f-aspect'),
      options.aspects.map(function (a) { return { value: a, label: aspectLabel(a) }; }),
      '9:16',
    );

    var durations = $('f-duration');
    Array.prototype.slice.call(durations.querySelectorAll('.chip')).forEach(function (n) { n.remove(); });
    options.durations.forEach(function (d) {
      durations.appendChild(
        el('label', { className: 'chip' }, [
          el('input', { type: 'radio', name: 'duration', value: String(d), checked: d === 10 }),
          el('span', { text: d + ' сек' }),
        ]),
      );
    });

    var moods = $('f-mood');
    clear(moods);
    options.moods.forEach(function (m, index) {
      moods.appendChild(
        el('label', { className: 'mood', dataset: { mood: m.value } }, [
          el('input', { type: 'radio', name: 'mood', value: m.value, checked: index === 0 }),
          el('span', { text: m.label }),
        ]),
      );
    });

    $('f-product').maxLength = options.limits.product;
  }

  function aspectLabel(aspect) {
    return {
      '9:16': '9:16 — вертикальный',
      '16:9': '16:9 — горизонтальный',
      '1:1': '1:1 — квадрат',
      '4:5': '4:5 — лента',
    }[aspect] || aspect;
  }

  function fillSelect(select, items, selected) {
    clear(select);
    items.forEach(function (item) {
      select.appendChild(el('option', { value: item.value, text: item.label, selected: item.value === selected }));
    });
  }

  function currentTier() {
    var checked = document.querySelector('input[name="tier"]:checked');
    return checked ? checked.value : 'demo';
  }

  function renderModels() {
    if (!state.config) return;
    var select = $('f-model');
    var previous = select.value;
    var tier = currentTier();
    clear(select);
    select.appendChild(el('option', { value: 'auto', text: 'Авто — режиссёр выберет сам' }));
    state.config.models
      .filter(function (m) { return tier === 'paid' ? m.paid : !m.paid; })
      .forEach(function (m) {
        var suffix = m.paid
          ? typeof m.estimatedCostUsd === 'number'
            ? ' · ~' + formatUsd(m.estimatedCostUsd)
            : ''
          : ' · без генерации';
        select.appendChild(el('option', { value: m.id, text: m.label + ' — ' + m.kindLabel + suffix }));
      });
    if (Array.prototype.some.call(select.options, function (o) { return o.value === previous; })) select.value = previous;
  }

  function readBrief() {
    var form = $('brief-form');
    var data = new FormData(form);
    return {
      product: String(data.get('product') || ''),
      offer: String(data.get('offer') || ''),
      audience: String(data.get('audience') || ''),
      goal: String(data.get('goal') || ''),
      platform: String(data.get('platform') || ''),
      aspect: String(data.get('aspect') || ''),
      duration: Number(data.get('duration') || 10),
      mood: String(data.get('mood') || ''),
      voice: String(data.get('voice') || ''),
      cta: String(data.get('cta') || ''),
      notes: String(data.get('notes') || ''),
    };
  }

  function fillExample() {
    $('f-product').value = 'Холодный кофе «Утро» в банке';
    $('f-offer').value = 'Без сахара, бодрит на 4 часа';
    $('f-audience').value = 'Студенты и айтишники 20–30 лет';
    $('f-goal').value = 'launch';
    $('f-platform').value = 'reels';
    $('f-aspect').value = '9:16';
    $('f-voice').value = 'ironic';
    $('f-cta').value = 'Попробуйте первым';
    $('f-notes').value = 'Логотип в финальном кадре';
    var mood = document.querySelector('input[name="mood"][value="energetic"]');
    if (mood) mood.checked = true;
    var dur = document.querySelector('input[name="duration"][value="10"]');
    if (dur) dur.checked = true;
    $('f-product').setAttribute('aria-invalid', 'false');
    markStale();
    $('f-product').focus();
  }

  function markStale() {
    if (!state.plan) return;
    state.stale = true;
    resetQuote();
    $('demo-render-btn').disabled = true;
    $('quote-btn').disabled = true;
    showError($('render-error'), 'Бриф изменён — нажмите «Собрать раскадровку» ещё раз, чтобы обновить план перед рендером.');
  }

  /* ---------------- Image ---------------- */

  function loadImageElement(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Не удалось прочитать изображение.'));
      };
      img.src = url;
    });
  }

  function dataUrlBytes(dataUrl) {
    var base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  }

  // Downscales/compresses to JPEG until it fits the server limit.
  function compressImage(img, maxBytes) {
    var side = 1280;
    var quality = 0.86;
    for (var attempt = 0; attempt < 12; attempt += 1) {
      var scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      var dataUrl = canvas.toDataURL('image/jpeg', quality);
      var bytes = dataUrlBytes(dataUrl);
      if (bytes <= maxBytes) return { dataUrl: dataUrl, bytes: bytes, width: canvas.width, height: canvas.height };
      if (quality > 0.6) quality -= 0.1;
      else side = Math.round(side * 0.8);
    }
    throw new Error('Не удалось уменьшить фото до допустимого размера.');
  }

  function onImageChange(event) {
    var file = event.target.files && event.target.files[0];
    showError($('form-error'), '');
    if (!file) return;
    if (['image/png', 'image/jpeg', 'image/webp'].indexOf(file.type) === -1) {
      showError($('form-error'), 'Нужна картинка PNG, JPEG или WebP.');
      event.target.value = '';
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      showError($('form-error'), 'Файл слишком большой (больше 25 МБ).');
      event.target.value = '';
      return;
    }
    var maxBytes = (state.config && state.config.limits.imageMaxBytes) || 262144;
    loadImageElement(file)
      .then(function (img) {
        state.image = compressImage(img, maxBytes);
        $('image-preview-img').src = state.image.dataUrl;
        $('image-preview-meta').textContent =
          state.image.width + '×' + state.image.height + ' · ' + Math.round(state.image.bytes / 1024) + ' КБ (сжато для отправки)';
        show($('image-preview'), true);
        markStale();
      })
      .catch(function (error) {
        state.image = null;
        showError($('form-error'), error.message);
      })
      .finally(function () {
        event.target.value = '';
      });
  }

  function removeImage() {
    state.image = null;
    $('image-preview-img').removeAttribute('src');
    show($('image-preview'), false);
    markStale();
    $('f-image').focus();
  }

  /* ---------------- Plan ---------------- */

  function requestPlan(event) {
    event.preventDefault();
    var brief = readBrief();
    showError($('form-error'), '');
    if (!brief.product.trim()) {
      $('f-product').setAttribute('aria-invalid', 'true');
      showError($('form-error'), 'Укажите, что рекламируем.');
      $('f-product').focus();
      return;
    }
    $('f-product').setAttribute('aria-invalid', 'false');
    var button = $('plan-btn');
    setBusy(button, true);
    $('plan').setAttribute('aria-busy', 'true');
    show($('plan-empty'), false);
    show($('plan-body'), false);
    show($('plan-loading'), true);

    api('/api/director/plan', {
      method: 'POST',
      body: { brief: brief, tier: currentTier(), modelId: $('f-model').value, hasImage: Boolean(state.image) },
    })
      .then(function (res) {
        if (!res.ok) {
          show($('plan-empty'), !state.plan);
          show($('plan-body'), Boolean(state.plan));
          var message = errorText(res.data, res.status);
          if (res.data && res.data.details && res.data.details.rejected) {
            message += ' ' + res.data.details.rejected.map(function (r) { return r.label + ': ' + r.reason; }).join(' ');
          }
          showError($('form-error'), message);
          return;
        }
        state.plan = res.data.plan;
        state.selection = res.data.selection;
        state.stale = false;
        renderPlan();
        var heading = $('plan-title');
        heading.setAttribute('tabindex', '-1');
        if (window.matchMedia('(max-width: 1059px)').matches) heading.focus();
      })
      .catch(function (error) {
        show($('plan-empty'), !state.plan);
        show($('plan-body'), Boolean(state.plan));
        showError($('form-error'), error.message);
      })
      .finally(function () {
        setBusy(button, false);
        show($('plan-loading'), false);
        $('plan').setAttribute('aria-busy', 'false');
      });
  }

  function kvList(container, rows) {
    clear(container);
    rows.forEach(function (row) {
      container.appendChild(el('dt', { text: row[0] }));
      container.appendChild(el('dd', { text: row[1] }));
    });
  }

  function renderPlan() {
    var plan = state.plan;
    show($('plan-body'), true);
    show($('plan-empty'), false);
    show($('engine-badge'), true);
    $('plan-hook').textContent = plan.hook;
    $('plan-cta').textContent = plan.cta;

    var cb = plan.creativeBrief;
    kvList($('plan-creative'), [
      ['Задача', cb.objective],
      ['Площадка', cb.platform],
      ['Формат', cb.format],
      ['Аудитория', cb.audience],
      ['Ключевое сообщение', cb.keyMessage],
      ['Тон', cb.tone],
      ['Обязательно', cb.mandatory],
    ]);
    var vd = plan.visualDirection;
    kvList($('plan-visual'), [
      ['Настроение', vd.mood],
      ['Палитра', vd.palette],
      ['Свет', vd.lighting],
      ['Камера', vd.camera],
      ['Ритм', vd.pacing],
      ['Типографика', vd.typography],
    ]);

    var shots = $('plan-shots');
    clear(shots);
    plan.shots.forEach(function (shot) {
      shots.appendChild(
        el('li', { className: 'shot' }, [
          el('div', { className: 'shot-frame', dataset: { ar: plan.brief.aspect }, 'aria-hidden': 'true', text: String(shot.n) }),
          el('span', { className: 'shot-time', text: formatTime(shot.start) + ' – ' + formatTime(shot.end) }),
          el('span', { className: 'shot-title', text: 'Кадр ' + shot.n + ' · ' + shot.title }),
          el('p', { className: 'shot-visual', text: shot.visual }),
          shot.onScreenText ? el('p', { className: 'shot-text', text: shot.onScreenText }) : null,
          el('p', { text: 'Звук: ' + shot.audio }),
        ]),
      );
    });

    renderSelection();

    $('plan-prompt').textContent = plan.modelPrompt;
    var notes = $('plan-notes');
    clear(notes);
    plan.notes.forEach(function (n) { notes.appendChild(el('li', { text: n })); });
    $('plan-disclaimer').textContent = plan.disclaimer;

    var paid = Boolean(state.selection && state.selection.model.paid);
    show($('render-demo'), !paid);
    show($('render-paid'), paid);
    $('demo-render-btn').disabled = false;
    $('quote-btn').disabled = false;
    resetQuote();
    showError($('render-error'), '');
  }

  function formatTime(seconds) {
    var s = Number(seconds);
    return '0:' + (s < 10 ? '0' : '') + s.toFixed(s % 1 ? 1 : 0);
  }

  function renderSelection() {
    var card = $('selection-card');
    clear(card);
    var sel = state.selection;
    var model = sel.model;
    card.appendChild(
      el('div', { className: 'selection-head' }, [
        el('strong', { text: model.label }),
          el('span', { className: 'badge ' + (model.paid ? 'badge-paid' : 'badge-demo'), text: model.paid ? 'Платно' : 'Без генерации' }),
        el('span', { className: 'badge badge-kind', text: model.kindLabel }),
        el('span', { className: 'badge badge-kind', text: sel.mode === 'auto' ? 'Выбрано автоматически' : 'Выбрано вручную' }),
      ]),
    );
    if (model.description) card.appendChild(el('p', { className: 'hint', text: model.description }));
    var list = el('ul');
    sel.rationale.forEach(function (line) { list.appendChild(el('li', { text: line })); });
    card.appendChild(list);
    if (model.paid) {
      var estimateText =
        typeof sel.estimateUsd === 'number'
          ? 'Оценка оператора: ~' + formatUsd(sel.estimateUsd) + ' за клип ' + sel.clipDuration + ' сек' +
            (model.priceVerifiedAt ? ' (цена проверена ' + model.priceVerifiedAt + ')' : '') + '. Точную сумму определяет провайдер.'
          : 'Оценка стоимости для этой модели не задана — платный запуск невозможен.';
      card.appendChild(el('p', { text: estimateText }));
      if (model.providerModel) card.appendChild(el('p', { className: 'hint', text: 'Модель провайдера: ' + model.providerModel }));
    }
    if (sel.rejected && sel.rejected.length) {
      var details = el('details', null, [el('summary', { text: 'Почему не другие модели (' + sel.rejected.length + ')' })]);
      var ul = el('ul');
      sel.rejected.forEach(function (r) { ul.appendChild(el('li', { text: r.label + ': ' + r.reason })); });
      details.appendChild(ul);
      card.appendChild(details);
    }
  }

  function copyPrompt() {
    var text = state.plan ? state.plan.modelPrompt : '';
    var button = $('copy-prompt');
    var done = function (ok) {
      button.textContent = ok ? 'Скопировано ✓' : 'Выделите текст и скопируйте вручную';
      setTimeout(function () { button.textContent = 'Скопировать промпт'; }, 2500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  }

  /* ---------------- Rendering jobs ---------------- */

  function jobRequestBody(extra) {
    var body = { brief: state.plan.brief, modelId: state.selection.model.id, tier: state.selection.model.paid ? 'paid' : 'demo' };
    if (state.image) body.image = state.image.dataUrl;
    Object.keys(extra || {}).forEach(function (k) { body[k] = extra[k]; });
    return body;
  }

  function startDemo() {
    if (!state.plan || state.stale) return;
    var button = $('demo-render-btn');
    setBusy(button, true);
    showError($('render-error'), '');
    api('/api/jobs', { method: 'POST', body: jobRequestBody() })
      .then(function (res) {
        if (!res.ok) {
          showError($('render-error'), errorText(res.data, res.status));
          return;
        }
        onJobCreated(res.data.job);
      })
      .catch(function (error) { showError($('render-error'), error.message); })
      .finally(function () { setBusy(button, false); });
  }

  function resetQuote() {
    state.quote = null;
    state.idempotencyKey = null;
    show($('quote'), false);
    $('quote-confirm').checked = false;
    $('paid-render-btn').disabled = true;
  }

  function requestQuote() {
    if (!state.plan || state.stale) return;
    var button = $('quote-btn');
    setBusy(button, true);
    resetQuote();
    showError($('render-error'), '');
    api('/api/quotes', { method: 'POST', csrf: true, body: jobRequestBody() })
      .then(function (res) {
        if (!res.ok) {
          showError($('render-error'), errorText(res.data, res.status));
          return;
        }
        state.quote = res.data.quote;
        state.idempotencyKey = randomKey();
        renderQuote(res.data);
      })
      .catch(function (error) { showError($('render-error'), error.message); })
      .finally(function () { setBusy(button, false); });
  }

  function renderQuote(data) {
    var quote = data.quote;
    $('quote-price').textContent = '~' + formatUsd(quote.estimateUsd) + ' за клип ' + quote.clipDuration + ' сек';
    var expires = new Date(quote.expiresAt);
    $('quote-meta').textContent =
      'Оценка оператора' + (quote.priceVerifiedAt ? ', цена проверена ' + quote.priceVerifiedAt : '') +
      '. Действует до ' + expires.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + '.';
    var warnings = $('quote-warnings');
    clear(warnings);
    quote.warnings.forEach(function (w) { warnings.appendChild(el('li', { text: w })); });
    var s = data.spend;
    $('quote-budget').textContent =
      'Остаток на сегодня: ' + formatUsd(s.remainingTodayUsd) + ' из ' + formatUsd(s.dailyBudgetUsd) +
      ' · генераций сегодня осталось: ' + s.remainingJobsToday + ' · всего осталось: ' + s.remainingTotalJobs +
      '. Счётчики сбрасываются при перезапуске сервера без постоянного диска.';
    show($('quote'), true);
    $('quote-confirm').focus();
  }

  function startPaid() {
    if (!state.quote || !$('quote-confirm').checked || state.stale) return;
    var button = $('paid-render-btn');
    setBusy(button, true);
    showError($('render-error'), '');
    api('/api/jobs', {
      method: 'POST',
      csrf: true,
      body: jobRequestBody({ quoteId: state.quote.id, confirmPaid: true, idempotencyKey: state.idempotencyKey }),
    })
      .then(function (res) {
        if (!res.ok) {
          showError($('render-error'), errorText(res.data, res.status));
          setBusy(button, false);
          return;
        }
        onJobCreated(res.data.job);
        resetQuote();
        setBusy(button, false);
        button.disabled = true;
      })
      .catch(function (error) {
        // Keep the same idempotency key: retrying cannot start a second paid job.
        showError($('render-error'), error.message + ' Повторное нажатие безопасно: второй платный запуск не создастся.');
        setBusy(button, false);
      });
  }

  function onJobCreated(job) {
    addHistory(job);
    renderJob(job);
    startPolling(job.id);
    $('jobs').scrollIntoView({ block: 'start' });
  }

  function renderJob(job) {
    var box = $('job-current');
    clear(box);
    show(box, true);
    var title = (job.brief && job.brief.product) || job.prompt || 'Ролик';
    box.appendChild(
      el('div', { className: 'job-head' }, [
        el('strong', { text: title }),
        job.simulated
          ? el('span', { className: 'badge badge-demo', text: 'Демо · видео не создавалось' })
          : el('span', { className: 'badge badge-real', text: 'Настоящая генерация · платно' }),
        el('span', { className: 'badge badge-kind', text: STATUS_LABELS[job.status] || job.status }),
      ]),
    );
    if (job.modelLabel) {
      box.appendChild(el('p', { className: 'job-meta', text: 'Модель: ' + job.modelLabel + (job.clipDuration ? ' · клип ' + job.clipDuration + ' сек' : '') }));
    }
    if (job.status === 'queued' || job.status === 'processing') {
      var pct = Math.max(0, Math.min(100, Number(job.progress) || 0));
      var bar = el('div', {
        className: 'progress',
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(pct),
        'aria-label': 'Прогресс рендера',
      }, [el('div', { className: 'progress-bar' })]);
      bar.firstChild.style.width = pct + '%';
      box.appendChild(bar);
      box.appendChild(
        el('p', {
          className: 'job-meta',
          text: job.simulated
            ? 'Имитация процесса: ' + pct + '%. Настоящего видео не будет.'
            : 'Провайдер генерирует видео. Это может занять несколько минут; не закрывайте вкладку.',
        }),
      );
    }
    if (job.status === 'succeeded') {
      var result = job.result || {};
      var realUrl = !job.simulated && job.realVideoGeneration && result.simulated === false && isHttpsUrl(result.videoUrl);
      if (realUrl) {
        var video = el('video', { controls: true, playsinline: true, preload: 'metadata' });
        video.src = result.videoUrl;
        box.appendChild(
          el('div', { className: 'job-result real' }, [
            video,
            el('a', { className: 'btn btn-secondary', href: result.videoUrl, target: '_blank', rel: 'noopener noreferrer', download: '', text: 'Скачать видео' }),
            el('p', { className: 'job-meta', text: 'Ссылка провайдера может быть временной — скачайте файл сразу.' }),
          ]),
        );
      } else {
        box.appendChild(
          el('div', { className: 'job-result simulated' }, [
            el('strong', { text: 'Это была демонстрация: видео не создавалось.' }),
            el('p', { text: 'Раскадровка и промпт готовы — их можно использовать вручную. Настоящая генерация доступна только в закрытой бете.' }),
          ]),
        );
      }
    }
    if (job.status === 'failed') {
      var err = job.error || {};
      box.appendChild(
        el('div', { className: 'job-result failed' }, [
          el('strong', { text: 'Рендер не удался.' }),
          el('p', { text: (err.message || 'Неизвестная ошибка') + (err.code ? ' (' + err.code + ')' : '') }),
          !job.simulated
            ? el('p', { text: 'Провайдер мог списать оплату за начатую генерацию. Проверьте панель Replicate.' })
            : null,
        ]),
      );
    }
  }

  function startPolling(id) {
    stopPolling();
    state.pollJobId = id;
    var started = Date.now();
    var failures = 0;
    var tick = function () {
      if (state.pollJobId !== id) return;
      api('/api/jobs/' + encodeURIComponent(id), { timeoutMs: 15000 })
        .then(function (res) {
          if (state.pollJobId !== id) return;
          if (res.status === 429) {
            schedule(Math.max(POLL_INTERVAL_MS, res.retryAfter * 1000));
            return;
          }
          if (!res.ok) {
            renderJobMessage(errorText(res.data, res.status));
            updateHistory(id, { status: 'unknown' });
            return;
          }
          failures = 0;
          var job = res.data.job;
          renderJob(job);
          updateHistory(id, { status: job.status });
          if (job.status === 'succeeded' || job.status === 'failed') return;
          if (Date.now() - started > POLL_MAX_MS) {
            renderJobMessage('Статус не обновлялся слишком долго. Откройте задание из истории позже.');
            return;
          }
          schedule(POLL_INTERVAL_MS);
        })
        .catch(function (error) {
          failures += 1;
          if (failures >= 5) {
            renderJobMessage(error.message);
            return;
          }
          schedule(POLL_INTERVAL_MS * failures);
        });
    };
    var schedule = function (ms) {
      state.pollTimer = setTimeout(tick, ms);
    };
    schedule(1200);
  }

  function stopPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    state.pollJobId = null;
  }

  function renderJobMessage(message) {
    var box = $('job-current');
    show(box, true);
    box.appendChild(el('p', { className: 'form-error', role: 'alert', text: message }));
  }

  /* ---------------- History (this browser only) ---------------- */

  function readHistory() {
    try {
      var list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(list) ? list.filter(function (h) { return h && typeof h.id === 'string'; }).slice(0, 20) : [];
    } catch (e) {
      return [];
    }
  }

  function writeHistory(list) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 20)));
    } catch (e) {
      /* storage may be unavailable (private mode) */
    }
    renderHistory();
  }

  function addHistory(job) {
    var list = readHistory().filter(function (h) { return h.id !== job.id; });
    list.unshift({
      id: job.id,
      title: (job.brief && job.brief.product) || job.prompt || 'Ролик',
      simulated: Boolean(job.simulated),
      status: job.status,
      createdAt: job.createdAt,
    });
    writeHistory(list);
  }

  function updateHistory(id, patch) {
    var list = readHistory();
    var changed = false;
    list.forEach(function (h) {
      if (h.id === id && h.status !== patch.status) {
        h.status = patch.status;
        changed = true;
      }
    });
    if (changed) writeHistory(list);
  }

  function renderHistory() {
    var list = readHistory();
    var ul = $('history');
    clear(ul);
    show($('history-empty'), list.length === 0);
    show($('clear-history'), list.length > 0);
    list.forEach(function (h) {
      var created = h.createdAt ? new Date(h.createdAt) : null;
      ul.appendChild(
        el('li', null, [
          el('span', { className: 'h-title', text: h.title }),
          el('span', { className: 'badge ' + (h.simulated ? 'badge-demo' : 'badge-real'), text: h.simulated ? 'Демо' : 'Настоящее' }),
          el('span', { className: 'badge badge-kind', text: STATUS_LABELS[h.status] || 'Неизвестно' }),
          created && !isNaN(created.getTime())
            ? el('time', { datetime: created.toISOString(), text: created.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) })
            : null,
          el('button', {
            type: 'button',
            className: 'btn btn-small',
            text: 'Открыть',
            'aria-label': 'Открыть рендер: ' + h.title,
            onclick: function () { openJob(h.id); },
          }),
        ]),
      );
    });
  }

  function openJob(id) {
    api('/api/jobs/' + encodeURIComponent(id))
      .then(function (res) {
        if (!res.ok) {
          var box = $('job-current');
          clear(box);
          renderJobMessage(errorText(res.data, res.status));
          if (res.status === 404) updateHistory(id, { status: 'unknown' });
          return;
        }
        renderJob(res.data.job);
        var status = res.data.job.status;
        updateHistory(id, { status: status });
        if (status === 'queued' || status === 'processing') startPolling(id);
      })
      .catch(function (error) { renderJobMessage(error.message); });
  }

  /* ---------------- Login ---------------- */

  function openLogin() {
    var dialog = $('login-dialog');
    showError($('login-error'), '');
    $('login-key').value = '';
    if (state.config && state.config.auth && !state.config.auth.configured) {
      showError($('login-error'), 'Вход в бету на этом сервере не настроен (нет BETA_ACCESS_KEY).');
    }
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    $('login-key').focus();
  }

  function closeLogin() {
    var dialog = $('login-dialog');
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    $('login-btn').focus();
  }

  function submitLogin(event) {
    event.preventDefault();
    var input = $('login-key');
    var key = input.value;
    if (!key) {
      showError($('login-error'), 'Введите ключ.');
      return;
    }
    var button = $('login-submit');
    setBusy(button, true);
    api('/api/session', { method: 'POST', body: { accessKey: key } })
      .then(function (res) {
        input.value = '';
        if (!res.ok) {
          showError($('login-error'), errorText(res.data, res.status));
          return;
        }
        state.session = { authenticated: true, csrfToken: res.data.csrfToken, spend: res.data.spend };
        closeLogin();
        return loadConfig();
      })
      .catch(function (error) { showError($('login-error'), error.message); })
      .finally(function () { setBusy(button, false); });
  }

  function logout() {
    api('/api/session', { method: 'DELETE', csrf: true })
      .catch(function () { return null; })
      .then(function () {
        state.session = { authenticated: false, csrfToken: null };
        return loadConfig();
      })
      .then(function () {
        if (state.selection && state.selection.model.paid) markStale();
      });
  }

  /* ---------------- Wiring ---------------- */

  function init() {
    $('brief-form').addEventListener('submit', requestPlan);
    $('brief-form').addEventListener('input', function (event) {
      if (event.target.id === 'f-aspect') state.aspectTouched = true;
      if (event.target.name === 'tier') renderModels();
      if (event.target.id !== 'f-image') markStale();
    });
    $('brief-form').addEventListener('change', function (event) {
      if (event.target.name === 'tier') {
        renderModels();
        markStale();
      }
      if (event.target.id === 'f-aspect') state.aspectTouched = true;
      if (event.target.id === 'f-platform' && !state.aspectTouched && state.config) {
        var platform = state.config.options.platforms.find(function (p) { return p.value === event.target.value; });
        if (platform) $('f-aspect').value = platform.aspect;
      }
    });
    $('example-btn').addEventListener('click', fillExample);
    $('f-image').addEventListener('change', onImageChange);
    $('image-remove').addEventListener('click', removeImage);
    $('copy-prompt').addEventListener('click', copyPrompt);
    $('demo-render-btn').addEventListener('click', startDemo);
    $('quote-btn').addEventListener('click', requestQuote);
    $('quote-confirm').addEventListener('change', function (event) {
      $('paid-render-btn').disabled = !event.target.checked || !state.quote;
    });
    $('paid-render-btn').addEventListener('click', startPaid);
    $('login-btn').addEventListener('click', openLogin);
    $('login-cancel').addEventListener('click', closeLogin);
    $('login-form').addEventListener('submit', submitLogin);
    $('logout-btn').addEventListener('click', logout);
    $('global-retry').addEventListener('click', loadConfig);
    $('clear-history').addEventListener('click', function () {
      writeHistory([]);
      show($('job-current'), false);
      stopPolling();
    });
    renderHistory();
    loadConfig();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

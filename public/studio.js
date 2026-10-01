/* Режиссёр Studio — client. No dependencies. User/library strings are rendered
   only with textContent / DOM APIs (never innerHTML). The JWT is kept in
   localStorage and sent only to this origin in the Authorization header. */
(function () {
  'use strict';

  var TOKEN_KEY = 'rezhisser.token.v1';
  var LANG_KEY = 'rezhisser.lang.v1';
  var PAGE_SIZE = 24;
  var POLL_MS = 4000;

  var CATEGORIES = ['fashion', 'beauty', 'cars', 'food', 'memes', 'halal', 'tech', 'humor', 'crafts', 'cotton', 'heritage', 'tourism', 'outdoor', 'live-commerce', 'luxury', 'ugc', 'reels'];
  var CURRENCY_SIGN = { RUB: '₽', KZT: '₸', USD: '$', CNY: '¥' };

  var I18N = {
    ru: {
      brand: 'Режиссёр Studio', lang: 'Язык',
      'nav.library': 'Библиотека', 'nav.remix': 'Создать', 'nav.history': 'Мои видео', 'nav.pricing': 'Тарифы',
      'nav.director': 'Режиссёр', 'nav.login': 'Войти', 'nav.dashboard': 'Кабинет', 'nav.logout': 'Выйти',
      'hero.eyebrow': 'СНГ · 中国 · Reels · Мемы · Реклама',
      'hero.title': 'Готовые видео-идеи: выбрал, вставил фото — получил ролик.',
      'hero.lede': 'Рабочие промты для Seedance: мемы с липсинком, хуки для TikTok, бренды, beauty, авто, 直播带货. Копируйте или запускайте генерацию прямо отсюда.',
      'hero.create': 'Создать видео', 'hero.pricing': 'Тарифы от $5',
      'f.query': 'Поиск', 'f.region': 'Регион', 'f.country': 'Страна', 'f.category': 'Категория', 'f.trend': 'Тренд', 'f.all': 'Все',
      'region.sng': 'СНГ', 'region.china': 'Китай 中国',
      'country.ru': 'Россия', 'country.kz': 'Казахстан', 'country.tj': 'Таджикистан', 'country.uz': 'Узбекистан', 'country.kg': 'Кыргызстан', 'country.sng': 'Всё СНГ', 'country.cn': '中国',
      'trend.hot': '🔥 Хит', 'trend.rising': '📈 Растёт', 'trend.evergreen': '🌲 Вечное',
      'type.all': 'Всё', 'type.meme': 'Мемы', 'type.hook': 'Хуки / Reels', 'type.ad': 'Реклама', 'type.ugc': 'UGC', 'type.live': '直播带货',
      'lib.more': 'Показать ещё', 'lib.count': 'Найдено шаблонов: ', 'lib.copy': 'Копировать', 'lib.use': 'Использовать', 'lib.fav': '★',
      'cat.fashion': 'Мода', 'cat.beauty': 'Бьюти', 'cat.cars': 'Авто', 'cat.food': 'Еда и напитки', 'cat.memes': 'Мемы', 'cat.halal': 'Халяль',
      'cat.tech': 'Техника', 'cat.humor': 'Юмор', 'cat.crafts': 'Ремёсла', 'cat.cotton': 'Хлопок', 'cat.heritage': 'Наследие', 'cat.tourism': 'Туризм',
      'cat.outdoor': 'Outdoor', 'cat.live-commerce': 'Live-commerce', 'cat.luxury': 'Люкс', 'cat.ugc': 'UGC', 'cat.reels': 'Reels',
      'remix.title': 'Создать видео', 'remix.product': 'Ваш продукт', 'remix.brand': 'Бренд', 'remix.prompt': 'Промт (можно редактировать)',
      'remix.aspect': 'Формат', 'remix.duration': 'Длительность', 'remix.photo': 'Ваше фото (первый кадр)', 'remix.copy': 'Скопировать промт',
      'remix.save': 'В избранное', 'remix.demo': 'Демо (бесплатно)', 'remix.generate': 'Сгенерировать', 'remix.from': 'Шаблон: ',
      'remix.shots': 'Кадры', 'remix.dialogue': 'Диалог', 'remix.audio': 'Звук: ', 'remix.needLogin': 'Войдите, чтобы генерировать видео.',
      'remix.quota': 'Осталось: ', 'remix.unlimited': 'Безлимит (Studio)', 'remix.credits': ' кредитов',
      'auth.login': 'Вход', 'auth.register': 'Регистрация', 'auth.password': 'Пароль', 'auth.newPassword': 'Пароль (мин. 8 символов)',
      'auth.toRegister': 'Создать аккаунт', 'auth.toLogin': 'Уже есть аккаунт? Войти', 'auth.forgot': 'Забыли пароль?', 'auth.sendLink': 'Отправить ссылку',
      'auth.reset': 'Новый пароль', 'auth.save': 'Сохранить', 'auth.sent': 'Если аккаунт существует, письмо уже отправлено.', 'auth.welcome': 'Добро пожаловать!',
      'dash.title': 'Кабинет', 'dash.tier': 'Тариф', 'dash.used': 'Видео в этом периоде', 'dash.credits': 'Кредиты', 'dash.total': 'Всего видео',
      'dash.upgrade': 'Повысить тариф / купить кредиты', 'dash.favorites': 'Избранное', 'dash.billing': 'История платежей', 'dash.until': 'до ',
      'dash.empty': 'Пока пусто.', 'dash.remove': 'Удалить', 'dash.paymentDone': 'Оплата получена — спасибо!', 'dash.paymentPending': 'Ждём подтверждение оплаты…',
      'bill.date': 'Дата', 'bill.product': 'Продукт', 'bill.amount': 'Сумма', 'bill.status': 'Статус',
      'pricing.title': 'Тарифы', 'pricing.currency': 'Валюта', 'pricing.free': 'Библиотека, копирование промтов, демо-режим без настоящего видео.',
      'pricing.note': 'Подписка — предоплата за 30 дней, без автосписаний. Оплата: ЮKassa (карты РФ/КЗ, СБП, кошельки) или Stripe (карты по всему миру).',
      'pricing.buy': 'Оплатить', 'pricing.month': ' / 30 дней', 'pricing.unavailable': 'Оплата пока не подключена',
      'history.title': 'Мои видео', 'history.retention': 'Видео хранятся 30 дней — скачайте нужные.', 'history.download': 'Скачать', 'history.empty': 'Видео ещё нет — выберите шаблон в библиотеке.',
      'status.queued': 'В очереди', 'status.processing': 'Генерация…', 'status.succeeded': 'Готово', 'status.failed': 'Ошибка', 'status.expired': 'Удалено (30 дней)',
      'status.pending': 'Ожидает', 'status.canceled': 'Отменён', 'status.refunded': 'Возврат',
      'job.demo': 'Демо: настоящее видео не создавалось.', 'copied': 'Промт скопирован', 'saved': 'Сохранено в избранное',
      'foot.legal': 'Шаблоны мемов используют оригинальную озвучку «в стиле комедии» или вашу лицензированную дорожку — без фрагментов чужих фильмов, логотипов и лиц знаменитостей.',
      'err.generic': 'Что-то пошло не так. Попробуйте ещё раз.', 'err.network': 'Нет связи с сервером.',
    },
    zh: {
      brand: '导演 Studio', lang: '语言',
      'nav.library': '素材库', 'nav.remix': '创作', 'nav.history': '我的视频', 'nav.pricing': '价格',
      'nav.director': '导演', 'nav.login': '登录', 'nav.dashboard': '个人中心', 'nav.logout': '退出',
      'hero.eyebrow': '独联体 · 中国 · 短视频 · 梗 · 广告',
      'hero.title': '现成视频创意：选模板、传照片、出成片。',
      'hero.lede': 'Seedance 可用提示词：口型同步搞笑梗、抖音爆款开头、品牌广告、美妆、数码、直播带货。一键复制或直接生成。',
      'hero.create': '开始创作', 'hero.pricing': '套餐 ¥36 起',
      'f.query': '搜索', 'f.region': '地区', 'f.country': '国家', 'f.category': '类别', 'f.trend': '趋势', 'f.all': '全部',
      'region.sng': '独联体', 'region.china': '中国',
      'country.ru': '俄罗斯', 'country.kz': '哈萨克斯坦', 'country.tj': '塔吉克斯坦', 'country.uz': '乌兹别克斯坦', 'country.kg': '吉尔吉斯斯坦', 'country.sng': '独联体通用', 'country.cn': '中国',
      'trend.hot': '🔥 爆款', 'trend.rising': '📈 上升', 'trend.evergreen': '🌲 常青',
      'type.all': '全部', 'type.meme': '搞笑梗', 'type.hook': '开头钩子', 'type.ad': '广告', 'type.ugc': 'UGC', 'type.live': '直播带货',
      'lib.more': '加载更多', 'lib.count': '模板数量：', 'lib.copy': '复制', 'lib.use': '使用', 'lib.fav': '★',
      'cat.fashion': '时尚', 'cat.beauty': '美妆护肤', 'cat.cars': '汽车', 'cat.food': '食品饮料', 'cat.memes': '搞笑梗', 'cat.halal': '清真',
      'cat.tech': '数码科技', 'cat.humor': '幽默', 'cat.crafts': '手工艺', 'cat.cotton': '棉制品', 'cat.heritage': '传统品牌', 'cat.tourism': '旅游',
      'cat.outdoor': '户外', 'cat.live-commerce': '直播带货', 'cat.luxury': '奢侈品', 'cat.ugc': 'UGC', 'cat.reels': '短视频',
      'remix.title': '创作视频', 'remix.product': '你的产品', 'remix.brand': '品牌', 'remix.prompt': '提示词（可编辑）',
      'remix.aspect': '画幅', 'remix.duration': '时长', 'remix.photo': '你的照片（首帧）', 'remix.copy': '复制提示词',
      'remix.save': '收藏', 'remix.demo': '演示（免费）', 'remix.generate': '生成视频', 'remix.from': '模板：',
      'remix.shots': '分镜', 'remix.dialogue': '台词', 'remix.audio': '声音：', 'remix.needLogin': '请先登录再生成视频。',
      'remix.quota': '剩余：', 'remix.unlimited': '无限量（Studio）', 'remix.credits': ' 点数',
      'auth.login': '登录', 'auth.register': '注册', 'auth.password': '密码', 'auth.newPassword': '密码（至少 8 位）',
      'auth.toRegister': '创建账号', 'auth.toLogin': '已有账号？登录', 'auth.forgot': '忘记密码？', 'auth.sendLink': '发送链接',
      'auth.reset': '设置新密码', 'auth.save': '保存', 'auth.sent': '如果账号存在，邮件已发送。', 'auth.welcome': '欢迎！',
      'dash.title': '个人中心', 'dash.tier': '套餐', 'dash.used': '本周期视频', 'dash.credits': '点数', 'dash.total': '视频总数',
      'dash.upgrade': '升级套餐 / 购买点数', 'dash.favorites': '收藏', 'dash.billing': '支付记录', 'dash.until': '有效期至 ',
      'dash.empty': '暂无内容。', 'dash.remove': '删除', 'dash.paymentDone': '支付成功，谢谢！', 'dash.paymentPending': '正在确认支付…',
      'bill.date': '日期', 'bill.product': '产品', 'bill.amount': '金额', 'bill.status': '状态',
      'pricing.title': '价格', 'pricing.currency': '货币', 'pricing.free': '素材库、复制提示词、演示模式（不生成真实视频）。',
      'pricing.note': '套餐为 30 天预付，不自动续费。支付方式：YooKassa 或 Stripe（全球银行卡）。',
      'pricing.buy': '支付', 'pricing.month': ' / 30 天', 'pricing.unavailable': '暂未开通支付',
      'history.title': '我的视频', 'history.retention': '视频保存 30 天，请及时下载。', 'history.download': '下载', 'history.empty': '还没有视频，去素材库选个模板吧。',
      'status.queued': '排队中', 'status.processing': '生成中…', 'status.succeeded': '完成', 'status.failed': '失败', 'status.expired': '已删除（30 天）',
      'status.pending': '待支付', 'status.canceled': '已取消', 'status.refunded': '已退款',
      'job.demo': '演示：未生成真实视频。', 'copied': '已复制提示词', 'saved': '已收藏',
      'foot.legal': '搞笑梗模板使用“喜剧片风格”原创配音或你自己的授权音轨，不使用电影片段、商标或名人形象。',
      'err.generic': '出错了，请重试。', 'err.network': '无法连接服务器。',
    },
  };

  var state = {
    lang: 'ru',
    token: null,
    profile: null,
    config: null,
    filters: { type: '' },
    offset: 0,
    item: null,
    image: null,
    pollTimer: null,
    plans: null,
    afterLogin: '#/library',
  };

  function $(id) { return document.getElementById(id); }

  function t(key) {
    var dict = I18N[state.lang] || I18N.ru;
    return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : (I18N.ru[key] || key);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'className') node.className = value;
      else node.setAttribute(key, String(value));
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  var toastTimer = null;
  function toast(message, isError) {
    var node = $('toast');
    node.textContent = message;
    node.className = isError ? 'toast is-error' : 'toast';
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, 4500);
  }

  function storageGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch (e) { /* private mode */ }
  }

  function api(method, path, body) {
    var headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    return fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (json) {
          if (res.status === 401 && state.token && path.indexOf('/api/auth/') !== 0) setToken(null);
          if (!res.ok) {
            var error = new Error(json.message || t('err.generic'));
            error.code = json.error;
            error.status = res.status;
            throw error;
          }
          return json;
        });
      }, function () {
        throw new Error(t('err.network'));
      });
  }

  function fail(error) { toast(error && error.message ? error.message : t('err.generic'), true); }

  function setToken(token) {
    state.token = token;
    storageSet(TOKEN_KEY, token);
    if (!token) state.profile = null;
    renderAuthNav();
  }

  function renderAuthNav() {
    var logged = Boolean(state.token);
    $('nav-login').hidden = logged;
    $('nav-dashboard').hidden = !logged;
    $('logout-btn').hidden = !logged;
  }

  function applyI18n() {
    document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'ru';
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (node) {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
    fillCategories();
  }

  function fillCategories() {
    var select = $('f-category');
    var current = select.value;
    while (select.options.length > 1) select.remove(1);
    CATEGORIES.forEach(function (cat) { select.appendChild(el('option', { value: cat, text: t('cat.' + cat) })); });
    select.value = current;
  }

  /* ---------- routing ---------- */

  var VIEWS = ['library', 'remix', 'login', 'register', 'forgot', 'reset', 'dashboard', 'pricing', 'history'];
  var PROTECTED = { dashboard: true, history: true };

  function parseHash() {
    var hash = window.location.hash.replace(/^#\/?/, '');
    var parts = hash.split('?');
    var name = VIEWS.indexOf(parts[0]) >= 0 ? parts[0] : 'library';
    var params = {};
    (parts[1] || '').split('&').forEach(function (pair) {
      if (!pair) return;
      var kv = pair.split('=');
      try { params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ''); } catch (e) { /* ignore */ }
    });
    return { name: name, params: params };
  }

  function route() {
    var current = parseHash();
    if (PROTECTED[current.name] && !state.token) {
      state.afterLogin = window.location.hash;
      window.location.hash = '#/login';
      return;
    }
    stopPolling();
    VIEWS.forEach(function (name) { $('view-' + name).hidden = name !== current.name; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'), function (link) {
      link.classList.toggle('is-active', link.getAttribute('data-nav') === current.name);
    });
    var loaders = {
      library: function () { if (!$('lib-grid').firstChild) search(true); },
      remix: function () { loadRemix(current.params.id); },
      dashboard: function () { loadDashboard(current.params.payment); },
      pricing: loadPricing,
      history: loadHistory,
      reset: function () { state.resetToken = current.params.token || ''; },
    };
    if (loaders[current.name]) loaders[current.name]();
    $('view').focus({ preventScroll: true });
  }

  /* ---------- library ---------- */

  function searchPayload() {
    return {
      query: $('f-query').value.trim() || undefined,
      region: $('f-region').value || undefined,
      country: $('f-country').value || undefined,
      category: $('f-category').value || undefined,
      trend: $('f-trend').value || undefined,
      type: state.filters.type || undefined,
      limit: PAGE_SIZE,
      offset: state.offset,
    };
  }

  function search(reset) {
    if (reset) state.offset = 0;
    api('POST', '/api/library/search', searchPayload()).then(function (data) {
      var grid = $('lib-grid');
      if (reset) clear(grid);
      data.items.forEach(function (item) { grid.appendChild(card(item)); });
      $('lib-count').textContent = t('lib.count') + data.total;
      state.offset = data.offset + data.items.length;
      $('lib-more').hidden = state.offset >= data.total;
    }).catch(fail);
  }

  function card(item) {
    var badges = el('div', { className: 'badges' }, [
      el('span', { className: item.trend === 'hot' ? 'badge hot' : 'badge', text: t('trend.' + item.trend) }),
      el('span', { className: 'badge', text: t('country.' + item.country) }),
      el('span', { className: 'badge', text: item.aspect + ' · ' + item.duration + 's' }),
    ]);
    var copyBtn = el('button', { type: 'button', className: 'btn btn-small btn-ghost', text: t('lib.copy') });
    var useBtn = el('button', { type: 'button', className: 'btn btn-small btn-primary', text: t('lib.use') });
    var favBtn = el('button', { type: 'button', className: 'btn btn-small btn-ghost', text: t('lib.fav'), 'aria-label': t('remix.save') });
    var node = el('article', { className: 'card', tabindex: '0', 'aria-label': item.title }, [
      el('div', { className: 'card-cover', 'data-cat': item.category, 'data-aspect': item.aspect }, [
        badges,
        el('div', { className: 'card-title', text: item.title }),
      ]),
      el('div', { className: 'card-body' }, [
        el('p', { text: item.description }),
        el('p', { className: 'prompt-preview', text: item.preview }),
        el('div', { className: 'card-actions' }, [copyBtn, useBtn, favBtn]),
      ]),
    ]);
    copyBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      api('GET', '/api/library/' + encodeURIComponent(item.id)).then(function (data) { copy(data.item.prompt); }).catch(fail);
    });
    favBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      saveFavorite(item.id);
    });
    function open() { window.location.hash = '#/remix?id=' + encodeURIComponent(item.id); }
    useBtn.addEventListener('click', function (event) { event.stopPropagation(); open(); });
    node.addEventListener('click', open);
    node.addEventListener('keydown', function (event) { if (event.key === 'Enter') open(); });
    tilt(node, 'tx', 'ty', 8);
    return node;
  }

  function tilt(node, xVar, yVar, max) {
    node.addEventListener('pointermove', function (event) {
      var rect = node.getBoundingClientRect();
      var x = (event.clientX - rect.left) / rect.width - 0.5;
      var y = (event.clientY - rect.top) / rect.height - 0.5;
      node.style.setProperty('--' + xVar, (-y * max).toFixed(2) + 'deg');
      node.style.setProperty('--' + yVar, (x * max).toFixed(2) + 'deg');
    });
    node.addEventListener('pointerleave', function () {
      node.style.setProperty('--' + xVar, '0deg');
      node.style.setProperty('--' + yVar, '0deg');
    });
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(t('copied')); }, function () { toast(text); });
    } else {
      toast(text);
    }
  }

  function saveFavorite(itemId) {
    if (!state.token) { requireLogin(); return; }
    api('POST', '/api/projects', { kind: 'favorite', libraryItemId: itemId }).then(function () { toast(t('saved')); }).catch(fail);
  }

  function requireLogin() {
    state.afterLogin = window.location.hash || '#/library';
    toast(t('remix.needLogin'));
    window.location.hash = '#/login';
  }

  /* ---------- remix / generate ---------- */

  function loadRemix(id) {
    state.item = null;
    $('r-job').hidden = true;
    clear($('r-template'));
    $('remix-source').textContent = '';
    renderQuota();
    if (!id) {
      $('r-prompt').value = '';
      return;
    }
    api('GET', '/api/library/' + encodeURIComponent(id)).then(function (data) {
      var item = data.item;
      state.item = item;
      $('remix-source').textContent = t('remix.from') + item.title + ' — ' + item.description;
      $('r-prompt').value = item.prompt;
      $('r-prompt').setAttribute('data-original', item.prompt);
      $('r-aspect').value = item.aspect;
      $('r-duration').value = String(item.duration);
      renderTemplate(item.template);
    }).catch(fail);
  }

  function renderTemplate(template) {
    var box = $('r-template');
    clear(box);
    if (!template) return;
    box.appendChild(el('h2', { text: t('remix.shots') }));
    var shots = el('ol');
    (template.shots || []).forEach(function (shot) {
      shots.appendChild(el('li', { text: shot.t + ' — ' + shot.visual + (shot.text ? ' «' + shot.text + '»' : '') }));
    });
    box.appendChild(shots);
    if (template.dialogue && template.dialogue.length) {
      box.appendChild(el('h2', { text: t('remix.dialogue') }));
      template.dialogue.forEach(function (line) {
        box.appendChild(el('p', { className: 'line', text: line.speaker + ': ' + line.line }));
      });
    }
    if (template.audio) box.appendChild(el('p', { text: t('remix.audio') + template.audio }));
  }

  function renderQuota() {
    var node = $('r-quota');
    var sub = state.profile && state.profile.subscription;
    if (!sub) { node.textContent = state.token ? '' : t('remix.needLogin'); return; }
    if (sub.unlimited) { node.textContent = t('remix.unlimited'); return; }
    var left = sub.periodVideosLimit ? Math.max(0, sub.periodVideosLimit - sub.periodVideosUsed) : 0;
    node.textContent = t('remix.quota') + left + ' + ' + sub.credits + t('remix.credits');
  }

  function maxImageBytes() {
    return state.config && state.config.limits ? state.config.limits.imageMaxBytes : 262144;
  }

  // Downscale the photo in the browser so it fits the server's upload limit.
  function readPhoto(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var maxBytes = maxImageBytes();
        var scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
        for (var attempt = 0; attempt < 8; attempt += 1) {
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          var dataUrl = canvas.toDataURL('image/jpeg', 0.85 - attempt * 0.07);
          if (Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75) <= maxBytes) { resolve(dataUrl); return; }
          scale *= 0.75;
        }
        reject(new Error(t('err.generic')));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error(t('err.generic'))); };
      img.src = url;
    });
  }

  function generate(demo) {
    if (!state.token) { requireLogin(); return; }
    var prompt = $('r-prompt').value.trim();
    var edited = !state.item || prompt !== $('r-prompt').getAttribute('data-original');
    var body = {
      aspect: $('r-aspect').value,
      duration: Number($('r-duration').value),
      fields: { product: $('r-product').value.trim(), brand: $('r-brand').value.trim() },
    };
    if (state.item) body.libraryItemId = state.item.id;
    if (edited) body.prompt = prompt;
    if (state.image) body.image = state.image;
    if (demo) body.demo = true;
    $('r-generate').disabled = true;
    $('r-demo').disabled = true;
    api('POST', '/api/jobs', body).then(function (data) {
      if (state.profile) state.profile.subscription = data.subscription;
      renderQuota();
      showJob(data.job);
      pollJob(data.job.id);
    }).catch(function (error) {
      fail(error);
      if (error.code === 'upgrade_required' || error.code === 'quota_exceeded') window.location.hash = '#/pricing';
    }).then(function () {
      $('r-generate').disabled = false;
      $('r-demo').disabled = false;
    });
  }

  function showJob(job) {
    $('r-job').hidden = false;
    var text = t('status.' + job.status);
    if (job.status === 'succeeded' && job.simulated) text += ' — ' + t('job.demo');
    if (job.status === 'failed' && job.error) text += ' — ' + job.error.message;
    $('r-job-status').textContent = text;
    var video = $('r-video');
    var download = $('r-download');
    if (job.video && job.video.url) {
      video.src = job.video.url;
      video.hidden = false;
      download.href = job.video.downloadUrl;
      download.hidden = false;
    } else {
      video.hidden = true;
      download.hidden = true;
    }
  }

  function stopPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function pollJob(id) {
    stopPolling();
    state.pollTimer = setTimeout(function () {
      api('GET', '/api/jobs/' + encodeURIComponent(id)).then(function (data) {
        showJob(data.job);
        if (data.job.status === 'queued' || data.job.status === 'processing') pollJob(id);
      }).catch(fail);
    }, POLL_MS);
  }

  /* ---------- auth ---------- */

  function onAuth(data) {
    setToken(data.token);
    state.profile = { user: data.user, subscription: data.subscription };
    toast(t('auth.welcome'));
    var target = state.afterLogin && state.afterLogin.indexOf('#/login') !== 0 ? state.afterLogin : '#/dashboard';
    state.afterLogin = '#/library';
    window.location.hash = target;
  }

  function bindAuthForms() {
    $('login-form').addEventListener('submit', function (event) {
      event.preventDefault();
      api('POST', '/api/auth/login', { email: $('login-email').value, password: $('login-password').value }).then(onAuth).catch(fail);
    });
    $('register-form').addEventListener('submit', function (event) {
      event.preventDefault();
      api('POST', '/api/auth/register', { email: $('register-email').value, password: $('register-password').value, locale: state.lang }).then(onAuth).catch(fail);
    });
    $('forgot-form').addEventListener('submit', function (event) {
      event.preventDefault();
      api('POST', '/api/auth/forgot-password', { email: $('forgot-email').value }).then(function () { toast(t('auth.sent')); }).catch(fail);
    });
    $('reset-form').addEventListener('submit', function (event) {
      event.preventDefault();
      api('POST', '/api/auth/reset-password', { token: state.resetToken || '', password: $('reset-password').value }).then(onAuth).catch(fail);
    });
    $('logout-btn').addEventListener('click', function () {
      setToken(null);
      window.location.hash = '#/library';
    });
  }

  /* ---------- dashboard ---------- */

  function formatDate(value) {
    if (!value) return '';
    try { return new Date(value).toLocaleDateString(state.lang === 'zh' ? 'zh-CN' : 'ru-RU'); } catch (e) { return value; }
  }

  function loadProfile() {
    if (!state.token) return Promise.resolve(null);
    return api('GET', '/api/user/profile').then(function (data) {
      state.profile = data;
      renderQuota();
      return data;
    });
  }

  function loadDashboard(paymentId) {
    if (paymentId) toast(t('dash.paymentPending'));
    Promise.all([loadProfile(), api('GET', '/api/payment/history'), api('GET', '/api/projects')]).then(function (results) {
      var profile = results[0];
      var history = results[1];
      var sub = profile.subscription;
      $('d-tier').textContent = sub.tierLabel;
      $('d-expires').textContent = sub.subscriptionExpiresAt ? t('dash.until') + formatDate(sub.subscriptionExpiresAt) : '';
      $('d-used').textContent = sub.unlimited ? sub.periodVideosUsed + ' / ∞' : sub.periodVideosUsed + ' / ' + (sub.periodVideosLimit || 0);
      var ratio = sub.unlimited ? 0 : sub.periodVideosLimit ? Math.min(1, sub.periodVideosUsed / sub.periodVideosLimit) : 0;
      $('d-meter').style.width = Math.round(ratio * 100) + '%';
      $('d-credits').textContent = String(sub.credits);
      $('d-total').textContent = String(profile.usage.totalVideos);
      $('d-email').textContent = profile.user.email;
      renderPayments(history.payments, paymentId);
      renderProjects(results[2].projects);
    }).catch(fail);
  }

  function renderPayments(payments, paymentId) {
    var body = $('d-payments');
    clear(body);
    if (!payments.length) {
      body.appendChild(el('tr', {}, [el('td', { colspan: '4', className: 'muted', text: t('dash.empty') })]));
      return;
    }
    payments.forEach(function (payment) {
      if (payment.id === paymentId && payment.status === 'succeeded') toast(t('dash.paymentDone'));
      body.appendChild(el('tr', {}, [
        el('td', { text: formatDate(payment.createdAt) }),
        el('td', { text: payment.product }),
        el('td', { text: payment.amount + ' ' + payment.currency }),
        el('td', { className: 'status-' + payment.status, text: t('status.' + payment.status) }),
      ]));
    });
  }

  function renderProjects(projects) {
    var list = $('d-projects');
    clear(list);
    if (!projects.length) { list.appendChild(el('li', { className: 'muted', text: t('dash.empty') })); return; }
    projects.forEach(function (project) {
      var open = el('a', { href: project.libraryItemId ? '#/remix?id=' + encodeURIComponent(project.libraryItemId) : '#/remix', text: project.title });
      var remove = el('button', { type: 'button', className: 'btn btn-small btn-ghost', text: t('dash.remove') });
      remove.addEventListener('click', function () {
        api('DELETE', '/api/projects/' + encodeURIComponent(project.id)).then(function () { loadDashboard(); }).catch(fail);
      });
      list.appendChild(el('li', {}, [open, remove]));
    });
  }

  /* ---------- pricing ---------- */

  function loadPricing() {
    var ready = state.plans ? Promise.resolve(state.plans) : api('GET', '/api/plans').then(function (data) { state.plans = data; return data; });
    ready.then(renderPlans).catch(fail);
  }

  function renderPlans(data) {
    var box = $('p-plans');
    var currency = $('p-currency').value;
    while (box.children.length > 1) box.removeChild(box.lastChild);
    var supported = data.paymentProviders.some(function (p) { return p.currencies.indexOf(currency) >= 0; });
    data.products.forEach(function (product) {
      var minor = product.prices[currency];
      if (!minor) return;
      var title = product.title[state.lang] || product.title.en;
      var buy = el('button', { type: 'button', className: product.tier === 'pro' ? 'btn btn-primary' : 'btn', text: supported ? t('pricing.buy') : t('pricing.unavailable') });
      buy.disabled = !supported;
      buy.addEventListener('click', function () { checkout(product.id, currency, buy); });
      box.appendChild(el('article', { className: product.tier === 'pro' ? 'plan featured' : 'plan' }, [
        el('h2', { text: product.kind === 'subscription' ? product.id.toUpperCase() : title.split(' ')[0] + ' ' + (product.credits || '') }),
        el('p', { className: 'price', text: CURRENCY_SIGN[currency] + (minor / 100).toLocaleString() + (product.kind === 'subscription' ? t('pricing.month') : '') }),
        el('p', { className: 'muted', text: title }),
        buy,
      ]));
    });
  }

  function checkout(productId, currency, button) {
    if (!state.token) { requireLogin(); return; }
    button.disabled = true;
    api('POST', '/api/payment/checkout', { product: productId, currency: currency }).then(function (data) {
      if (typeof data.confirmationUrl === 'string' && data.confirmationUrl.indexOf('https:') === 0) {
        window.location.assign(data.confirmationUrl);
      } else {
        fail();
      }
    }).catch(fail).then(function () { button.disabled = false; });
  }

  /* ---------- history ---------- */

  function loadHistory() {
    api('GET', '/api/jobs').then(function (data) {
      var grid = $('h-grid');
      clear(grid);
      if (!data.jobs.length) { grid.appendChild(el('p', { className: 'muted', text: t('history.empty') })); return; }
      data.jobs.forEach(function (job) {
        var children = [
          el('div', { className: 'card-cover', 'data-aspect': job.aspect }, [
            el('div', { className: 'badges' }, [
              el('span', { className: 'badge', text: t('status.' + job.status) }),
              el('span', { className: 'badge', text: (job.aspect || '') + ' · ' + (job.durationSeconds || '') + 's' }),
              job.simulated ? el('span', { className: 'badge', text: 'demo' }) : null,
            ]),
          ]),
        ];
        var body = el('div', { className: 'card-body' }, [el('p', { className: 'prompt-preview', text: job.prompt.slice(0, 220) }), el('p', { text: formatDate(job.createdAt) })]);
        if (job.video && job.video.url) {
          var video = el('video', { controls: 'controls', playsinline: 'playsinline', preload: 'metadata' });
          video.src = job.video.url;
          body.appendChild(video);
          body.appendChild(el('a', { className: 'btn btn-small', href: job.video.downloadUrl, download: '', text: t('history.download') }));
        }
        children.push(body);
        grid.appendChild(el('article', { className: 'card' }, children));
      });
    }).catch(fail);
  }

  /* ---------- init ---------- */

  function bindLibrary() {
    var debounce = null;
    $('filters').addEventListener('submit', function (event) { event.preventDefault(); search(true); });
    $('f-query').addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () { search(true); }, 250);
    });
    ['f-region', 'f-country', 'f-category', 'f-trend'].forEach(function (id) {
      $(id).addEventListener('change', function () { search(true); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#type-chips .chip'), function (chip) {
      chip.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('#type-chips .chip'), function (c) { c.classList.remove('is-active'); });
        chip.classList.add('is-active');
        state.filters.type = chip.getAttribute('data-type');
        search(true);
      });
    });
    $('lib-more').addEventListener('click', function () { search(false); });

    var stage = $('stage');
    stage.addEventListener('pointermove', function (event) {
      var rect = stage.getBoundingClientRect();
      var x = (event.clientX - rect.left) / rect.width - 0.5;
      var y = (event.clientY - rect.top) / rect.height - 0.5;
      stage.style.setProperty('--ry', (30 + x * 120).toFixed(1) + 'deg');
      stage.style.setProperty('--rx', (-18 - y * 60).toFixed(1) + 'deg');
    });
  }

  function bindRemix() {
    $('remix-form').addEventListener('submit', function (event) { event.preventDefault(); generate(false); });
    $('r-demo').addEventListener('click', function () { generate(true); });
    $('r-copy').addEventListener('click', function () { copy($('r-prompt').value); });
    $('r-save').addEventListener('click', function () {
      if (!state.token) { requireLogin(); return; }
      var body = state.item
        ? { kind: 'favorite', libraryItemId: state.item.id, prompt: $('r-prompt').value }
        : { kind: 'project', title: $('r-product').value.trim() || 'Project', prompt: $('r-prompt').value };
      api('POST', '/api/projects', body).then(function () { toast(t('saved')); }).catch(fail);
    });
    $('r-photo').addEventListener('change', function () {
      var file = $('r-photo').files && $('r-photo').files[0];
      state.image = null;
      $('r-preview').hidden = true;
      if (!file) return;
      readPhoto(file).then(function (dataUrl) {
        state.image = dataUrl;
        $('r-preview').src = dataUrl;
        $('r-preview').hidden = false;
      }).catch(fail);
    });
  }

  function init() {
    var saved = storageGet(LANG_KEY);
    var browserZh = (navigator.language || '').toLowerCase().indexOf('zh') === 0;
    state.lang = saved === 'zh' || saved === 'ru' ? saved : browserZh ? 'zh' : 'ru';
    $('lang-select').value = state.lang;
    if (state.lang === 'zh') $('f-region').value = 'china';
    $('lang-select').addEventListener('change', function () {
      state.lang = $('lang-select').value;
      storageSet(LANG_KEY, state.lang);
      applyI18n();
      if (state.plans) renderPlans(state.plans);
    });
    $('p-currency').value = state.lang === 'zh' ? 'CNY' : 'RUB';
    $('p-currency').addEventListener('change', loadPricing);

    state.token = storageGet(TOKEN_KEY);
    renderAuthNav();
    applyI18n();
    bindLibrary();
    bindRemix();
    bindAuthForms();
    api('GET', '/api/config').then(function (config) { state.config = config; }).catch(function () { /* optional */ });
    loadProfile().catch(function () { /* token may have expired */ });
    window.addEventListener('hashchange', route);
    route();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

'use strict';

// Rule-based "director": turns a plain-language ad brief into a creative brief,
// hook/CTA, visual direction, a shot list and a prompt for a video model.
//
// It is deterministic and uses only templates and lookup tables. It makes no
// network calls, costs nothing and is NOT an AI/LLM. The same brief always
// produces the same plan.

const crypto = require('node:crypto');
const { createRecipeDirector, RecipeError } = require('./recipes/index.js');

const ENGINE = 'rule-based-v1';
const ENGINE_LABEL = 'Правила и шаблоны (без ИИ, бесплатно)';

const GOALS = {
  awareness: { label: 'Узнаваемость бренда', en: 'brand awareness' },
  conversion: { label: 'Продажи', en: 'direct response, drive purchase' },
  launch: { label: 'Запуск новинки', en: 'product launch reveal' },
  engagement: { label: 'Вовлечение', en: 'engaging, shareable social content' },
  traffic: { label: 'Переходы на сайт', en: 'drive clicks to website' },
};

const PLATFORMS = {
  reels: { label: 'Instagram Reels', aspect: '9:16' },
  tiktok: { label: 'TikTok', aspect: '9:16' },
  'youtube-shorts': { label: 'YouTube Shorts', aspect: '9:16' },
  'vk-clips': { label: 'VK Клипы', aspect: '9:16' },
  youtube: { label: 'YouTube', aspect: '16:9' },
  telegram: { label: 'Telegram', aspect: '1:1' },
  website: { label: 'Сайт / лендинг', aspect: '16:9' },
};

const ASPECTS = ['9:16', '16:9', '1:1', '4:5'];
const DURATIONS = [5, 10, 15, 30];

const MOODS = {
  premium: {
    label: 'Премиум',
    en: 'premium, elegant, refined luxury',
    palette: 'Глубокие тёмные тона, золото/латунь, мягкие блики',
    lighting: 'Контровой и боковой мягкий свет, контролируемые тени',
    camera: 'Медленный dolly-in, макро-детали, плавные проводки',
    pacing: 'Неспешный ритм, длинные планы',
    typography: 'Тонкий антиквенный шрифт, много воздуха',
    lightingEn: 'soft rim light, controlled shadows',
    cameraEn: 'slow dolly-in, macro details',
    tags: ['cinematic', 'product'],
  },
  energetic: {
    label: 'Энергично',
    en: 'energetic, bold, high-contrast',
    palette: 'Насыщенные контрастные цвета, акцентный неон',
    lighting: 'Жёсткий направленный свет, цветные гели',
    camera: 'Быстрые проводки, whip-pan, ручная камера',
    pacing: 'Быстрый монтаж в ритм музыки',
    typography: 'Крупный жирный гротеск, кинетический текст',
    lightingEn: 'hard directional light, colored gels',
    cameraEn: 'fast tracking shots, whip pans, handheld',
    tags: ['dynamic'],
  },
  warm: {
    label: 'Тёплое, человечное',
    en: 'warm, authentic, human',
    palette: 'Тёплые естественные тона, дерево, текстиль',
    lighting: 'Естественный «золотой час», мягкий рассеянный',
    camera: 'Ручная камера со стабилизацией, средние планы',
    pacing: 'Спокойный, живой ритм',
    typography: 'Дружелюбный скруглённый шрифт',
    lightingEn: 'natural golden hour light, soft diffused',
    cameraEn: 'gentle handheld, medium shots',
    tags: ['people'],
  },
  minimal: {
    label: 'Минимализм',
    en: 'minimal, clean, airy',
    palette: 'Светлый нейтральный фон, 1 акцентный цвет',
    lighting: 'Ровный студийный софтбокс',
    camera: 'Статичные композиции, медленное вращение предмета',
    pacing: 'Размеренный, чистые склейки',
    typography: 'Строгий гротеск, крупные поля',
    lightingEn: 'even studio softbox lighting',
    cameraEn: 'static composition, slow turntable rotation',
    tags: ['product'],
  },
  playful: {
    label: 'Игриво',
    en: 'playful, colorful, fun',
    palette: 'Яркие пастельные и сочные цвета',
    lighting: 'Яркий высокий ключ',
    camera: 'Стоп-моушн акценты, резкие зумы, неожиданные ракурсы',
    pacing: 'Весёлый, скачкообразный',
    typography: 'Округлый шрифт, стикеры и эмодзи-акценты',
    lightingEn: 'bright high-key light',
    cameraEn: 'snap zooms, playful unexpected angles',
    tags: ['dynamic'],
  },
  tech: {
    label: 'Технологично',
    en: 'futuristic, sleek, high-tech',
    palette: 'Холодный синий/циан, графит, стекло',
    lighting: 'Световые линии, подсветка по контуру',
    camera: 'Точные моушн-контрол пролёты, орбита вокруг предмета',
    pacing: 'Чёткий ритм с акцентами',
    typography: 'Моноширинный или геометрический шрифт',
    lightingEn: 'light streaks, edge lighting',
    cameraEn: 'precise motion-control orbit',
    tags: ['cinematic', 'product'],
  },
  cinematic: {
    label: 'Кинематографично',
    en: 'cinematic, dramatic, filmic',
    palette: 'Кинолук teal & orange, плёночное зерно',
    lighting: 'Драматичный низкий ключ, атмосферная дымка',
    camera: 'Широкие планы, крановые движения, anamorphic-блики',
    pacing: 'Нарастающий, с кульминацией',
    typography: 'Широкий титровый шрифт',
    lightingEn: 'dramatic low-key light, atmospheric haze',
    cameraEn: 'wide establishing shots, crane moves, anamorphic flares',
    tags: ['cinematic', 'people'],
  },
};

const VOICES = {
  none: { label: 'Без закадрового голоса', audio: 'Музыка и звуковые эффекты' },
  friendly: { label: 'Дружелюбный', audio: 'Тёплый голос, разговорная интонация' },
  confident: { label: 'Уверенный', audio: 'Собранный уверенный голос, короткие фразы' },
  ironic: { label: 'С иронией', audio: 'Лёгкая самоирония, паузы для шутки' },
  expert: { label: 'Экспертный', audio: 'Спокойный экспертный тон, конкретика' },
};

const HOOKS = {
  awareness: ['Знакомьтесь: {product}.', 'Это {product} — и это надолго.', '{product}. Запомните этот кадр.'],
  conversion: ['Хватит откладывать — {product} уже здесь.', '{product}: то, что вы искали.', 'Одна причина выбрать {product} — прямо сейчас.'],
  launch: ['Впервые: {product}.', 'Мы долго молчали. Встречайте {product}.', 'Новое имя в вашей жизни — {product}.'],
  engagement: ['Угадайте, что будет дальше с {product}?', 'Спорим, вы так ещё не видели {product}?', 'Поставьте на паузу — это {product}.'],
  traffic: ['Всё о {product} — по ссылке.', '{product}: подробности за один клик.', 'Хотите больше о {product}? Смотрите дальше.'],
};

const CTAS = {
  awareness: 'Узнайте больше',
  conversion: 'Закажите сегодня',
  launch: 'Будьте первыми',
  engagement: 'Поделитесь с другом',
  traffic: 'Перейдите по ссылке',
};

const BEATS = [
  { key: 'hook', title: 'Крючок', purpose: 'Остановить скролл в первые секунды' },
  { key: 'desire', title: 'Желание', purpose: 'Показать ситуацию и эмоцию аудитории' },
  { key: 'hero', title: 'Продукт-герой', purpose: 'Главный план продукта' },
  { key: 'benefit', title: 'Выгода', purpose: 'Конкретная польза / УТП' },
  { key: 'proof', title: 'Доказательство', purpose: 'Детали, фактура, социальное доказательство' },
  { key: 'cta', title: 'Призыв', purpose: 'Финальный кадр с логотипом и CTA' },
];

const BEATS_BY_DURATION = {
  5: ['hook', 'cta'],
  10: ['hook', 'hero', 'cta'],
  15: ['hook', 'desire', 'hero', 'cta'],
  30: ['hook', 'desire', 'hero', 'benefit', 'proof', 'cta'],
};

const LIMITS = { product: 120, audience: 200, offer: 200, cta: 60, notes: 300 };

class BriefError extends Error {
  constructor(code, field, message) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

// Removes control characters and collapses whitespace so user text can be
// embedded safely into prompts and JSON (the UI renders it with textContent).
function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickEnum(value, table, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(table, value)) return value;
  throw new BriefError('invalid_brief', field, `Недопустимое значение поля «${field}».`);
}

function validateBrief(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BriefError('invalid_brief', 'brief', 'Бриф должен быть объектом.');
  }
  const brief = {};
  for (const [field, max] of Object.entries(LIMITS)) {
    const raw = input[field];
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      throw new BriefError('invalid_brief', field, `Поле «${field}» должно быть строкой.`);
    }
    const text = cleanText(raw);
    if (text.length > max) {
      throw new BriefError('field_too_long', field, `Поле «${field}» длиннее ${max} символов.`);
    }
    brief[field] = text;
  }
  if (!brief.product) {
    throw new BriefError('product_required', 'product', 'Укажите, что рекламируем.');
  }
  brief.goal = pickEnum(input.goal, GOALS, 'goal', 'awareness');
  brief.platform = pickEnum(input.platform, PLATFORMS, 'platform', 'reels');
  brief.mood = pickEnum(input.mood, MOODS, 'mood', 'premium');
  brief.voice = pickEnum(input.voice, VOICES, 'voice', 'none');
  const aspect = input.aspect === undefined || input.aspect === null || input.aspect === '' ? PLATFORMS[brief.platform].aspect : input.aspect;
  if (!ASPECTS.includes(aspect)) {
    throw new BriefError('invalid_brief', 'aspect', 'Недопустимый формат кадра.');
  }
  brief.aspect = aspect;
  const duration = input.duration === undefined || input.duration === null || input.duration === '' ? 10 : Number(input.duration);
  if (!DURATIONS.includes(duration)) {
    throw new BriefError('invalid_brief', 'duration', `Длительность должна быть одной из: ${DURATIONS.join(', ')} сек.`);
  }
  brief.duration = duration;
  return brief;
}

function briefHash(brief) {
  return crypto.createHash('sha256').update(JSON.stringify(brief)).digest('hex');
}

function variant(list, seed) {
  const n = crypto.createHash('sha256').update(seed).digest().readUInt32BE(0);
  return list[n % list.length];
}

function shotVisual(beat, brief, mood) {
  const p = brief.product;
  const audience = brief.audience || 'ваша аудитория';
  switch (beat) {
    case 'hook':
      return `Неожиданный первый кадр: ${p} крупным планом в движении, ${mood.camera.toLowerCase()}.`;
    case 'desire':
      return `Момент из жизни: ${audience} — эмоция, которую решает продукт.`;
    case 'hero':
      return `${p} в центре кадра, чистый фон, свет подчёркивает форму и фактуру.`;
    case 'benefit':
      return brief.offer ? `Визуализация выгоды: ${brief.offer}.` : `Продукт в использовании — видно, чем он лучше.`;
    case 'proof':
      return 'Макро-детали, фактура материала, короткие реакции людей.';
    case 'cta':
    default:
      return `Финальная композиция: ${p}, место под логотип и призыв.`;
  }
}

function shotText(beat, hook, cta, brief) {
  if (beat === 'hook') return hook;
  if (beat === 'benefit' && brief.offer) return brief.offer;
  if (beat === 'cta') return cta;
  return '';
}

function splitTimeline(duration, count) {
  // Hook gets a short opener, CTA a short closer, the rest is split evenly.
  if (count === 2) return [[0, Math.min(3, duration - 2)], [Math.min(3, duration - 2), duration]];
  const hookEnd = 3;
  const ctaStart = duration - (duration <= 10 ? 3 : 4);
  const middle = count - 2;
  const step = (ctaStart - hookEnd) / middle;
  const ranges = [[0, hookEnd]];
  for (let i = 0; i < middle; i += 1) {
    ranges.push([Math.round((hookEnd + i * step) * 10) / 10, Math.round((hookEnd + (i + 1) * step) * 10) / 10]);
  }
  ranges.push([ctaStart, duration]);
  return ranges;
}

function buildPrompt(brief, mood) {
  const goal = GOALS[brief.goal];
  const parts = [
    `Advertising video for "${brief.product}"`,
    brief.audience ? `aimed at ${brief.audience}` : null,
    `${goal.en}`,
    `${mood.en} mood`,
    `${mood.lightingEn}`,
    `${mood.cameraEn}`,
    'product clearly visible and in focus',
    'professional commercial cinematography, high detail',
    `aspect ratio ${brief.aspect}`,
    'no on-screen text, no watermark',
  ].filter(Boolean);
  const prompt = parts.join(', ');
  return prompt.length > 900 ? prompt.slice(0, 900) : prompt;
}

function planTags(brief, mood, hasImage) {
  const tags = new Set(mood.tags);
  if (brief.goal === 'conversion' || brief.goal === 'launch') tags.add('product');
  if (brief.goal === 'engagement') tags.add('dynamic');
  if (brief.aspect === '9:16') tags.add('vertical');
  if (hasImage) tags.add('image-anchor');
  return Array.from(tags).sort();
}

function createPlan(inputBrief, { hasImage = false } = {}) {
  const brief = validateBrief(inputBrief);
  const mood = MOODS[brief.mood];
  const voice = VOICES[brief.voice];
  const goal = GOALS[brief.goal];
  const platform = PLATFORMS[brief.platform];
  const hash = briefHash(brief);

  const hook = variant(HOOKS[brief.goal], hash).replace('{product}', brief.product);
  const cta = brief.cta || CTAS[brief.goal];
  const beats = BEATS_BY_DURATION[brief.duration];
  const ranges = splitTimeline(brief.duration, beats.length);

  const shots = beats.map((key, index) => {
    const beat = BEATS.find((item) => item.key === key);
    return {
      n: index + 1,
      beat: key,
      title: beat.title,
      purpose: beat.purpose,
      start: ranges[index][0],
      end: ranges[index][1],
      visual: shotVisual(key, brief, mood),
      camera: mood.camera,
      onScreenText: shotText(key, hook, cta, brief),
      audio: voice.audio,
    };
  });

  return {
    engine: ENGINE,
    engineLabel: ENGINE_LABEL,
    disclaimer:
      'План собран детерминированными правилами и шаблонами. Это не нейросеть: результат предсказуем и бесплатен, но не заменяет работу креативного директора.',
    brief,
    briefHash: hash,
    hook,
    cta,
    creativeBrief: {
      objective: goal.label,
      platform: platform.label,
      format: `${brief.aspect}, ${brief.duration} сек`,
      audience: brief.audience || 'Не указана — план общий',
      keyMessage: brief.offer || `${brief.product} — лучший выбор для вашей задачи`,
      tone: `${mood.label}; голос: ${voice.label.toLowerCase()}`,
      mandatory: brief.notes || 'Логотип и CTA в финальном кадре',
    },
    visualDirection: {
      mood: mood.label,
      palette: mood.palette,
      lighting: mood.lighting,
      camera: mood.camera,
      pacing: mood.pacing,
      typography: mood.typography,
    },
    shots,
    modelPrompt: buildPrompt(brief, mood),
    negativePrompt: 'blurry, low quality, distorted text, watermark, deformed hands, extra fingers, warped logo',
    tags: planTags(brief, mood, hasImage),
    notes: [
      'Текст на экране и логотип лучше накладывать при монтаже: видеомодели часто искажают буквы.',
      brief.duration > 10
        ? 'Большинство видеомоделей генерирует 5–10 секунд за раз: длинный ролик собирается из нескольких генераций.'
        : 'Длительность укладывается в одну генерацию большинства видеомоделей.',
    ],
  };
}

// Optional LLM advisor slot. No advisor is implemented in this version: the
// only accepted value is "none" so a typo can never silently enable a paid
// LLM call.
const SUPPORTED_ADVISORS = ['none'];

function validateAdvisorSetting(value) {
  const setting = (value || 'none').trim().toLowerCase();
  if (!SUPPORTED_ADVISORS.includes(setting)) {
    throw new Error(
      `Unsupported DIRECTOR_ADVISOR "${setting}". No LLM advisor is implemented in this version; use "none".`,
    );
  }
  return setting;
}

function briefOptions() {
  const map = (table) => Object.entries(table).map(([value, item]) => ({ value, label: item.label }));
  return {
    goals: map(GOALS),
    platforms: Object.entries(PLATFORMS).map(([value, item]) => ({ value, label: item.label, aspect: item.aspect })),
    moods: map(MOODS),
    voices: map(VOICES),
    aspects: ASPECTS,
    durations: DURATIONS,
    limits: LIMITS,
  };
}

// Recipe director: one call picks a library recipe and walks it. Dry-run is
// the default, including this shared instance (no provider, no budget).
const recipeDirector = createRecipeDirector();

function directRequest(input = {}) {
  return recipeDirector.handle(input);
}

module.exports = {
  ENGINE,
  ASPECTS,
  DURATIONS,
  BriefError,
  RecipeError,
  cleanText,
  validateBrief,
  briefHash,
  createPlan,
  briefOptions,
  validateAdvisorSetting,
  createRecipeDirector,
  directRequest,
};

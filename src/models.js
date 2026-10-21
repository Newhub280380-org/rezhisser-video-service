'use strict';

// Server-side model catalog and router.
//
// Users only ever send a profile id (or "auto"). Every provider model name,
// input field mapping, fixed input and price estimate comes from this file or
// from operator configuration (VIDEO_MODEL_PROFILES_JSON / REPLICATE_MODEL).

const crypto = require('node:crypto');
const { ASPECTS, DURATIONS } = require('./director.js');

const KINDS = {
  'text-to-video': 'Текст → видео',
  'image-to-video': 'Фото продукта → видео',
};

const TAG_LABELS = {
  cinematic: 'кинематографичность',
  product: 'продуктовая съёмка',
  dynamic: 'динамика',
  people: 'люди и эмоции',
  vertical: 'вертикальный формат',
  'image-anchor': 'опора на фото продукта',
};

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;
const INPUT_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const REPLICATE_MODEL_PATTERN = /^([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)(?::([a-z0-9]+))?$/i;
const MAX_ESTIMATE_USD = 100;

// Routing presets for the shot list. They are not a video provider: the job
// API refuses to execute them and names the env vars a real provider needs.
const DEMO_PROFILES = [
  {
    id: 'demo-cinematic',
    label: 'Кино-реклама',
    description: 'Пресет раскадровки для атмосферных сюжетов. Сам ролик не создаёт.',
    kind: 'text-to-video',
    strengths: ['cinematic', 'people'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:5'],
    durations: [5, 10],
  },
  {
    id: 'demo-social',
    label: 'Динамичный соцролик',
    description: 'Пресет раскадровки для вертикальных роликов. Сам ролик не создаёт.',
    kind: 'text-to-video',
    strengths: ['dynamic', 'vertical', 'product'],
    aspectRatios: ['9:16', '1:1', '4:5'],
    durations: [5, 10],
  },
  {
    id: 'demo-product-photo',
    label: 'Оживление фото продукта',
    description: 'Пресет раскадровки под фото продукта. Сам ролик не создаёт.',
    kind: 'image-to-video',
    strengths: ['product', 'image-anchor'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:5'],
    durations: [5],
  },
].map((profile) =>
  Object.freeze({
    ...profile,
    provider: 'local-simulation',
    paid: false,
    realVideo: false,
    input: null,
    fixedInput: {},
    estimatedCostUsd: 0,
    priceVerifiedAt: null,
    priceSource: null,
  }),
);

class ProfileConfigError extends Error {
  constructor(message) {
    super(message);
    this.code = 'provider_misconfigured';
  }
}

class RoutingError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(id, message) {
  throw new ProfileConfigError(`Model profile "${id || '?'}": ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEstimate(id, value) {
  if (value === undefined || value === null) return null;
  const check = (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > MAX_ESTIMATE_USD) {
      fail(id, `estimatedCostUsd must be a positive number up to ${MAX_ESTIMATE_USD}.`);
    }
    return n;
  };
  if (typeof value === 'number') return check(value);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, n] of Object.entries(value)) {
      if (!/^\d{1,3}$/.test(key)) fail(id, 'estimatedCostUsd keys must be durations in seconds.');
      out[key] = check(n);
    }
    if (Object.keys(out).length === 0) fail(id, 'estimatedCostUsd must not be empty.');
    return out;
  }
  return fail(id, 'estimatedCostUsd must be a number or an object keyed by duration.');
}

function normalizePaidProfile(raw) {
  if (!isPlainObject(raw)) fail(undefined, 'each profile must be a JSON object.');
  const id = raw.id;
  if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id) || id.startsWith('demo-')) {
    fail(id, 'id must match [a-z0-9-] (2–41 chars) and must not start with "demo-".');
  }
  if (!Object.prototype.hasOwnProperty.call(KINDS, raw.kind)) {
    fail(id, `kind must be one of: ${Object.keys(KINDS).join(', ')}.`);
  }
  if (typeof raw.replicateModel !== 'string' || !REPLICATE_MODEL_PATTERN.test(raw.replicateModel.trim())) {
    fail(id, 'replicateModel must look like "owner/model" or "owner/model:version".');
  }
  const match = raw.replicateModel.trim().match(REPLICATE_MODEL_PATTERN);
  if (!isPlainObject(raw.input)) fail(id, 'input mapping object is required.');
  const input = {};
  for (const key of ['prompt', 'negativePrompt', 'aspectRatio', 'duration', 'image']) {
    const field = raw.input[key];
    if (field === undefined) continue;
    if (typeof field !== 'string' || !INPUT_FIELD_PATTERN.test(field)) {
      fail(id, `input.${key} must be a model input field name.`);
    }
    input[key] = field;
  }
  for (const key of Object.keys(raw.input)) {
    if (!['prompt', 'negativePrompt', 'aspectRatio', 'duration', 'image'].includes(key)) {
      fail(id, `unknown input mapping key "${key}".`);
    }
  }
  if (!input.prompt) fail(id, 'input.prompt is required.');
  if (raw.kind === 'image-to-video' && !input.image) fail(id, 'image-to-video profiles require input.image.');
  if (raw.kind === 'text-to-video' && input.image) fail(id, 'text-to-video profiles must not map input.image.');

  const fixedInput = raw.fixedInput === undefined ? {} : raw.fixedInput;
  if (!isPlainObject(fixedInput)) fail(id, 'fixedInput must be an object.');
  for (const [key, value] of Object.entries(fixedInput)) {
    if (!INPUT_FIELD_PATTERN.test(key)) fail(id, `fixedInput key "${key}" is invalid.`);
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      fail(id, `fixedInput.${key} must be a string, number or boolean.`);
    }
  }

  const aspectRatios = raw.aspectRatios === undefined ? ASPECTS.slice() : raw.aspectRatios;
  if (!Array.isArray(aspectRatios) || aspectRatios.length === 0 || !aspectRatios.every((a) => ASPECTS.includes(a))) {
    fail(id, `aspectRatios must be a non-empty subset of ${ASPECTS.join(', ')}.`);
  }
  let aspectRatioValues = null;
  if (raw.aspectRatioValues !== undefined) {
    if (!isPlainObject(raw.aspectRatioValues)) fail(id, 'aspectRatioValues must be an object.');
    aspectRatioValues = {};
    for (const [key, value] of Object.entries(raw.aspectRatioValues)) {
      if (!ASPECTS.includes(key) || typeof value !== 'string' || value.length > 32) {
        fail(id, 'aspectRatioValues must map aspect ratios to short strings.');
      }
      aspectRatioValues[key] = value;
    }
  }
  const durations = raw.durations === undefined ? [5] : raw.durations;
  if (
    !Array.isArray(durations) ||
    durations.length === 0 ||
    !durations.every((d) => Number.isInteger(d) && d > 0 && d <= 60)
  ) {
    fail(id, 'durations must be a non-empty list of whole seconds (1–60).');
  }
  const strengths = raw.strengths === undefined ? [] : raw.strengths;
  if (!Array.isArray(strengths) || !strengths.every((s) => Object.prototype.hasOwnProperty.call(TAG_LABELS, s))) {
    fail(id, `strengths must be a subset of: ${Object.keys(TAG_LABELS).join(', ')}.`);
  }
  const text = (value, max, name) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > max) fail(id, `${name} must be a string up to ${max} chars.`);
    return value;
  };

  return Object.freeze({
    id,
    label: text(raw.label, 80, 'label') || id,
    description: text(raw.description, 240, 'description') || '',
    kind: raw.kind,
    provider: 'replicate',
    paid: true,
    realVideo: true,
    replicateModel: raw.replicateModel.trim(),
    parsedModel: { owner: match[1], name: match[2], version: match[3] || null },
    input,
    fixedInput: { ...fixedInput },
    aspectRatios: aspectRatios.slice(),
    aspectRatioValues,
    durations: durations.slice().sort((a, b) => a - b),
    strengths: strengths.slice(),
    estimatedCostUsd: normalizeEstimate(id, raw.estimatedCostUsd),
    priceVerifiedAt: text(raw.priceVerifiedAt, 40, 'priceVerifiedAt'),
    priceSource: text(raw.priceSource, 300, 'priceSource'),
    schemaVerifiedAt: text(raw.schemaVerifiedAt, 40, 'schemaVerifiedAt'),
  });
}

function parseJsonSetting(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new ProfileConfigError(`${name} is not valid JSON.`);
  }
}

// Builds the paid (Replicate) profiles from operator configuration. Nothing is
// enabled unless VIDEO_PROVIDER=replicate.
function loadPaidProfiles({ profilesJson, legacyModel, legacyExtraInput, legacyEstimatedCostUsd } = {}) {
  const parsed = parseJsonSetting(profilesJson, 'VIDEO_MODEL_PROFILES_JSON');
  const profiles = [];
  if (parsed !== null) {
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) {
      throw new ProfileConfigError('VIDEO_MODEL_PROFILES_JSON must be a JSON array with 1–20 profiles.');
    }
    for (const raw of parsed) profiles.push(normalizePaidProfile(raw));
  } else if (legacyModel) {
    // Backwards compatible single-model setup (REPLICATE_MODEL + prompt input).
    const extra = parseJsonSetting(legacyExtraInput, 'REPLICATE_EXTRA_INPUT_JSON');
    if (extra !== null && !isPlainObject(extra)) {
      throw new ProfileConfigError('REPLICATE_EXTRA_INPUT_JSON must be a JSON object.');
    }
    const fixedInput = {};
    for (const [key, value] of Object.entries(extra || {})) {
      if (key !== 'prompt') fixedInput[key] = value;
    }
    const cost = legacyEstimatedCostUsd === undefined || legacyEstimatedCostUsd === '' ? undefined : Number(legacyEstimatedCostUsd);
    profiles.push(
      normalizePaidProfile({
        id: 'replicate-default',
        label: 'Replicate (REPLICATE_MODEL)',
        description: 'Модель из переменной REPLICATE_MODEL. Принимает только prompt и REPLICATE_EXTRA_INPUT_JSON.',
        kind: 'text-to-video',
        replicateModel: legacyModel,
        input: { prompt: 'prompt' },
        fixedInput,
        durations: DURATIONS.slice(),
        estimatedCostUsd: cost,
      }),
    );
  }
  const ids = new Set();
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new ProfileConfigError(`Duplicate model profile id "${profile.id}".`);
    ids.add(profile.id);
  }
  return profiles;
}

function clipDurationFor(profile, requested) {
  const fitting = profile.durations.filter((d) => d <= requested);
  return fitting.length > 0 ? fitting[fitting.length - 1] : profile.durations[0];
}

function estimateFor(profile, clipDuration) {
  const value = profile.estimatedCostUsd;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  return Object.prototype.hasOwnProperty.call(value, String(clipDuration)) ? value[String(clipDuration)] : null;
}

function incompatibility(profile, plan, hasImage) {
  if (profile.kind === 'image-to-video' && !hasImage) {
    return { code: 'image_required', message: 'Модель оживляет фото — загрузите изображение продукта.' };
  }
  if (profile.kind === 'text-to-video' && hasImage) {
    return { code: 'image_not_supported', message: 'Модель работает только с текстом и не использует фото.' };
  }
  if (!profile.aspectRatios.includes(plan.brief.aspect)) {
    return { code: 'aspect_not_supported', message: `Формат ${plan.brief.aspect} не поддерживается.` };
  }
  return null;
}

function durationNote(clipDuration, requested) {
  return clipDuration < requested
    ? `Модель делает клипы до ${clipDuration} сек — ролик ${requested} сек собирается из нескольких генераций (сейчас создаётся один клип).`
    : `Длительность клипа: ${clipDuration} сек.`;
}

// Chooses a profile. Manual choice is validated, never silently replaced.
// Auto mode only considers profiles of the requested tier ("demo" or "paid"),
// so it can never fall back from a demo request to a billable model or from
// one paid model to another without the user seeing the choice in a quote.
function selectProfile({ profiles, plan, tier = 'demo', modelId = 'auto', hasImage = false }) {
  if (modelId && modelId !== 'auto') {
    const profile = profiles.find((item) => item.id === modelId);
    if (!profile) throw new RoutingError('unknown_model', 'Такой модели нет в списке сервера.');
    const problem = incompatibility(profile, plan, hasImage);
    if (problem) throw new RoutingError(problem.code, problem.message);
    const clipDuration = clipDurationFor(profile, plan.brief.duration);
    return {
      mode: 'manual',
      profile,
      clipDuration,
      rationale: [`Модель выбрана вручную: «${profile.label}».`, durationNote(clipDuration, plan.brief.duration)],
      rejected: [],
    };
  }

  if (tier !== 'demo' && tier !== 'paid') throw new RoutingError('invalid_tier', 'Неизвестный режим.');
  const pool = profiles.filter((item) => item.paid === (tier === 'paid'));
  if (pool.length === 0) {
    throw new RoutingError(
      'no_models_configured',
      tier === 'paid' ? 'Платные модели не настроены на сервере.' : 'Демо-модели недоступны.',
    );
  }
  const rejected = [];
  const scored = [];
  for (const profile of pool) {
    const problem = incompatibility(profile, plan, hasImage);
    if (problem) {
      rejected.push({ id: profile.id, label: profile.label, reason: problem.message });
      continue;
    }
    const matches = profile.strengths.filter((tag) => plan.tags.includes(tag));
    const clipDuration = clipDurationFor(profile, plan.brief.duration);
    const exact = profile.durations.includes(plan.brief.duration) ? 1 : 0;
    const cost = estimateFor(profile, clipDuration);
    scored.push({ profile, matches, clipDuration, score: matches.length * 2 + exact, cost });
  }
  if (scored.length === 0) {
    throw new RoutingError('no_matching_model', 'Ни одна модель не подходит под этот бриф.', { rejected });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.cost === null ? Infinity : a.cost) - (b.cost === null ? Infinity : b.cost) ||
      a.profile.id.localeCompare(b.profile.id),
  );
  const best = scored[0];
  const rationale = [
    hasImage
      ? 'Есть фото продукта → нужна модель «фото → видео».'
      : 'Фото нет → подходят модели «текст → видео».',
    `Формат ${plan.brief.aspect} поддерживается.`,
    best.matches.length > 0
      ? `Совпадение по стилю брифа: ${best.matches.map((tag) => TAG_LABELS[tag]).join(', ')}.`
      : 'Явных совпадений по стилю нет — выбрана наиболее универсальная модель.',
    durationNote(best.clipDuration, plan.brief.duration),
    `Рассмотрено моделей: ${pool.length}, не подошло: ${rejected.length}.`,
  ];
  return { mode: 'auto', profile: best.profile, clipDuration: best.clipDuration, rationale, rejected };
}

// Maps the plan onto the exact input fields of the selected profile.
function buildProviderInput(profile, plan, { clipDuration, image } = {}) {
  if (!profile.input) throw new RoutingError('not_a_provider_profile', 'Профиль не вызывает внешнего провайдера.');
  const input = { ...profile.fixedInput };
  input[profile.input.prompt] = plan.modelPrompt;
  if (profile.input.negativePrompt) input[profile.input.negativePrompt] = plan.negativePrompt;
  if (profile.input.aspectRatio) {
    const aspect = plan.brief.aspect;
    input[profile.input.aspectRatio] =
      profile.aspectRatioValues && profile.aspectRatioValues[aspect] ? profile.aspectRatioValues[aspect] : aspect;
  }
  if (profile.input.duration) input[profile.input.duration] = clipDuration;
  if (profile.kind === 'image-to-video') {
    if (!image || !image.dataUrl) throw new RoutingError('image_required', 'Нужно фото продукта.');
    input[profile.input.image] = image.dataUrl;
  }
  return input;
}

function hasImageSignature(mime, buf) {
  switch (mime) {
    case 'image/png':
      return buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
    case 'image/jpeg':
      return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/webp':
      return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    default:
      return false;
  }
}

function validateImage(value, maxBytes) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 1.4) + 64) {
    throw new RoutingError('image_too_large', `Изображение больше ${Math.round(maxBytes / 1024)} КБ.`);
  }
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) {
    throw new RoutingError('invalid_image', 'Нужна картинка PNG, JPEG или WebP.');
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > maxBytes) {
    throw new RoutingError('image_too_large', `Изображение больше ${Math.round(maxBytes / 1024)} КБ.`);
  }
  if (!hasImageSignature(match[1], buffer)) {
    throw new RoutingError('invalid_image', 'Файл не похож на изображение заявленного типа.');
  }
  return {
    dataUrl: value,
    mime: match[1],
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

function publicProfile(profile) {
  return {
    id: profile.id,
    label: profile.label,
    description: profile.description,
    kind: profile.kind,
    kindLabel: KINDS[profile.kind],
    provider: profile.provider,
    providerModel: profile.paid ? profile.replicateModel : null,
    paid: profile.paid,
    realVideo: profile.realVideo,
    requiresImage: profile.kind === 'image-to-video',
    aspectRatios: profile.aspectRatios,
    durations: profile.durations,
    strengths: profile.strengths.map((tag) => TAG_LABELS[tag]),
    estimatedCostUsd: profile.paid ? profile.estimatedCostUsd : 0,
    priceVerifiedAt: profile.priceVerifiedAt,
    priceSource: profile.priceSource,
  };
}

module.exports = {
  DEMO_PROFILES,
  KINDS,
  TAG_LABELS,
  ProfileConfigError,
  RoutingError,
  loadPaidProfiles,
  normalizePaidProfile,
  selectProfile,
  buildProviderInput,
  estimateFor,
  validateImage,
  publicProfile,
};

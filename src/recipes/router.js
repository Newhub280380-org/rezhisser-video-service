'use strict';

const { RecipeError } = require('./errors.js');
const { canonicalKind } = require('./kinds.js');

// Decision rules from recipes/router.md: request text -> intent tags ->
// required inputs -> best recipe by use_when, completeness and confidence.
const INTENT_RULES = [
  { tag: 'beauty_ad', re: /космети|филлер|beauty|крем|помад|макияж|духи|парфюм|косметолог|уход за/i },
  { tag: 'pov_one_take', re: /\bpov\b|one[\s-]?take|одним дублем|от первого лица|прол[её]т|\bfpv\b/i },
  { tag: 'talking_head', re: /говорящ|talking[\s-]?head|липсинк|lip[\s-]?sync|озвуч|говорит в камер|реплик/i },
  { tag: 'seamless_series', re: /бесшов|seamless|последн\w*\s+кадр|last frame|цепочк\w*\s+клип/i },
  { tag: 'dance', re: /танц|хореограф|\bdance\b/i },
  { tag: 'family_photos', re: /семь|старое фото|реставрац/i },
  { tag: 'animal', re: /питом|собак|кошк|\bкот\b|животн|\bpet\b/i },
  { tag: 'motion_transfer', re: /motion control|перенос движен|видео-референс/i },
  { tag: 'client_in_clip', re: /вставь|вставить|по моему фото|по его фото|фото клиента|вместо исполнителя|вместо героя|подмени|подмена героя/i },
  { tag: 'product_ad', re: /реклам|товар|продукт|\bбренд|ugc|карточк|упаковк/i },
  { tag: 'meme', re: /\bмем|вирусн|viral|тренд|смешн/i },
  { tag: 'vfx_effect', re: /\bэффект|\bvfx|трансформ|взрыв|морф/i },
  { tag: 'object_alive', re: /оживл|оживить|говорящий предмет/i },
];

const SPECIFICITY = [
  'beauty_ad',
  'pov_one_take',
  'dance',
  'family_photos',
  'animal',
  'talking_head',
  'motion_transfer',
  'seamless_series',
  'client_in_clip',
  'product_ad',
  'meme',
  'vfx_effect',
  'object_alive',
  'other',
];

const COMPLETENESS_SCORE = { complete: 10, partial: 4, gaps: 0 };
const CONFIDENCE_SCORE = { B: 6, 'B/C': 3, C: 1, unknown: 0 };

const STOP = new Set(
  'для это как или при над под без том так что его нее она они мой моя мое мои меня тебя свой своя свои этот эта эти видео ролик ролика нужен нужна нужно сделай сними хочу надо будет быть если только уже еще ещё про тебя вас вам'.split(' '),
);

const ENDING = /(иями|ями|ами|ого|ему|ому|ыми|ими|ая|яя|ое|ее|ые|ие|ой|ей|ый|ий|ую|юю|ом|ем|ах|ях|ам|ям|ов|ев|а|я|ы|и|о|е|у|ю)$/;

const SYNONYMS = {
  музыка: ['music'],
  липсин: ['lipsync'],
};

const PHRASES = [
  { stems: ['говоря', 'голов'], bonus: 14 },
  { stems: ['космет'], bonus: 7 },
  { stems: ['music', 'клип'], bonus: 9 },
  { stems: ['реальн', 'послед', 'кадр'], bonus: 12 },
  { stems: ['pov', 'дубл'], bonus: 8 },
  { stems: ['pov'], bonus: 5 },
];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ');
}

function stem(word) {
  if (/^[a-z0-9]+$/.test(word)) return word.length > 16 ? word.slice(0, 16) : word;
  let value = word.replace(/[ьъ]$/, '');
  value = value.replace(ENDING, '');
  if (value.length < 3) value = word.slice(0, Math.min(5, word.length));
  if (value.length > 6) value = value.slice(0, 6);
  return value;
}

function tokens(text) {
  return normalize(text)
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOP.has(word));
}

function stemSet(text, { expand = false } = {}) {
  const out = new Set();
  for (const word of tokens(text)) {
    const value = stem(word);
    if (value.length < 3) continue;
    out.add(value);
    if (expand && SYNONYMS[value]) {
      for (const extra of SYNONYMS[value]) out.add(extra);
    }
  }
  return out;
}

function cleanRequest(value) {
  if (typeof value !== 'string') throw new RecipeError('invalid_request', 'Нужен текст запроса.');
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new RecipeError('invalid_request', 'Нужен текст запроса.');
  if (text.length > 4000) throw new RecipeError('invalid_request', 'Запрос длиннее 4000 символов.');
  return text;
}

function cleanName(value, index) {
  const name = String(value || '').replace(/[\u0000-\u001f]/g, '').replace(/[/\\]/g, '').trim();
  if (!name || name.length > 120) return `file-${index + 1}`;
  return name;
}

function normalizeFiles(files) {
  if (files == null) return [];
  if (!Array.isArray(files)) throw new RecipeError('invalid_files', 'Список файлов должен быть массивом.');
  if (files.length > 24) throw new RecipeError('invalid_files', 'Не больше 24 файлов на задачу.');
  return files.map((file, index) => {
    if (typeof file === 'string') {
      return { name: cleanName(file, index), kind: '', slot: null, url: null };
    }
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new RecipeError('invalid_files', 'Каждый файл — строка или объект { name, kind }.');
    }
    const rawKind = file.kind != null ? file.kind : file.role != null ? file.role : file.type;
    const kind = canonicalKind(rawKind == null || rawKind === '' ? '' : rawKind);
    if (kind === null) throw new RecipeError('invalid_files', `Неизвестный тип файла «${rawKind}».`);
    let url = null;
    if (file.url != null) {
      if (typeof file.url !== 'string' || !/^https:\/\//i.test(file.url) || file.url.length > 2000) {
        throw new RecipeError('invalid_files', 'url файла должен быть https-ссылкой короче 2000 символов.');
      }
      url = file.url;
    }
    const slot = file.slot == null || file.slot === '' ? null : String(file.slot).replace(/\s+/g, ' ').trim().slice(0, 40);
    return { name: cleanName(file.name || file.filename, index), kind, slot, url };
  });
}

function detectIntents(text) {
  return INTENT_RULES.filter((rule) => rule.re.test(text)).map((rule) => rule.tag);
}

function requiredInputs(recipe) {
  return recipe.inputs.filter((item) => item && item !== 'unknown');
}

function hasKind(files, needed) {
  if (files.some((file) => file.kind === needed)) return true;
  if (needed === 'фото лица/портрет человека' && files.some((file) => file.kind === 'фото в полный рост')) return true;
  return false;
}

function missingInputs(recipe, files) {
  return requiredInputs(recipe).filter((kind) => !hasKind(files, kind));
}

function toolNames(step) {
  if (Array.isArray(step.tool)) return step.tool;
  return step.tool && step.tool !== 'unknown' ? [step.tool] : [];
}

function unknownToolRatio(recipe) {
  const unknown = recipe.steps.filter((step) => toolNames(step).length === 0).length;
  return unknown / recipe.steps.length;
}

function indexRecipes(recipes) {
  const docs = recipes.map((recipe) => {
    const titleStems = stemSet(`${recipe.title}`);
    const idStems = stemSet(recipe.id.replace(/^\d+_/, '').replace(/_/g, ' '));
    const stems = stemSet(`${recipe.title}\n${recipe.use_when}\n${recipe.id.replace(/_/g, ' ')}`);
    for (const stem of titleStems) stems.add(stem);
    for (const stem of idStems) stems.add(stem);
    return { recipe, stems, titleStems, idStems };
  });
  const df = new Map();
  for (const doc of docs) {
    for (const stem of doc.stems) df.set(stem, (df.get(stem) || 0) + 1);
  }
  return { docs, df, total: recipes.length };
}

function idfOf(df, total, stem) {
  return Math.log((total + 1) / ((df.get(stem) || 0) + 0.5));
}

function scoreDoc(doc, queryStems, tags, files, df, total) {
  const { recipe, stems, titleStems, idStems } = doc;
  let lexical = 0;
  const overlap = [];
  for (const stem of queryStems) {
    if (!stems.has(stem)) continue;
    let weight = idfOf(df, total, stem);
    if (titleStems.has(stem)) weight *= 1.6;
    if (idStems.has(stem)) weight *= 1.3;
    lexical += weight;
    overlap.push(stem);
  }
  let phrase = 0;
  for (const item of PHRASES) {
    if (item.stems.every((stem) => queryStems.has(stem) && stems.has(stem))) phrase += item.bonus;
  }
  const matchedTags = tags.filter((tag) => recipe.intent_tags.includes(tag));
  const extra = recipe.intent_tags.filter((tag) => !matchedTags.includes(tag) && tag !== 'other').length;
  const needed = requiredInputs(recipe);
  const satisfied = needed.filter((kind) => hasKind(files, kind)).length;
  const score =
    lexical +
    phrase +
    (COMPLETENESS_SCORE[recipe.prompt_completeness] || 0) +
    (CONFIDENCE_SCORE[recipe.confidence] || 0) -
    unknownToolRatio(recipe) * 5 -
    extra * 1.25 +
    satisfied * 1.2 +
    (needed.length > 0 && satisfied === needed.length ? 2 : 0) -
    (needed.length === 0 ? 3 : 0);
  return { score, overlap, matchedTags, extra, satisfied };
}

function poolFor(docs, tags) {
  let current = tags.slice();
  const order = [...SPECIFICITY].reverse();
  while (current.length) {
    const matched = docs.filter((doc) => current.every((tag) => doc.recipe.intent_tags.includes(tag)));
    if (matched.length) return { tags: current, docs: matched, relaxed: current.length !== tags.length };
    const drop = order.find((tag) => current.includes(tag));
    current = current.filter((tag) => tag !== drop);
  }
  return { tags: [], docs, relaxed: tags.length > 0 };
}

function summary(recipe) {
  return {
    id: recipe.id,
    title: recipe.title,
    intent_tags: recipe.intent_tags,
    use_when: recipe.use_when,
    inputs: recipe.inputs,
    confidence: recipe.confidence,
    prompt_completeness: recipe.prompt_completeness,
    output: recipe.output,
    done_criteria: recipe.done_criteria,
    duplicates_of: recipe.duplicates_of,
  };
}

function questionsFor(missing) {
  return missing.map((kind) => `Пришлите файл: ${kind}. Он попадёт только в слоты, которые уже есть в тексте промпта (Image 1, @Image1 и похожие).`);
}

function createRouter(recipes) {
  const index = indexRecipes(recipes);
  return {
    route(input = {}) {
      const text = cleanRequest(input.text != null ? input.text : input.request);
      const files = normalizeFiles(input.files);
      const detected = detectIntents(text);
      const queryStems = stemSet(text, { expand: true });
      const pool = poolFor(index.docs, detected);
      const ranked = pool.docs
        .map((doc) => ({ doc, ...scoreDoc(doc, queryStems, pool.tags, files, index.df, index.total) }))
        .sort((a, b) => b.score - a.score || a.doc.recipe.id.localeCompare(b.doc.recipe.id));
      const best = ranked[0];
      const recipe = best.doc.recipe;
      const missing = missingInputs(recipe, files);
      const unknownPrompts = recipe.steps.filter((step) => step.prompt === 'unknown' || (Array.isArray(step.prompt) && step.prompt.length === 0)).length;
      const lines = [
        detected.length
          ? `Запрос распознан как: ${detected.join(', ')}.`
          : 'По тексту не нашлось устойчивого намерения — выбор только по близости формулировки.',
        pool.relaxed ? `Полное совпадение всех тегов не нашлось, оставлены теги: ${pool.tags.join(', ') || '—'}.` : '',
        `Выбран ${recipe.id} — «${recipe.title}».`,
        `Совпавшие теги: ${best.matchedTags.join(', ') || '—'}. Полнота промпта: ${recipe.prompt_completeness}. Уверенность: ${recipe.confidence}.`,
        `Слова запроса в названии и use_when: ${best.overlap.slice(0, 8).join(', ') || 'нет'}.`,
        unknownPrompts
          ? `В рецепте ${unknownPrompts} шаг(ов) с промптом unknown. Текст за них не дописывается.`
          : '',
        recipe.duplicates_of.length && recipe.prompt_completeness === 'gaps'
          ? `Близкие варианты: ${recipe.duplicates_of.join(', ')}.`
          : '',
        missing.length
          ? `Не хватает файлов: ${missing.join('; ')}.`
          : requiredInputs(recipe).length
            ? 'Обязательные файлы рецепта есть в списке загрузок.'
            : 'Рецепт не перечисляет обязательные файлы.',
      ].filter(Boolean);
      return {
        text,
        files,
        intents: detected,
        appliedTags: pool.tags,
        missingInputs: missing,
        questions: questionsFor(missing),
        reasoning: lines.join(' '),
        chosen: recipe,
        chosenSummary: summary(recipe),
        alternatives: ranked.slice(1, 4).map((item) => ({
          id: item.doc.recipe.id,
          title: item.doc.recipe.title,
          score: Math.round(item.score * 1000) / 1000,
          confidence: item.doc.recipe.confidence,
          prompt_completeness: item.doc.recipe.prompt_completeness,
          intent_tags: item.doc.recipe.intent_tags,
          why: `Теги: ${item.matchedTags.join(', ') || '—'}. Полнота ${item.doc.recipe.prompt_completeness}, уверенность ${item.doc.recipe.confidence}. Совпадения: ${item.overlap.slice(0, 6).join(', ') || 'нет'}.`,
        })),
      };
    },
  };
}

module.exports = {
  createRouter,
  detectIntents,
  normalizeFiles,
  missingInputs,
  cleanRequest,
};

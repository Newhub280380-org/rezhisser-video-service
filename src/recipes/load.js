'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('yaml');
const { RecipeError } = require('./errors.js');

const LIBRARY_ROOT = path.join(__dirname, '..', '..', 'recipes');
const RECIPES_DIR = path.join(LIBRARY_ROOT, 'recipes');

const INTENT_TAGS = new Set([
  'product_ad',
  'beauty_ad',
  'talking_head',
  'client_in_clip',
  'seamless_series',
  'meme',
  'pov_one_take',
  'animal',
  'object_alive',
  'vfx_effect',
  'family_photos',
  'dance',
  'motion_transfer',
  'other',
]);

const INPUT_SOURCES = new Set(['user_input', 'previous_step_output', 'last_frame', 'unknown']);
const COMPLETENESS = new Set(['complete', 'partial', 'gaps']);
const CONFIDENCE = /^(?:[ABC](?:\/[ABC])?|unknown)$/;
const ID_PATTERN = /^\d{3}_[A-Za-z0-9_]+$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(id, message) {
  throw new RecipeError('invalid_recipe', `Рецепт «${id || '?'}»: ${message}`);
}

function asString(id, value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') fail(id, `поле ${field} должно быть строкой.`);
  return value;
}

function validateStep(id, step, index) {
  if (!isObject(step)) fail(id, `шаг ${index + 1} должен быть объектом.`);
  if (!Number.isInteger(step.n) || step.n < 1) fail(id, `шаг ${index + 1}: n должен быть целым числом от 1.`);
  if (typeof step.action !== 'string' || !step.action.trim()) fail(id, `шаг ${step.n}: пустое action.`);
  const tool = step.tool;
  if (typeof tool === 'string') {
    if (!tool.trim()) fail(id, `шаг ${step.n}: пустой tool.`);
  } else if (Array.isArray(tool)) {
    if (tool.length === 0 || tool.some((item) => typeof item !== 'string' || !item.trim())) {
      fail(id, `шаг ${step.n}: tool должен быть списком названий.`);
    }
  } else {
    fail(id, `шаг ${step.n}: tool должен быть строкой или списком.`);
  }
  const prompt = step.prompt;
  if (typeof prompt === 'string') {
    if (!prompt.trim()) fail(id, `шаг ${step.n}: пустой prompt.`);
  } else if (Array.isArray(prompt)) {
    if (prompt.some((item) => typeof item !== 'string')) fail(id, `шаг ${step.n}: prompt должен быть текстом.`);
  } else {
    fail(id, `шаг ${step.n}: prompt должен быть строкой или списком строк.`);
  }
  for (const field of ['mode', 'duration', 'aspect']) asString(id, step[field], `steps[${step.n}].${field}`);
  const source = asString(id, step.input_source, `steps[${step.n}].input_source`);
  if (!INPUT_SOURCES.has(source)) fail(id, `шаг ${step.n}: неизвестный input_source «${source}».`);
  return step;
}

function validateRecipe(raw, sourceName) {
  if (!isObject(raw)) fail(sourceName, 'корень YAML должен быть объектом.');
  const id = raw.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) fail(id || sourceName, 'id должен быть вида 001_slug.');
  if (sourceName && sourceName !== `${id}.yaml`) fail(id, `имя файла ${sourceName} не совпадает с id.`);
  if (typeof raw.title !== 'string' || !raw.title.trim()) fail(id, 'пустой title.');
  if (typeof raw.use_when !== 'string' || !raw.use_when.trim()) fail(id, 'пустое use_when.');
  if (!Array.isArray(raw.intent_tags) || raw.intent_tags.length === 0) fail(id, 'нужен список intent_tags.');
  for (const tag of raw.intent_tags) {
    if (!INTENT_TAGS.has(tag)) fail(id, `неизвестный intent tag «${tag}».`);
  }
  if (!Array.isArray(raw.inputs) || raw.inputs.length === 0 || raw.inputs.some((item) => typeof item !== 'string' || !item.trim())) {
    fail(id, 'inputs должен быть непустым списком строк.');
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) fail(id, 'нужен хотя бы один шаг.');
  const seen = new Set();
  raw.steps.forEach((step, index) => {
    validateStep(id, step, index);
    if (seen.has(step.n)) fail(id, `повторяется номер шага ${step.n}.`);
    seen.add(step.n);
  });
  if (raw.prompts_verbatim !== undefined) {
    if (!Array.isArray(raw.prompts_verbatim) || raw.prompts_verbatim.some((item) => typeof item !== 'string')) {
      fail(id, 'prompts_verbatim должен быть списком строк.');
    }
  }
  if (!isObject(raw.output) || typeof raw.output.format !== 'string' || !raw.output.format.trim()) {
    fail(id, 'output.format обязателен.');
  }
  for (const field of ['resolution', 'aspect']) {
    if (raw.output[field] !== undefined) asString(id, raw.output[field], `output.${field}`);
  }
  asString(id, raw.done_criteria, 'done_criteria');
  const confidence = asString(id, raw.confidence, 'confidence').trim();
  if (!CONFIDENCE.test(confidence)) fail(id, `неизвестная confidence «${confidence}».`);
  const completeness = asString(id, raw.prompt_completeness, 'prompt_completeness').trim();
  if (!COMPLETENESS.has(completeness)) fail(id, `неизвестная prompt_completeness «${completeness}».`);
  if (!Array.isArray(raw.duplicates_of) || raw.duplicates_of.some((item) => typeof item !== 'string')) {
    fail(id, 'duplicates_of должен быть списком id.');
  }
  if (raw.notes !== undefined && raw.notes !== null && typeof raw.notes !== 'string') fail(id, 'notes должен быть строкой.');
  if (raw.source_url !== undefined && raw.source_url !== null && typeof raw.source_url !== 'string') {
    fail(id, 'source_url должен быть строкой.');
  }
  if (raw.source_file !== undefined && typeof raw.source_file !== 'string') fail(id, 'source_file должен быть строкой.');
  return raw;
}

function freezeRecipe(recipe) {
  for (const step of recipe.steps) Object.freeze(step);
  if (recipe.prompts_verbatim) Object.freeze(recipe.prompts_verbatim);
  Object.freeze(recipe.intent_tags);
  Object.freeze(recipe.inputs);
  Object.freeze(recipe.steps);
  Object.freeze(recipe.output);
  Object.freeze(recipe.duplicates_of);
  return Object.freeze(recipe);
}

function loadRecipes(dir = RECIPES_DIR) {
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.yaml')).sort();
  if (names.length === 0) throw new RecipeError('recipes_missing', `В ${dir} нет YAML-рецептов.`);
  const recipes = [];
  const ids = new Set();
  for (const name of names) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    let parsed;
    try {
      parsed = parse(text, { uniqueKeys: true, maxAliasCount: 10 });
    } catch (error) {
      throw new RecipeError('invalid_recipe', `Не читается ${name}: ${error.message}`);
    }
    const recipe = validateRecipe(parsed, name);
    if (ids.has(recipe.id)) throw new RecipeError('invalid_recipe', `Повторяется id ${recipe.id}.`);
    ids.add(recipe.id);
    recipes.push(freezeRecipe(recipe));
  }
  const catalogPath = path.join(path.dirname(dir), 'catalog.json');
  if (fs.existsSync(catalogPath)) {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    if (!Array.isArray(catalog)) throw new RecipeError('invalid_recipe', 'catalog.json должен быть массивом.');
    const catalogIds = new Set(catalog.map((item) => item && item.id));
    for (const id of ids) {
      if (!catalogIds.has(id)) throw new RecipeError('invalid_recipe', `catalog.json не содержит ${id}.`);
    }
    for (const id of catalogIds) {
      if (!ids.has(id)) throw new RecipeError('invalid_recipe', `В catalog.json есть ${id}, но нет YAML.`);
    }
  }
  return recipes;
}

let cached = null;

function getLibrary(dir = RECIPES_DIR) {
  if (cached && cached.dir === dir) return cached.value;
  const recipes = loadRecipes(dir);
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const value = {
    dir,
    recipes,
    size: recipes.length,
    get(id) {
      return typeof id === 'string' ? byId.get(id) || null : null;
    },
  };
  cached = { dir, value };
  return value;
}

module.exports = {
  LIBRARY_ROOT,
  RECIPES_DIR,
  INTENT_TAGS,
  INPUT_SOURCES,
  validateRecipe,
  loadRecipes,
  getLibrary,
};

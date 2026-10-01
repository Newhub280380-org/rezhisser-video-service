'use strict';

// Content library: ready-to-use prompt templates for the CIS (SNS) market and
// a separate Chinese (中文) stream. Data lives in sng.json / china.json and is
// validated at startup; search is in-memory.

const SOURCES = [require('./sng.json'), require('./china.json')];

const ENUMS = {
  region: ['sng', 'china'],
  country: ['ru', 'kz', 'tj', 'uz', 'kg', 'sng', 'cn'],
  language: ['ru', 'zh'],
  category: ['fashion', 'beauty', 'cars', 'food', 'memes', 'halal', 'tech', 'humor', 'crafts', 'cotton', 'heritage', 'tourism', 'outdoor', 'live-commerce', 'luxury', 'ugc', 'reels'],
  type: ['ad', 'meme', 'ugc', 'live-commerce', 'hook'],
  trend: ['hot', 'rising', 'evergreen'],
  aspect: ['9:16', '16:9', '1:1'],
};
const TREND_ORDER = { hot: 0, rising: 1, evergreen: 2 };
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

class LibraryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
  }
}

function validateItem(item) {
  if (!item || !ID_PATTERN.test(item.id)) throw new Error(`library: bad id ${item && item.id}`);
  for (const [field, allowed] of Object.entries(ENUMS)) {
    if (!allowed.includes(item[field])) throw new Error(`library: ${item.id} has invalid ${field}`);
  }
  for (const field of ['title', 'description', 'prompt', 'promptEn', 'negativePrompt']) {
    if (typeof item[field] !== 'string' || !item[field].trim()) throw new Error(`library: ${item.id} missing ${field}`);
  }
  if (![5, 10].includes(item.duration) || !Array.isArray(item.tags) || !item.template || !Array.isArray(item.template.shots)) {
    throw new Error(`library: ${item.id} has an invalid template`);
  }
}

function loadItems(sources = SOURCES) {
  const items = [];
  const ids = new Set();
  for (const source of sources) {
    for (const item of source.items) {
      validateItem(item);
      if (ids.has(item.id)) throw new Error(`library: duplicate id ${item.id}`);
      ids.add(item.id);
      items.push(Object.freeze(item));
    }
  }
  return items;
}

function summary(item) {
  return {
    id: item.id,
    region: item.region,
    country: item.country,
    language: item.language,
    category: item.category,
    type: item.type,
    title: item.title,
    description: item.description,
    preview: item.prompt.length > 180 ? `${item.prompt.slice(0, 180)}…` : item.prompt,
    aspect: item.aspect,
    duration: item.duration,
    trend: item.trend,
    tags: item.tags,
    needsPhoto: item.needsPhoto,
  };
}

function optionalEnum(value, field) {
  if (value === undefined || value === null || value === '' || value === 'all') return null;
  if (typeof value !== 'string' || !ENUMS[field].includes(value)) {
    throw new LibraryError('invalid_filter', `Unknown ${field}.`);
  }
  return value;
}

function createLibrary(items = loadItems()) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const searchText = new Map(
    items.map((item) => [item.id, [item.title, item.description, item.prompt, item.promptEn, ...item.tags].join(' ').toLowerCase()]),
  );

  function facets(list) {
    const count = (field) =>
      list.reduce((acc, item) => {
        acc[item[field]] = (acc[item[field]] || 0) + 1;
        return acc;
      }, {});
    return { region: count('region'), country: count('country'), language: count('language'), category: count('category'), type: count('type'), trend: count('trend') };
  }

  return {
    items,
    size: items.length,
    get(id) {
      return typeof id === 'string' && byId.has(id) ? byId.get(id) : null;
    },
    search(params = {}) {
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new LibraryError('invalid_filter', 'Invalid search.');
      const filters = {};
      for (const field of ['region', 'country', 'language', 'category', 'type', 'trend']) filters[field] = optionalEnum(params[field], field);
      if (params.query !== undefined && (typeof params.query !== 'string' || params.query.length > 200)) {
        throw new LibraryError('invalid_filter', 'Query must be a string up to 200 characters.');
      }
      const terms = (params.query || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
      const limit = Number.isInteger(params.limit) ? Math.min(100, Math.max(1, params.limit)) : 24;
      const offset = Number.isInteger(params.offset) ? Math.min(10000, Math.max(0, params.offset)) : 0;

      const matched = items.filter((item) => {
        for (const [field, value] of Object.entries(filters)) if (value && item[field] !== value) return false;
        const text = searchText.get(item.id);
        return terms.every((term) => text.includes(term));
      });
      matched.sort((a, b) => TREND_ORDER[a.trend] - TREND_ORDER[b.trend] || a.id.localeCompare(b.id));
      return {
        total: matched.length,
        offset,
        limit,
        items: matched.slice(offset, offset + limit).map(summary),
        facets: facets(matched),
      };
    },
  };
}

module.exports = { createLibrary, loadItems, summary, ENUMS, LibraryError };

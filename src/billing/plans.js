'use strict';

// Products, prices and entitlements.
//
// Subscriptions are sold as prepaid 30-day periods (one payment = one period),
// which works identically with YooKassa and Stripe and with every local card
// network. Prices are in minor units (kopecks, tiyn, cents, fen) and can be
// overridden with PRICES_JSON, e.g. {"pro":{"RUB":49000}}.

const CURRENCIES = ['RUB', 'KZT', 'USD', 'CNY'];
const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

const TIERS = {
  free: { id: 'free', label: 'Free', videosPerPeriod: 0, demoOnly: true },
  pro: { id: 'pro', label: 'Pro', videosPerPeriod: 50, demoOnly: false },
  studio: { id: 'studio', label: 'Studio', videosPerPeriod: null, demoOnly: false },
};

const DEFAULT_PRODUCTS = {
  pro: {
    id: 'pro',
    kind: 'subscription',
    tier: 'pro',
    title: { ru: 'Pro — 50 видео в месяц', zh: 'Pro — 每月 50 条视频', en: 'Pro — 50 videos / month' },
    prices: { USD: 500, RUB: 45000, KZT: 250000, CNY: 3600 },
  },
  studio: {
    id: 'studio',
    kind: 'subscription',
    tier: 'studio',
    title: { ru: 'Studio — безлимит', zh: 'Studio — 无限量', en: 'Studio — unlimited' },
    prices: { USD: 2000, RUB: 180000, KZT: 1000000, CNY: 14500 },
  },
  credits_10: {
    id: 'credits_10',
    kind: 'credits',
    credits: 10,
    title: { ru: '10 кредитов (10 видео)', zh: '10 点数（10 条视频）', en: '10 credits (10 videos)' },
    prices: { USD: 150, RUB: 13500, KZT: 75000, CNY: 1100 },
  },
  credits_50: {
    id: 'credits_50',
    kind: 'credits',
    credits: 50,
    title: { ru: '50 кредитов (50 видео)', zh: '50 点数（50 条视频）', en: '50 credits (50 videos)' },
    prices: { USD: 600, RUB: 54000, KZT: 300000, CNY: 4300 },
  },
};

function loadProducts(pricesJson) {
  const products = JSON.parse(JSON.stringify(DEFAULT_PRODUCTS));
  if (!pricesJson) return products;
  let overrides;
  try {
    overrides = JSON.parse(pricesJson);
  } catch {
    throw new Error('PRICES_JSON is not valid JSON.');
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('PRICES_JSON must be an object such as {"pro":{"RUB":49000}}.');
  }
  for (const [productId, prices] of Object.entries(overrides)) {
    if (!products[productId]) throw new Error(`PRICES_JSON: unknown product "${productId}".`);
    for (const [currency, amount] of Object.entries(prices || {})) {
      if (!CURRENCIES.includes(currency) || !Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error(`PRICES_JSON: invalid price for ${productId}/${currency}.`);
      }
      products[productId].prices[currency] = amount;
    }
  }
  return products;
}

// Effective tier at `now`: an expired subscription falls back to free.
function activeTier(user, now = Date.now()) {
  if (!user || user.tier === 'free' || !user.subscriptionExpiresAt) return 'free';
  return Date.parse(user.subscriptionExpiresAt) > now ? user.tier : 'free';
}

function tierLimit(tier, limits = {}) {
  if (tier === 'pro') return limits.proVideosPerPeriod ?? TIERS.pro.videosPerPeriod;
  if (tier === 'studio') return limits.studioVideosPerPeriod ?? null;
  return 0;
}

function publicProducts(products) {
  return Object.values(products).map((product) => ({
    id: product.id,
    kind: product.kind,
    tier: product.tier || null,
    credits: product.credits || null,
    title: product.title,
    prices: product.prices,
    periodDays: product.kind === 'subscription' ? PERIOD_MS / 86400000 : null,
  }));
}

module.exports = { CURRENCIES, PERIOD_MS, TIERS, DEFAULT_PRODUCTS, loadProducts, activeTier, tierLimit, publicProducts };

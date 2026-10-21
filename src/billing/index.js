'use strict';

// Billing service: checkout, verified payment webhooks, refunds, entitlements
// (subscription periods and credits) and per-generation usage accounting.

const crypto = require('node:crypto');
const { CURRENCIES, PERIOD_MS, TIERS, activeTier, tierLimit, publicProducts } = require('./plans.js');

class BillingError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.status = status;
    this.missing = extra.missing;
  }
}

function publicPayment(payment) {
  return {
    id: payment.id,
    provider: payment.provider,
    product: payment.product,
    amountMinor: payment.amountMinor,
    amount: (payment.amountMinor / 100).toFixed(2),
    currency: payment.currency,
    status: payment.status,
    createdAt: payment.createdAt,
    paidAt: payment.paidAt,
    refundedAt: payment.refundedAt,
  };
}

function createBilling({ db, products, yookassa = null, stripe = null, limits = {}, missingKeys = {}, logger = console, now = Date.now }) {
  const providers = [yookassa, stripe].filter(Boolean);
  const yooMissing = missingKeys.yookassa || [];
  const stripeMissing = missingKeys.stripe || [];
  const webhookMissing = missingKeys.stripeWebhook || [];

  function chooseProvider(currency, requested) {
    if (requested !== undefined && requested !== null) {
      const provider = providers.find((p) => p.name === requested);
      if (!provider) {
        const missing = requested === 'yookassa' ? yooMissing : requested === 'stripe' ? stripeMissing : [];
        throw new BillingError('payment_provider_unavailable', 'Этот способ оплаты не подключён.', 400, { missing });
      }
      if (!provider.currencies.includes(currency)) throw new BillingError('currency_not_supported', 'Валюта не поддерживается этим способом оплаты.');
      return provider;
    }
    // YooKassa first (RU/KZ cards, SBP, wallets), Stripe as the global fallback.
    const provider = providers.find((p) => p.currencies.includes(currency));
    if (!provider) {
      const missing = providers.length === 0 ? [...yooMissing, ...stripeMissing] : [];
      throw new BillingError(
        'payment_provider_unavailable',
        providers.length === 0 ? 'Оплата не настроена: нет ключей YooKassa или Stripe.' : 'Оплата в этой валюте пока не подключена.',
        503,
        { missing },
      );
    }
    return provider;
  }

  function usageSummary(user) {
    const tier = activeTier(user, now());
    const limit = tierLimit(tier, limits);
    return {
      tier,
      tierLabel: TIERS[tier].label,
      subscriptionExpiresAt: tier === 'free' ? null : user.subscriptionExpiresAt,
      credits: user.credits,
      periodStart: user.periodStart,
      periodEndsAt: new Date(Date.parse(user.periodStart) + PERIOD_MS).toISOString(),
      periodVideosUsed: user.periodVideosUsed,
      periodVideosLimit: limit,
      unlimited: tier === 'studio' && limit === null,
      canGenerate: (tier !== 'free' && (limit === null || user.periodVideosUsed < limit)) || user.credits > 0,
    };
  }

  async function addEvent(userId, kind, extra = {}) {
    await db.addUsageEvent({ id: crypto.randomUUID(), userId, kind, ...extra });
  }

  // Reserves one real generation. Subscription allowance is used first, then
  // credits. Returns the billing source or throws when nothing is left.
  async function consumeGeneration(user) {
    const t = now();
    const fresh = (await db.rollUsagePeriod(user.id, t, PERIOD_MS)) || user;
    const tier = activeTier(fresh, t);
    if (tier !== 'free' && (await db.incrementPeriodUsage(user.id, tierLimit(tier, limits)))) return 'subscription';
    if (await db.consumeCredits(user.id, 1)) return 'credits';
    if (tier === 'free') {
      throw new BillingError('upgrade_required', 'Тариф Free не включает генерацию видео. Оформите Pro/Studio или купите кредиты.', 402);
    }
    throw new BillingError('quota_exceeded', 'Лимит видео на этот период исчерпан. Купите кредиты или перейдите на Studio.', 402);
  }

  async function recordGeneration(userId, source, jobId) {
    await addEvent(userId, 'generation', { source, amount: 1, jobId });
  }

  // Returns a reserved generation after a failed job.
  async function refundGeneration(job) {
    if (job.billingSource === 'subscription') await db.decrementPeriodUsage(job.userId);
    else if (job.billingSource === 'credits') await db.addCredits(job.userId, 1);
    else return;
    await addEvent(job.userId, 'generation_refund', { source: job.billingSource, amount: 1, jobId: job.id });
  }

  async function checkout(user, { product: productId, currency, provider: requestedProvider, origin }) {
    const product = typeof productId === 'string' && Object.prototype.hasOwnProperty.call(products, productId) ? products[productId] : null;
    if (!product) throw new BillingError('unknown_product', 'Такого тарифа нет.');
    if (typeof currency !== 'string' || !CURRENCIES.includes(currency)) {
      throw new BillingError('currency_not_supported', `Валюта: ${CURRENCIES.join(', ')}.`);
    }
    const amountMinor = product.prices[currency];
    if (!amountMinor) throw new BillingError('currency_not_supported', 'Для этой валюты нет цены.');
    const provider = chooseProvider(currency, requestedProvider);
    const payment = await db.createPayment({
      id: crypto.randomUUID(),
      userId: user.id,
      provider: provider.name,
      product: product.id,
      amountMinor,
      currency,
      status: 'pending',
    });
    const returnUrl = `${origin}/studio#/dashboard?payment=${payment.id}`;
    let created;
    try {
      created = await provider.createPayment({
        paymentId: payment.id,
        userId: user.id,
        amountMinor,
        currency,
        description: `Rezhisser: ${product.title.en}`,
        returnUrl,
        cancelUrl: `${origin}/studio#/pricing?canceled=${payment.id}`,
      });
    } catch (error) {
      await db.transitionPayment(payment.id, ['pending'], 'canceled');
      logger.error(`checkout failed (${provider.name}): ${error.code || 'error'}`);
      throw new BillingError('payment_provider_error', 'Платёжный сервис недоступен, попробуйте позже.', 502);
    }
    const updated = await db.updatePayment(payment.id, {
      providerPaymentId: created.providerPaymentId,
      confirmationUrl: created.confirmationUrl,
    });
    return { payment: publicPayment(updated), confirmationUrl: created.confirmationUrl };
  }

  async function grant(payment) {
    const product = products[payment.product];
    if (!product) return;
    if (product.kind === 'credits') {
      await db.addCredits(payment.userId, product.credits);
      await addEvent(payment.userId, 'credits_purchase', { source: payment.provider, amount: product.credits, paymentId: payment.id });
      return;
    }
    const user = await db.getUserById(payment.userId);
    if (!user) return;
    const t = now();
    const current = activeTier(user, t);
    const sameTier = current === product.tier;
    const startFrom = sameTier ? Math.max(t, Date.parse(user.subscriptionExpiresAt)) : t;
    await db.setSubscription(user.id, {
      tier: product.tier,
      expiresAt: new Date(startFrom + PERIOD_MS).toISOString(),
      resetPeriodAt: sameTier ? null : new Date(t).toISOString(),
    });
    await addEvent(user.id, 'subscription', { source: product.tier, amount: 30, paymentId: payment.id });
  }

  async function revoke(payment) {
    const product = products[payment.product];
    if (!product) return;
    if (product.kind === 'credits') {
      await db.addCredits(payment.userId, -product.credits);
      await addEvent(payment.userId, 'credits_refund', { source: payment.provider, amount: -product.credits, paymentId: payment.id });
      return;
    }
    const user = await db.getUserById(payment.userId);
    if (!user || user.tier !== product.tier) return;
    const remaining = Date.parse(user.subscriptionExpiresAt) - PERIOD_MS;
    await db.setSubscription(user.id, {
      tier: remaining > now() ? user.tier : 'free',
      expiresAt: remaining > now() ? new Date(remaining).toISOString() : null,
    });
    await addEvent(user.id, 'subscription_refund', { source: product.tier, amount: -30, paymentId: payment.id });
  }

  function amountMatches(payment, minor, currency) {
    return minor === payment.amountMinor && String(currency || '').toUpperCase() === payment.currency;
  }

  async function markSucceeded(payment, patch = {}) {
    const updated = await db.transitionPayment(payment.id, ['pending', 'canceled'], 'succeeded', {
      ...patch,
      paidAt: new Date(now()).toISOString(),
    });
    if (updated) await grant(updated);
    return updated;
  }

  async function markRefunded(payment) {
    const updated = await db.transitionPayment(payment.id, ['succeeded'], 'refunded', { refundedAt: new Date(now()).toISOString() });
    if (updated) await revoke(updated);
    return updated;
  }

  async function handleYooKassaNotification(body) {
    if (!yookassa) throw new BillingError('payment_provider_unavailable', 'YooKassa is not configured.', 404, { missing: yooMissing });
    const event = body && typeof body.event === 'string' ? body.event : '';
    const objectId = body && body.object && typeof body.object.id === 'string' ? body.object.id : '';
    if (!event || !objectId) throw new BillingError('invalid_notification', 'Malformed notification.');

    if (event === 'refund.succeeded') {
      const refund = await yookassa.getRefund(objectId);
      if (!refund || refund.status !== 'succeeded') return { handled: false };
      const payment = await db.findPaymentByProviderId('yookassa', refund.paymentId);
      if (!payment) return { handled: false };
      // Partial refunds are recorded by the provider but do not revoke access.
      if (!refund.amount || refund.amount.minor < payment.amountMinor) return { handled: false };
      return { handled: Boolean(await markRefunded(payment)) };
    }
    if (event !== 'payment.succeeded' && event !== 'payment.canceled') return { handled: false };

    // Never trust the notification body: read the payment back from the API.
    const remote = await yookassa.getPayment(objectId);
    if (!remote) return { handled: false };
    const payment = await db.findPaymentByProviderId('yookassa', remote.id);
    if (!payment) return { handled: false };
    if (remote.status === 'succeeded' && remote.paid) {
      if (!remote.amount || !amountMatches(payment, remote.amount.minor, remote.amount.currency)) {
        logger.error(`yookassa amount mismatch for payment ${payment.id}`);
        return { handled: false };
      }
      return { handled: Boolean(await markSucceeded(payment)) };
    }
    if (remote.status === 'canceled') {
      return { handled: Boolean(await db.transitionPayment(payment.id, ['pending'], 'canceled')) };
    }
    return { handled: false };
  }

  async function handleStripeEvent(rawBody, signature) {
    if (!stripe || !stripe.webhookConfigured) {
      const missing = [...(!stripe ? stripeMissing : []), ...webhookMissing];
      throw new BillingError('payment_provider_unavailable', 'Stripe webhooks are not configured.', 404, { missing });
    }
    if (!stripe.verifyWebhook(rawBody, signature, Math.floor(now() / 1000))) {
      throw new BillingError('invalid_signature', 'Invalid Stripe signature.', 400);
    }
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new BillingError('invalid_notification', 'Malformed event.');
    }
    const object = event && event.data && event.data.object;
    if (!object || typeof object !== 'object') return { handled: false };

    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      const payment = await db.findPaymentByProviderId('stripe', object.id);
      if (!payment || object.payment_status !== 'paid') return { handled: false };
      if (!amountMatches(payment, object.amount_total, object.currency)) {
        logger.error(`stripe amount mismatch for payment ${payment.id}`);
        return { handled: false };
      }
      const reference = typeof object.payment_intent === 'string' ? object.payment_intent : null;
      return { handled: Boolean(await markSucceeded(payment, reference ? { providerReference: reference } : {})) };
    }
    if (['checkout.session.expired', 'checkout.session.async_payment_failed'].includes(event.type)) {
      const payment = await db.findPaymentByProviderId('stripe', object.id);
      if (!payment) return { handled: false };
      return { handled: Boolean(await db.transitionPayment(payment.id, ['pending'], 'canceled')) };
    }
    if (event.type === 'charge.refunded') {
      if (typeof object.payment_intent !== 'string' || object.refunded !== true) return { handled: false };
      const payment = await db.findPaymentByReference('stripe', object.payment_intent);
      if (!payment) return { handled: false };
      return { handled: Boolean(await markRefunded(payment)) };
    }
    return { handled: false };
  }

  async function history(user) {
    const [payments, usage] = await Promise.all([db.listPayments(user.id), db.listUsageEvents(user.id)]);
    return {
      payments: payments.map(publicPayment),
      usage: usage.map(({ id, kind, source, amount, jobId, paymentId, createdAt }) => ({ id, kind, source, amount, jobId, paymentId, createdAt })),
    };
  }

  return {
    providers: providers.map((p) => ({ name: p.name, currencies: p.currencies })),
    products: publicProducts(products),
    usageSummary,
    consumeGeneration,
    recordGeneration,
    refundGeneration,
    checkout,
    handleYooKassaNotification,
    handleStripeEvent,
    history,
  };
}

module.exports = { createBilling, BillingError, publicPayment };

'use strict';

// Which external services this process can call, and which env vars are still
// empty. Reports contain variable names only — never values.

function isSet(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function missing(entries) {
  return entries.filter((entry) => !isSet(entry[1])).map((entry) => entry[0]);
}

function entry(id, keysMissing) {
  return { id, configured: keysMissing.length === 0, missing: keysMissing };
}

// `config` is the object returned by loadConfig. A provider counts as
// configured only when every variable it needs is present.
function integrationReport(config) {
  const replicateOn = config.videoProvider === 'replicate';
  return {
    replicate: entry('replicate', missing([
      ['VIDEO_PROVIDER', replicateOn ? 'replicate' : ''],
      ['REPLICATE_API_TOKEN', config.replicate && config.replicate.apiToken],
    ])),
    seedance: entry('seedance', missing([
      ['SEEDANCE_API_KEY', config.seedance && config.seedance.apiKey],
      ['SEEDANCE_MODEL', config.seedance && config.seedance.model],
    ])),
    storage: entry('storage', missing([
      ['S3_ENDPOINT', config.s3 && config.s3.endpoint],
      ['S3_BUCKET', config.s3 && config.s3.bucket],
      ['S3_ACCESS_KEY_ID', config.s3 && config.s3.accessKeyId],
      ['S3_SECRET_ACCESS_KEY', config.s3 && config.s3.secretAccessKey],
    ])),
    yookassa: entry('yookassa', missing([
      ['YOOKASSA_SHOP_ID', config.yookassa && config.yookassa.shopId],
      ['YOOKASSA_SECRET_KEY', config.yookassa && config.yookassa.secretKey],
    ])),
    stripe: entry('stripe', missing([
      ['STRIPE_SECRET_KEY', config.stripe && config.stripe.secretKey],
    ])),
    stripeWebhook: entry('stripeWebhook', missing([
      ['STRIPE_WEBHOOK_SECRET', config.stripe && config.stripe.webhookSecret],
    ])),
    mail: entry('mail', missing([
      ['RESEND_API_KEY', config.mail && config.mail.resendApiKey],
      ['MAIL_FROM', config.mail && config.mail.from],
      ['PUBLIC_ORIGIN', config.publicOrigin],
    ])),
    automation: entry('automation', missing([
      ['OWL_BROWSER_URL', config.owlBrowser && config.owlBrowser.url],
      ['OWL_BROWSER_TOKEN', config.owlBrowser && config.owlBrowser.token],
    ])),
    database: entry('database', missing([
      ['DATABASE_URL', config.databaseUrl],
    ])),
    accounts: entry('accounts', missing([
      ['JWT_SECRET', config.jwtSecret],
    ])),
  };
}

module.exports = { integrationReport, isSet };

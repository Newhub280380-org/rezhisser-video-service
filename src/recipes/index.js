'use strict';

const { RecipeError } = require('./errors.js');
const { getLibrary, validateRecipe, loadRecipes, INTENT_TAGS } = require('./load.js');
const { createRouter } = require('./router.js');
const { createExecutor } = require('./executor.js');
const { createAdapters, TOOL_SPECS } = require('./adapters.js');
const { extractLastFrame } = require('./ffmpeg.js');

const ENGINE = 'recipe-director-v1';

function positiveMoney(value) {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 ? Math.min(number, 10000) : null;
}

function positiveInt(value) {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? Math.min(number, 100000) : null;
}

function resolveRunMode(server, input) {
  const serverAllowsLive = server.dryRun === false;
  const requestedLive = input.dryRun === false;
  let budgetUsd = positiveMoney(input.budgetUsd);
  let budgetCredits = positiveInt(input.budgetCredits);
  if (server.budgetUsd != null) budgetUsd = budgetUsd == null ? server.budgetUsd : Math.min(budgetUsd, server.budgetUsd);
  if (server.budgetCredits != null) {
    budgetCredits = budgetCredits == null ? server.budgetCredits : Math.min(budgetCredits, server.budgetCredits);
  }
  const hasBudget = budgetUsd != null || budgetCredits != null;
  if (requestedLive && serverAllowsLive && !hasBudget) {
    throw new RecipeError(
      'budget_required',
      'Живой запуск запрещён: задайте потолок на задачу (budgetUsd или budgetCredits, либо RECIPE_JOB_BUDGET_USD / RECIPE_JOB_BUDGET_CREDITS). Платный вызов не выполнен.',
      409,
    );
  }
  return {
    dryRun: !(requestedLive && serverAllowsLive && hasBudget),
    budgetUsd,
    budgetCredits,
    liveBlocked: requestedLive && !serverAllowsLive ? 'dry_run_default' : null,
  };
}

function createRecipeDirector(options = {}) {
  const library = options.library || getLibrary(options.dir);
  const adapters = options.adapters || createAdapters({ seedance: options.seedance || null });
  const server = {
    dryRun: options.dryRun !== false,
    budgetUsd: positiveMoney(options.budgetUsd),
    budgetCredits: positiveInt(options.budgetCredits),
  };
  const stepHoldUsd = positiveMoney(options.stepHoldUsd) || 1;
  const stepHoldCredits = positiveInt(options.stepHoldCredits) || 1;
  const router = createRouter(library.recipes);
  const executor = createExecutor({
    adapters,
    extractLastFrame: options.extractLastFrame === undefined ? extractLastFrame : options.extractLastFrame,
    stepHoldUsd,
    stepHoldCredits,
  });

  return {
    engine: ENGINE,
    size: library.size,
    get: (id) => library.get(id),
    route(input) {
      return router.route(input);
    },
    execute(recipe, input = {}) {
      const mode = resolveRunMode(server, input);
      return executor.execute(recipe, { ...input, ...mode });
    },
    async handle(input = {}) {
      const routed = router.route(input);
      const mode = resolveRunMode(server, input);
      const execution = await executor.execute(routed.chosen, {
        files: routed.files,
        dryRun: mode.dryRun,
        budgetUsd: mode.budgetUsd,
        budgetCredits: mode.budgetCredits,
      });
      return {
        engine: ENGINE,
        dryRun: execution.dryRun,
        liveCalls: execution.liveCalls,
        liveBlocked: mode.liveBlocked,
        librarySize: library.size,
        intents: routed.intents,
        missingInputs: routed.missingInputs,
        questions: routed.questions,
        needsInputs: routed.missingInputs.length > 0,
        reasoning: routed.reasoning,
        chosen: routed.chosenSummary,
        alternatives: routed.alternatives,
        execution,
      };
    },
  };
}

module.exports = {
  ENGINE,
  TOOL_SPECS,
  RecipeError,
  INTENT_TAGS,
  validateRecipe,
  loadRecipes,
  getLibrary,
  createRecipeDirector,
  createAdapters,
};

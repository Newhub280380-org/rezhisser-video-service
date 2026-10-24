'use strict';

const { substituteSlots } = require('./slots.js');

const POINTER = /^see prompts_verbatim\b/i;

function durationSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+)\s*(?:с|сек|s)\b/i);
  return match ? Number(match[1]) : null;
}

function aspectRatio(value) {
  if (typeof value !== 'string') return null;
  return /^\d{1,2}:\d{1,2}$/.test(value.trim()) ? value.trim() : null;
}

function rawPrompts(step, recipe) {
  if (Array.isArray(step.prompt)) return step.prompt.filter((item) => typeof item === 'string' && item.trim());
  if (typeof step.prompt === 'string' && POINTER.test(step.prompt.trim())) {
    return Array.isArray(recipe.prompts_verbatim) ? recipe.prompts_verbatim.filter((item) => typeof item === 'string') : [];
  }
  if (typeof step.prompt === 'string') return [step.prompt];
  return [];
}

function resolveInputSource(step, previous) {
  const declared = typeof step.input_source === 'string' ? step.input_source : 'unknown';
  if (declared !== 'unknown') return { source: declared, inferred: false };
  const action = step.action || '';
  if (/последн\w*\s+кадр|last frame|финальн\w*\s+кадр/i.test(action)) return { source: 'last_frame', inferred: true };
  if (previous && previous.inputSource === 'last_frame' && /^\s*то же(?:\s|$)/i.test(action)) return { source: 'last_frame', inferred: true };
  if (/предыдущ\w*\s+(шаг|результат|клип)|из шага/i.test(action)) return { source: 'previous_step_output', inferred: true };
  return { source: 'unknown', inferred: false };
}

function userInputs(files) {
  return files.map((file) => ({
    role: 'user_file',
    name: file.name,
    kind: file.kind || null,
    slot: file.slot || null,
    url: file.url || null,
  }));
}

function linkInputs(source, files, previous) {
  if (source === 'user_input') return userInputs(files);
  if (!previous) return [];
  if (source === 'previous_step_output') {
    return [{
      role: 'previous_output',
      fromStep: previous.n,
      ref: previous.outputRef,
      path: previous.localPath || null,
      url: previous.url || null,
    }];
  }
  if (source === 'last_frame') {
    return [{
      role: 'last_frame',
      fromStep: previous.n,
      ref: previous.lastFrameRef,
      path: null,
      url: null,
      extracted: false,
      note: 'Реальный последний кадр предыдущего шага, не исходный файл клиента.',
    }];
  }
  return [];
}

function primaryPrompt(prompts) {
  const known = prompts.find((item) => item.known);
  return known ? known.resolved : null;
}

function fits(budget, holdUsd, holdCredits) {
  if (budget.usd == null && budget.credits == null) return false;
  if (budget.usd != null && budget.remainingUsd + 1e-9 < holdUsd) return false;
  if (budget.credits != null && budget.remainingCredits < holdCredits) return false;
  return true;
}

function createExecutor({ adapters, extractLastFrame, stepHoldUsd = 1, stepHoldCredits = 1 }) {
  return {
    async execute(recipe, options = {}) {
      const files = Array.isArray(options.files) ? options.files : [];
      const dryRun = options.dryRun !== false;
      const budget = {
        usd: typeof options.budgetUsd === 'number' && options.budgetUsd > 0 ? options.budgetUsd : null,
        credits: Number.isInteger(options.budgetCredits) && options.budgetCredits > 0 ? options.budgetCredits : null,
        remainingUsd: typeof options.budgetUsd === 'number' && options.budgetUsd > 0 ? options.budgetUsd : null,
        remainingCredits: Number.isInteger(options.budgetCredits) && options.budgetCredits > 0 ? options.budgetCredits : null,
        spentUsd: 0,
        spentCredits: 0,
        stepHoldUsd,
        stepHoldCredits,
      };
      const holdUsd = budget.usd == null ? 0 : stepHoldUsd;
      const holdCredits = budget.credits == null ? 0 : stepHoldCredits;
      const steps = recipe.steps.slice().sort((a, b) => a.n - b.n);
      const planned = [];
      const produced = new Map();
      let stopPaid = false;
      let liveCalls = 0;

      for (const step of steps) {
        const previous = produced.get(step.n - 1) || null;
        const { source, inferred } = resolveInputSource(step, previous);
        const resolvedTool = adapters.resolve(step.tool, step.action);
        const adapter = resolvedTool.adapter;
        const prompts = rawPrompts(step, recipe).map((original) => {
          if (original === 'unknown') {
            return { original, resolved: original, replacements: [], known: false };
          }
          const replaced = substituteSlots(original, files);
          return { original, resolved: replaced.text, replacements: replaced.replacements, known: true };
        });
        const inputs = linkInputs(source, files, previous);
        const frameInput = inputs.find((item) => item.role === 'last_frame');
        let call = null;
        let failed = null;

        if (!dryRun && !stopPaid && frameInput && previous && previous.localPath && extractLastFrame) {
          try {
            const frame = await extractLastFrame(previous.localPath);
            frameInput.path = frame && frame.path ? frame.path : null;
            frameInput.extracted = Boolean(frameInput.path);
            frameInput.method = frame && frame.method ? frame.method : 'ffmpeg-last-frame';
          } catch (error) {
            failed = error;
            stopPaid = true;
          }
        }

        const context = {
          n: step.n,
          action: step.action,
          mode: typeof step.mode === 'string' ? step.mode : 'unknown',
          inputSource: source,
          inputs,
          prompts,
          primaryPrompt: primaryPrompt(prompts),
          duration: step.duration,
          durationSeconds: durationSeconds(step.duration),
          aspect: step.aspect,
          aspectRatio: aspectRatio(step.aspect),
          outputRef: `step:${step.n}`,
        };

        if (failed) {
          call = { status: 'failed', network: false, message: failed.message };
        } else if (stopPaid) {
          call = { status: 'skipped', network: false, reason: 'budget_exceeded' };
        } else if (dryRun || !adapter.configured) {
          call = adapter.preview(context);
          if (call) call.network = false;
        } else if (adapter.paid) {
          if (!fits(budget, holdUsd, holdCredits)) {
            call = { status: 'budget_exceeded', network: false, message: 'Шаг не помещается в потолок задачи. Платный вызов не выполнен.' };
            stopPaid = true;
          } else {
            if (budget.remainingUsd != null) {
              budget.remainingUsd = Math.round((budget.remainingUsd - holdUsd) * 10000) / 10000;
              budget.spentUsd = Math.round((budget.spentUsd + holdUsd) * 10000) / 10000;
            }
            if (budget.remainingCredits != null) {
              budget.remainingCredits -= holdCredits;
              budget.spentCredits += holdCredits;
            }
            try {
              call = await adapter.execute(context, { permit: true });
              if (call && call.network) liveCalls += 1;
            } catch (error) {
              call = { status: 'failed', network: false, message: String(error.message || 'call failed').slice(0, 300) };
              stopPaid = true;
            }
          }
        } else {
          try {
            call = await adapter.execute(context, { permit: true });
            if (call && call.network) liveCalls += 1;
          } catch (error) {
            call = { status: 'failed', network: false, message: String(error.message || 'call failed').slice(0, 300) };
            stopPaid = true;
          }
        }

        const outputRef = `step:${step.n}`;
        const lastFrameRef = `step:${step.n}:last_frame`;
        const localPath = call && typeof call.localPath === 'string' ? call.localPath : null;
        produced.set(step.n, {
          n: step.n,
          outputRef,
          lastFrameRef,
          localPath,
          url: call && typeof call.url === 'string' ? call.url : null,
          inputSource: source,
        });
        planned.push({
          n: step.n,
          action: step.action,
          tool: step.tool,
          adapter: adapter.name,
          adapterStub: Boolean(adapter.stub),
          toolInferred: resolvedTool.inferred,
          alsoMentioned: resolvedTool.mentioned,
          mode: context.mode,
          inputSource: source,
          inputSourceInferred: inferred,
          inputs,
          prompts,
          primaryPrompt: context.primaryPrompt,
          duration: step.duration,
          durationSeconds: context.durationSeconds,
          aspect: step.aspect,
          aspectRatio: context.aspectRatio,
          outputRef,
          lastFrameRef,
          outputKind: adapter.kind,
          call,
        });
      }

      return {
        recipeId: recipe.id,
        dryRun,
        liveCalls: liveCalls > 0,
        liveCallCount: liveCalls,
        budget: {
          usd: budget.usd,
          credits: budget.credits,
          spentUsd: budget.spentUsd,
          spentCredits: budget.spentCredits,
          remainingUsd: budget.remainingUsd,
          remainingCredits: budget.remainingCredits,
          stepHoldUsd,
          stepHoldCredits,
        },
        output: recipe.output,
        doneCriteria: recipe.done_criteria,
        steps: planned,
      };
    },
  };
}

module.exports = { createExecutor, substituteSlots };

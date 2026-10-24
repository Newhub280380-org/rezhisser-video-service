'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { directRequest, createRecipeDirector, RecipeError } = require('../src/director.js');
const { validateRecipe, getLibrary } = require('../src/recipes/load.js');
const { substituteSlots } = require('../src/recipes/slots.js');
const { extractLastFrame } = require('../src/recipes/ffmpeg.js');
const beta = require('./helpers/beta.js');

const SAMPLES = [
  {
    name: 'cosmetic filler ad',
    text: 'Сними рекламу косметического филлера для губ: UGC-ролик, девушка показывает средство',
    id: '195_ugc_selfie_cosmetics_russian_speech_seedance25',
    tags: ['beauty_ad', 'product_ad'],
  },
  {
    name: 'client in a music clip',
    text: 'Вставь клиента в музыкальный клип по его фото, вместо исполнителя',
    id: '212_put_yourself_in_music_video_genjutsu_motion_transfer_two_people_ffmpeg',
    tags: ['client_in_clip'],
  },
  {
    name: 'seamless series of one face',
    text: 'Собери бесшовную серию с одним и тем же лицом: каждый следующий ролик начинается с реального последнего кадра предыдущего',
    id: '179_image_to_video_long_take_3x10s_real_last_frame_stitch_rules_ilang',
    tags: ['seamless_series'],
  },
  {
    name: 'talking head',
    text: 'Нужна говорящая голова: человек говорит в камеру, липсинк',
    id: '159_talking_head_new_angles_seedream_seedance',
    tags: ['talking_head'],
  },
  {
    name: 'POV one take',
    text: 'Сними POV одним дублем, пролёт через локацию, one take',
    id: '211_pov_longboard_three_worlds_bg_sheets_seedance25_30s_one_take',
    tags: ['pov_one_take'],
  },
];

function slotPattern() {
  return /@(?:Image|Video|Audio)\s*\d+|\b(?:Image|Video|Audio)\s+\d+|\[(?:product|brand|photo|face|logo|audio|video|person|client)\]|<(?:Video|Picture|Image|Audio)\s*\d*>/gi;
}

function assertPromptUntouchedOutsideSlots(original, resolved, names) {
  const re = slotPattern();
  let index = 0;
  let last = 0;
  for (const match of original.matchAll(re)) {
    const prefix = original.slice(last, match.index);
    assert.equal(resolved.slice(index, index + prefix.length), prefix);
    index += prefix.length;
    const slot = match[0];
    if (resolved.startsWith(slot, index)) {
      index += slot.length;
    } else {
      const name = names.find((item) => resolved.startsWith(item, index));
      assert.ok(name, `slot ${slot} changed into ${resolved.slice(index, index + 40)}`);
      index += name.length;
    }
    last = match.index + slot.length;
  }
  assert.equal(resolved.slice(index), original.slice(last));
}

test('the recipe library loads and validates all 212 workflows', () => {
  const library = getLibrary();
  assert.equal(library.size, 212);
  const cosmetic = library.get('195_ugc_selfie_cosmetics_russian_speech_seedance25');
  assert.ok(cosmetic);
  assert.equal(cosmetic.prompt_completeness, 'complete');
  assert.ok(cosmetic.intent_tags.includes('beauty_ad'));
  assert.throws(() => validateRecipe({ id: 'nope' }, 'nope.yaml'), (error) => error instanceof RecipeError && error.code === 'invalid_recipe');
});

test('client assets replace only slots that already exist in the prompt', () => {
  const files = [
    { name: 'face.jpg', kind: 'фото лица/портрет человека', slot: null },
    { name: 'filler.png', kind: 'фото товара/продукта', slot: null },
  ];
  const original = 'Keep this. Use @Image1 and Image 2. Shot 1 (0:00–0:02) stays. [0:00] stays. The word Image stays.';
  const { text, replacements } = substituteSlots(original, files);
  assert.equal(text, 'Keep this. Use face.jpg and filler.png. Shot 1 (0:00–0:02) stays. [0:00] stays. The word Image stays.');
  assert.equal(replacements.length, 2);
  const unbound = substituteSlots('A @Image 2 B', [files[0]]);
  assert.equal(unbound.text, 'A @Image 2 B');
  const plain = 'Do not change [0:00–0:04] or the word Image.';
  assert.equal(substituteSlots(plain, files).text, plain);
});

test('the director picks a sensible recipe and a dry-run plan for sample requests', async () => {
  const originalFetch = global.fetch;
  let network = 0;
  global.fetch = async () => {
    network += 1;
    throw new Error('network');
  };
  try {
    for (const sample of SAMPLES) {
      const result = await directRequest({ text: sample.text, files: [] });
      assert.equal(result.engine, 'recipe-director-v1', sample.name);
      assert.equal(result.chosen.id, sample.id, `${sample.name}: ${result.reasoning}`);
      for (const tag of sample.tags) assert.ok(result.intents.includes(tag), sample.name);
      assert.equal(result.dryRun, true);
      assert.equal(result.liveCalls, false);
      assert.equal(result.execution.dryRun, true);
      assert.ok(result.execution.steps.length >= 1);
      assert.ok(result.reasoning.length > 20);
      for (const step of result.execution.steps) {
        assert.equal(step.call.network, false);
        for (const prompt of step.prompts) {
          if (!prompt.known || prompt.replacements.length === 0) {
            assert.equal(prompt.resolved, prompt.original);
          } else {
            assertPromptUntouchedOutsideSlots(prompt.original, prompt.resolved, []);
          }
        }
      }
    }
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(network, 0);
});

test('a cosmetic ad asks for the product photo and fills only @Image slots', async () => {
  const empty = await directRequest({
    text: SAMPLES[0].text,
    files: [],
  });
  assert.ok(empty.missingInputs.includes('фото товара/продукта'));
  assert.ok(empty.questions.some((line) => line.includes('фото товара/продукта')));

  const files = [
    { name: 'face.jpg', kind: 'face' },
    { name: 'filler.png', kind: 'product' },
  ];
  const result = await directRequest({ text: SAMPLES[0].text, files });
  assert.equal(result.chosen.id, SAMPLES[0].id);
  assert.ok(!result.missingInputs.includes('фото товара/продукта'));
  assert.ok(result.missingInputs.includes('аудио/голос'));
  const step = result.execution.steps.find((item) => item.adapter === 'Seedance');
  assert.ok(step);
  assert.equal(step.call.status, 'stub');
  const prompt = step.prompts[0];
  assert.ok(prompt.original.includes('@Image1'));
  assert.ok(prompt.resolved.includes('face.jpg'));
  assert.ok(prompt.resolved.includes('filler.png'));
  assert.ok(!prompt.resolved.includes('@Image1'));
  assert.ok(prompt.resolved.includes('REFERENCE LOCKS'));
  assertPromptUntouchedOutsideSlots(prompt.original, prompt.resolved, ['face.jpg', 'filler.png']);
  for (const extra of step.prompts.slice(1)) {
    if (extra.replacements.length === 0) assert.equal(extra.resolved, extra.original);
  }
});

test('a seamless series passes the real last frame, not the client still', async () => {
  let extracted = 0;
  const director = createRecipeDirector({
    extractLastFrame: async () => {
      extracted += 1;
      throw new Error('dry-run must not extract');
    },
  });
  const result = await director.handle({
    text: SAMPLES[2].text,
    files: [{ name: 'start.png', kind: 'start_frame' }],
  });
  assert.equal(result.chosen.id, SAMPLES[2].id);
  assert.equal(extracted, 0);
  const third = result.execution.steps.find((step) => step.n === 3);
  const fourth = result.execution.steps.find((step) => step.n === 4);
  assert.equal(third.inputSource, 'last_frame');
  assert.equal(third.inputs[0].ref, 'step:2:last_frame');
  assert.equal(third.inputs[0].extracted, false);
  assert.notEqual(third.inputs[0].ref, 'start.png');
  assert.equal(fourth.inputSource, 'last_frame');
  assert.equal(fourth.inputSourceInferred, true);
  assert.equal(fourth.inputs[0].fromStep, 3);
  assert.equal(fourth.inputs[0].ref, 'step:3:last_frame');
});

test('live mode is refused without a budget and never calls a stub', async () => {
  const director = createRecipeDirector({ dryRun: false, extractLastFrame: async () => null });
  await assert.rejects(
    () => director.handle({ text: SAMPLES[0].text, dryRun: false }),
    (error) => error instanceof RecipeError && error.code === 'budget_required',
  );
  const guarded = await directRequest({ text: SAMPLES[0].text, dryRun: false, budgetUsd: 25 });
  assert.equal(guarded.dryRun, true);
  assert.equal(guarded.liveBlocked, 'dry_run_default');
  assert.equal(guarded.liveCalls, false);
});

test('a budget cap gates Seedance submit, and the dry-run still previews the request', async () => {
  const calls = [];
  const seedance = {
    buildRequest(input) {
      calls.push('build');
      return { model: 'fake-seedance', content: [{ type: 'text', text: input.prompt }], duration: input.duration, ratio: input.aspect };
    },
    async submit(input) {
      calls.push(`submit:${input.prompt.slice(0, 12)}`);
      return 'task-1';
    },
  };
  const preview = createRecipeDirector({ seedance, extractLastFrame: null });
  const planned = await preview.handle({ text: SAMPLES[0].text, files: [{ name: 'filler.png', kind: 'product' }], dryRun: false, budgetUsd: 5 });
  assert.equal(planned.dryRun, true);
  assert.ok(calls.includes('build'));
  assert.equal(calls.some((item) => item.startsWith('submit')), false);

  calls.length = 0;
  const blocked = createRecipeDirector({ dryRun: false, seedance, stepHoldUsd: 1, extractLastFrame: null });
  const stopped = await blocked.handle({ text: SAMPLES[0].text, dryRun: false, budgetUsd: 0.4 });
  assert.equal(stopped.dryRun, false);
  assert.equal(stopped.liveCalls, false);
  assert.equal(calls.some((item) => item.startsWith('submit')), false);
  assert.ok(stopped.execution.steps.some((step) => step.call.status === 'budget_exceeded'));

  calls.length = 0;
  const live = createRecipeDirector({ dryRun: false, seedance, stepHoldUsd: 1, extractLastFrame: null });
  const ran = await live.handle({
    text: SAMPLES[0].text,
    dryRun: false,
    budgetUsd: 3,
    files: [
      { name: 'face.jpg', kind: 'face' },
      { name: 'filler.png', kind: 'product' },
    ],
  });
  assert.equal(ran.liveCalls, true);
  assert.equal(calls.filter((item) => item.startsWith('submit')).length, 1);
  assert.equal(ran.execution.budget.spentUsd, 1);
  const submitted = ran.execution.steps.find((step) => step.call.status === 'submitted');
  assert.equal(submitted.call.taskId, 'task-1');
  assert.ok(submitted.primaryPrompt.includes('face.jpg'));
  assert.equal(submitted.call.network, true);
});

test('live continuation feeds the extracted last frame into the next step', async () => {
  const extracted = [];
  const seen = [];
  const director = createRecipeDirector({
    dryRun: false,
    budgetUsd: 20,
    stepHoldUsd: 1,
    extractLastFrame: async (file) => {
      extracted.push(file);
      return { path: `${file}.png`, method: 'test-frame' };
    },
    adapters: {
      resolve(tool) {
        const name = Array.isArray(tool) ? tool[0] : tool || 'unknown';
        return {
          primary: String(name),
          mentioned: [],
          inferred: false,
          adapter: {
            name: String(name),
            paid: true,
            configured: true,
            stub: false,
            kind: 'video',
            preview() {
              return { status: 'dry_run', network: false };
            },
            async execute(step) {
              seen.push({ n: step.n, frame: (step.inputs.find((item) => item.role === 'last_frame') || {}).path || null });
              return { status: 'ok', network: false, localPath: `/tmp/step-${step.n}.mp4` };
            },
          },
        };
      },
    },
  });
  const recipe = director.get(SAMPLES[2].id);
  const execution = await director.execute(recipe, {
    dryRun: false,
    files: [{ name: 'start.png', kind: 'start_frame' }],
  });
  assert.equal(execution.dryRun, false);
  assert.deepEqual(extracted, ['/tmp/step-2.mp4', '/tmp/step-3.mp4']);
  const third = seen.find((item) => item.n === 3);
  const fourth = seen.find((item) => item.n === 4);
  assert.equal(third.frame, '/tmp/step-2.mp4.png');
  assert.equal(fourth.frame, '/tmp/step-3.mp4.png');
});

test('ffmpeg last-frame helper rejects a missing path and does not spawn', async () => {
  await assert.rejects(() => extractLastFrame(''), (error) => error instanceof RecipeError && error.code === 'invalid_video');
  await assert.rejects(() => extractLastFrame('   '), (error) => error.code === 'invalid_video');
});

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
  });
}

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('ffmpeg extracts a real PNG last frame from a local clip', { skip: ffmpegAvailable ? false : 'ffmpeg is not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rezhisser-frame-'));
  const video = path.join(dir, 'clip.mp4');
  try {
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=16x16:d=0.3', '-pix_fmt', 'yuv420p', video]);
    const frame = await extractLastFrame(video);
    const bytes = fs.readFileSync(frame.path);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(frame.source, video);
    fs.rmSync(frame.path, { force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/director/recipes dry-runs by default and ignores a client live flag', async () => {
  let network = 0;
  const fetchImpl = async () => {
    network += 1;
    throw new Error('network');
  };
  await beta.withServer({ fetchImpl }, async ({ base }) => {
    const browser = beta.client(base);
    const config = await browser.get('/api/config');
    assert.equal(config.json.director.recipes.count, 212);
    assert.equal(config.json.director.recipes.dryRun, true);
    assert.equal(config.json.director.recipes.liveCallsEnabled, false);

    const planned = await browser.post('/api/director/plan', { brief: beta.BRIEF });
    assert.equal(planned.status, 200);
    assert.ok(planned.json.plan.shots.length >= 2);
    assert.equal(planned.json.recipes, undefined);

    const body = {
      request: SAMPLES[4].text,
      files: [{ name: 'place.jpg', kind: 'location' }],
      dryRun: false,
      budgetUsd: 50,
    };
    const run = await browser.post('/api/director/recipes', body);
    assert.equal(run.status, 200);
    assert.equal(run.json.chosen.id, SAMPLES[4].id);
    assert.equal(run.json.dryRun, true);
    assert.equal(run.json.liveBlocked, 'dry_run_default');
    assert.equal(run.json.liveCalls, false);
    assert.ok(run.json.execution.steps.length >= 1);
    assert.equal(JSON.stringify(run.json).includes('SEEDANCE_API_KEY'), false);

    const viaPlan = await browser.post('/api/director/plan', { request: SAMPLES[1].text, files: [{ name: 'me.jpg', kind: 'face' }] });
    assert.equal(viaPlan.status, 200);
    assert.equal(viaPlan.json.plan, undefined);
    assert.equal(viaPlan.json.recipes.chosen.id, SAMPLES[1].id);

    const missing = await browser.post('/api/director/recipes', {});
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error, 'invalid_request');
  });
  assert.equal(network, 0);

  await beta.withServer({ fetchImpl, recipeDryRun: false }, async ({ base }) => {
    const browser = beta.client(base);
    const refused = await browser.post('/api/director/recipes', { request: SAMPLES[0].text, dryRun: false });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error, 'budget_required');
  });
  assert.equal(network, 0);
});

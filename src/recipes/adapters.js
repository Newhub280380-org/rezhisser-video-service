'use strict';

const { RecipeError } = require('./errors.js');

// Names from recipes/tools.md (29) plus FFmpeg, which the recipes use for
// stitching and last-frame extraction. Anything else becomes an unnamed stub.
const TOOL_SPECS = [
  ['Seedance', 'video'],
  ['Nano Banana', 'image'],
  ['Kling', 'video'],
  ['Veo', 'video'],
  ['MiniMax H3', 'video'],
  ['GPT Image', 'image'],
  ['ComfyUI', 'video'],
  ['Higgsfield', 'video'],
  ['CapCut', 'video'],
  ['Gemini', 'text'],
  ['Wan', 'video'],
  ['Seedream', 'image'],
  ['Flux', 'image'],
  ['Qwen', 'image'],
  ['ElevenLabs', 'audio'],
  ['Sora', 'video'],
  ['Magnific', 'image'],
  ['SAM3', 'image'],
  ['Grok Imagine', 'video'],
  ['Krea', 'image'],
  ['Midjourney', 'image'],
  ['Ideogram', 'image'],
  ['Hedra', 'video'],
  ['OmniHuman', 'video'],
  ['Topaz', 'video'],
  ['LTX', 'video'],
  ['Runway', 'video'],
  ['Suno', 'audio'],
  ['Vidu', 'video'],
  ['FFmpeg', 'video'],
  ['HeyGen', 'video'],
  ['Pika', 'video'],
  ['Luma', 'video'],
  ['PixVerse', 'video'],
  ['Freepik', 'image'],
  ['Photoshop', 'image'],
  ['Premiere/DaVinci', 'video'],
  ['Recraft', 'image'],
  ['Hunyuan', 'video'],
];

const LOCAL_FREE = new Set(['FFmpeg']);

function stubAdapter(name, kind) {
  const paid = !LOCAL_FREE.has(name);
  return {
    name,
    kind,
    paid,
    configured: false,
    stub: true,
    preview() {
      return {
        status: 'stub',
        configured: false,
        network: false,
        message: `${name}: адаптер-заглушка, внешний запрос не отправлялся.`,
      };
    },
    async execute() {
      throw new RecipeError('adapter_stub', `${name}: живой вызов не подключён.`);
    },
  };
}

function httpsUrl(value) {
  return typeof value === 'string' && /^https:\/\//i.test(value) ? value : null;
}

function imageUrlFromStep(step) {
  for (const input of step.inputs || []) {
    const url = httpsUrl(input && input.url);
    if (url) return url;
  }
  return null;
}

function createSeedanceAdapter(provider) {
  const configured = Boolean(provider && typeof provider.submit === 'function');
  return {
    name: 'Seedance',
    kind: 'video',
    paid: true,
    configured,
    stub: !configured,
    preview(step) {
      if (!provider || typeof provider.buildRequest !== 'function') {
        return stubAdapter('Seedance', 'video').preview();
      }
      return {
        status: 'dry_run',
        configured: true,
        network: false,
        request: provider.buildRequest({
          prompt: step.primaryPrompt || '',
          image: imageUrlFromStep(step),
          aspect: step.aspectRatio || undefined,
          duration: step.durationSeconds || undefined,
        }),
      };
    },
    async execute(step, ctx) {
      if (!configured) throw new RecipeError('adapter_stub', 'Seedance: провайдер не настроен.');
      if (!ctx || ctx.permit !== true) {
        throw new RecipeError('live_call_blocked', 'Seedance: вызов без явного потолка бюджета отклонён.');
      }
      const taskId = await provider.submit({
        prompt: step.primaryPrompt || '',
        image: imageUrlFromStep(step),
        aspect: step.aspectRatio || undefined,
        duration: step.durationSeconds || undefined,
      });
      return { status: 'submitted', taskId, network: true, localPath: null };
    },
  };
}

function createFfmpegAdapter() {
  return {
    name: 'FFmpeg',
    kind: 'video',
    paid: false,
    configured: true,
    stub: false,
    local: true,
    preview() {
      return {
        status: 'dry_run',
        configured: true,
        network: false,
        message: 'Локальный ffmpeg. Текст рецепта в оболочку не передаётся. Последний кадр снимается отдельным вызовом с фиксированными аргументами.',
      };
    },
    async execute() {
      return {
        status: 'planned',
        network: false,
        localPath: null,
        message: 'Шаг ffmpeg оставлен в плане. Произвольная команда из рецепта не запускалась.',
      };
    },
  };
}

function createAdapters({ seedance = null } = {}) {
  const byName = new Map();
  for (const [name, kind] of TOOL_SPECS) {
    if (name === 'Seedance') byName.set(name, createSeedanceAdapter(seedance));
    else if (name === 'FFmpeg') byName.set(name, createFfmpegAdapter());
    else byName.set(name, stubAdapter(name, kind));
  }
  const aliases = new Map();
  for (const name of byName.keys()) aliases.set(name.toLowerCase(), name);
  aliases.set('minimax', 'MiniMax H3');
  aliases.set('hailuo', 'MiniMax H3');
  aliases.set('comfy', 'ComfyUI');
  aliases.set('nano banana pro', 'Nano Banana');

  function canonical(name) {
    const key = String(name || '').trim().toLowerCase();
    return aliases.get(key) || null;
  }

  return {
    names: [...byName.keys()],
    get(name) {
      return byName.get(name) || null;
    },
    resolve(toolField, action) {
      const raw = Array.isArray(toolField)
        ? toolField
        : toolField && toolField !== 'unknown'
          ? [toolField]
          : [];
      const names = raw.map((item) => String(item));
      let primary = null;
      for (const item of names) {
        const known = canonical(item);
        if (known) {
          primary = known;
          break;
        }
      }
      let inferred = false;
      if (!primary && typeof action === 'string' && /\bffmpeg\b/i.test(action)) {
        primary = 'FFmpeg';
        inferred = true;
      }
      const adapter = (primary && byName.get(primary)) || stubAdapter(names[0] || 'unknown', 'unknown');
      return {
        primary: adapter.name,
        mentioned: names.filter((name) => canonical(name) !== adapter.name && name !== adapter.name),
        inferred,
        adapter,
      };
    },
  };
}

module.exports = { TOOL_SPECS, createAdapters, createSeedanceAdapter };

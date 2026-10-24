'use strict';

// Client assets are written into a verbatim prompt only where a slot already
// exists (Image 1, @Image1, @Video 2, [product], <Video 1>, ...). Every other
// character is copied from the original string.

const { IMAGE_KINDS, VIDEO_KINDS, AUDIO_KINDS } = require('./kinds.js');

const SLOT_SOURCE = '@(?:Image|Video|Audio)\\s*\\d+|\\b(?:Image|Video|Audio)\\s+\\d+|\\[(?:product|brand|photo|face|logo|audio|video|person|client)\\]|<(?:Video|Picture|Image|Audio)\\s*\\d*>';

function slotKind(slot) {
  const text = slot.toLowerCase().replace(/\s+/g, '');
  if (text.includes('audio')) return 'audio';
  if (text.startsWith('<video') || text.startsWith('@video') || text.startsWith('video')) return 'video';
  const bracket = text.match(/^\[([a-z]+)\]$/);
  if (bracket) {
    const name = bracket[1];
    if (name === 'video') return 'video';
    if (name === 'product' || name === 'brand' || name === 'logo') return 'product';
    if (name === 'face' || name === 'person' || name === 'client' || name === 'photo') return 'face';
  }
  return 'image';
}

function slotNumber(slot) {
  const match = slot.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function looksLikeImage(file) {
  return IMAGE_KINDS.has(file.kind) || (!file.kind && /\.(png|jpe?g|webp)$/i.test(file.name));
}

function poolFor(files, kind) {
  if (kind === 'video') return files.filter((file) => VIDEO_KINDS.has(file.kind) || (!file.kind && /\.(mp4|mov|webm)$/i.test(file.name)));
  if (kind === 'audio') return files.filter((file) => AUDIO_KINDS.has(file.kind) || (!file.kind && /\.(mp3|wav|m4a)$/i.test(file.name)));
  if (kind === 'product') return files.filter((file) => file.kind === 'фото товара/продукта' || file.kind === 'логотип');
  if (kind === 'face') return files.filter((file) => file.kind === 'фото лица/портрет человека' || file.kind === 'фото в полный рост');
  return files.filter(looksLikeImage);
}

function sameSlot(slot, fileSlot) {
  return String(fileSlot).replace(/\s+/g, '').toLowerCase() === String(slot).replace(/\s+/g, '').toLowerCase();
}

function assignSlot(slot, files) {
  const explicit = files.find((file) => file.slot && sameSlot(slot, file.slot));
  if (explicit) return explicit;
  const unreserved = poolFor(files, slotKind(slot)).filter((file) => !file.slot);
  const number = slotNumber(slot);
  if (number != null) return unreserved[number - 1] || null;
  return unreserved[0] || null;
}

function substituteSlots(prompt, files) {
  if (typeof prompt !== 'string') return { text: prompt, replacements: [] };
  const re = new RegExp(SLOT_SOURCE, 'gi');
  let out = '';
  let last = 0;
  const replacements = [];
  for (const match of prompt.matchAll(re)) {
    const slot = match[0];
    const asset = assignSlot(slot, files || []);
    out += prompt.slice(last, match.index);
    if (!asset) {
      out += slot;
    } else {
      out += asset.name;
      replacements.push({ slot, name: asset.name, index: match.index });
    }
    last = match.index + slot.length;
  }
  out += prompt.slice(last);
  return { text: out, replacements };
}

module.exports = { substituteSlots, assignSlot, SLOT_SOURCE };

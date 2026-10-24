'use strict';

// File kinds named by the recipe library (router.md, "Таблица по входным файлам").
const INPUT_KINDS = [
  'фото товара/продукта',
  'фото лица/портрет человека',
  'фото в полный рост',
  'видео-референс (движение/клип)',
  'стартовый кадр',
  'финальный кадр',
  'аудио/голос',
  'фото питомца',
  'старое фото',
  'логотип',
  'фото локации/города',
];

const IMAGE_KINDS = new Set([
  'фото товара/продукта',
  'фото лица/портрет человека',
  'фото в полный рост',
  'стартовый кадр',
  'финальный кадр',
  'фото питомца',
  'старое фото',
  'логотип',
  'фото локации/города',
]);

const VIDEO_KINDS = new Set(['видео-референс (движение/клип)']);
const AUDIO_KINDS = new Set(['аудио/голос']);

const ALIASES = {
  product: 'фото товара/продукта',
  product_photo: 'фото товара/продукта',
  товар: 'фото товара/продукта',
  face: 'фото лица/портрет человека',
  portrait: 'фото лица/портрет человека',
  selfie: 'фото лица/портрет человека',
  лицо: 'фото лица/портрет человека',
  full_body: 'фото в полный рост',
  fullbody: 'фото в полный рост',
  video: 'видео-референс (движение/клип)',
  reference_video: 'видео-референс (движение/клип)',
  clip: 'видео-референс (движение/клип)',
  start_frame: 'стартовый кадр',
  first_frame: 'стартовый кадр',
  end_frame: 'финальный кадр',
  last_frame: 'финальный кадр',
  audio: 'аудио/голос',
  voice: 'аудио/голос',
  pet: 'фото питомца',
  old_photo: 'старое фото',
  logo: 'логотип',
  location: 'фото локации/города',
};

for (const kind of INPUT_KINDS) ALIASES[kind] = kind;

function canonicalKind(value) {
  if (value == null || value === '') return '';
  const key = String(value).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ALIASES, key)) return ALIASES[key];
  if (INPUT_KINDS.includes(String(value).trim())) return String(value).trim();
  return null;
}

module.exports = {
  INPUT_KINDS,
  IMAGE_KINDS,
  VIDEO_KINDS,
  AUDIO_KINDS,
  canonicalKind,
};

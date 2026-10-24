'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { RecipeError } = require('./errors.js');

// Fixed argv only. Recipe text is never passed to a shell. This is not a
// service watchdog: one extraction, no restart.
function extractLastFrame(videoPath, { ffmpegBin = 'ffmpeg', timeoutMs = 20000 } = {}) {
  if (typeof videoPath !== 'string' || !videoPath.trim() || videoPath.includes('\0')) {
    return Promise.reject(new RecipeError('invalid_video', 'Чтобы снять последний кадр, нужен локальный путь к видео.'));
  }
  const out = path.join(os.tmpdir(), `rezhisser-frame-${crypto.randomBytes(8).toString('hex')}.png`);
  const args = ['-y', '-sseof', '-0.04', '-i', videoPath, '-frames:v', '1', out];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      reject(new RecipeError('ffmpeg_unavailable', 'ffmpeg недоступен, последний кадр не снят.'));
      return;
    }
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 500) stderr += chunk.toString();
    });
    child.on('error', () => {
      finish(new RecipeError('ffmpeg_unavailable', 'ffmpeg недоступен, последний кадр не снят.'));
    });
    child.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(out)) {
        finish(new RecipeError('ffmpeg_failed', 'ffmpeg не смог снять последний кадр.'));
        return;
      }
      finish(null, { path: out, kind: 'image', source: videoPath, method: 'ffmpeg-last-frame' });
    });
  });
}

module.exports = { extractLastFrame };

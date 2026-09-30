const fs = require('fs');
const path = require('path');

const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const RATE_LIMIT_WAIT_MS = 10000;

function scrubSecrets(text) {
  return String(text)
    .replace(/sutkn_[A-Za-z0-9._-]+/g, '[token]')
    .replace(/sk_[A-Za-z0-9._-]+/g, '[key]');
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function messageFromBody(raw, status) {
  if (!raw) return `ElevenLabs request failed with status ${status}`;
  try {
    const body = JSON.parse(raw);
    const detail = body.detail;
    if (typeof detail === 'string') return scrubSecrets(detail);
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const detailStatus = typeof detail.status === 'string' ? detail.status : '';
      const detailMessage = typeof detail.message === 'string' ? detail.message : '';
      if (detailStatus && detailMessage) return scrubSecrets(`${detailStatus}: ${detailMessage}`);
      if (detailMessage || detailStatus) return scrubSecrets(detailMessage || detailStatus);
    }
    if (Array.isArray(detail) && detail.length > 0) {
      const first = detail[0];
      const message = first && (first.msg || first.message);
      if (message) return scrubSecrets(message);
    }
    if (typeof body.message === 'string') return scrubSecrets(body.message);
    if (typeof body.error === 'string') return scrubSecrets(body.error);
  } catch (error) {
    return scrubSecrets(raw.slice(0, 500));
  }
  return `ElevenLabs request failed with status ${status}`;
}

function isAccountBlock(message) {
  return /detected_unusual_activity|free tier access has been disabled/i.test(message);
}

async function mintToken(tokenUrl) {
  let response;
  try {
    response = await fetch(tokenUrl, { method: 'POST' });
  } catch (error) {
    throw new Error('Could not reach the scribe token server');
  }

  if (!response.ok) {
    const message = messageFromBody(await response.text(), response.status);
    throw new Error(`Could not mint a scribe token (${response.status}): ${message}`);
  }

  const data = await response.json();
  if (!data || typeof data.token !== 'string' || data.token.length === 0) {
    throw new Error('Scribe token server did not return a token');
  }
  return data.token;
}

async function buildForm(audioPath) {
  const bytes = await fs.promises.readFile(audioPath);
  const ext = path.extname(audioPath).toLowerCase();
  const type = ext === '.wav' ? 'audio/wav' : 'audio/mpeg';
  const form = new FormData();
  form.append('model_id', 'scribe_v2');
  form.append('file', new Blob([bytes], { type }), path.basename(audioPath));
  form.append('language_code', 'en');
  form.append('diarize', 'false');
  form.append('tag_audio_events', 'false');
  form.append('timestamps_granularity', 'word');
  return form;
}

async function uploadAudio(audioPath, token) {
  const form = await buildForm(audioPath);
  const url = `${STT_URL}?token=${encodeURIComponent(token)}`;
  return fetch(url, { method: 'POST', body: form });
}

async function transcribeFile(audioPath, options) {
  const tokenUrl = options.tokenUrl;
  let authRetries = 1;
  let rateLimitRetries = 3;

  for (;;) {
    const token = await mintToken(tokenUrl);
    const response = await uploadAudio(audioPath, token);

    if (response.ok) {
      return response.json();
    }

    const raw = await response.text();
    const message = messageFromBody(raw, response.status);

    if ((response.status === 401 || response.status === 403) && authRetries > 0 && !isAccountBlock(message)) {
      authRetries -= 1;
      continue;
    }

    if (response.status === 429 && rateLimitRetries > 0) {
      rateLimitRetries -= 1;
      await sleep(RATE_LIMIT_WAIT_MS);
      continue;
    }

    throw new Error(`Speech-to-text failed (${response.status}): ${message}`);
  }
}

module.exports = {
  transcribeFile,
};

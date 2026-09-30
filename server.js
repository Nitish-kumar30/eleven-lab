require('dotenv').config();

const express = require('express');

const PORT = Number(process.env.PORT) || 3000;
const TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/batch_scribe';

const app = express();

function scrubSecrets(text) {
  return String(text)
    .replace(/sutkn_[A-Za-z0-9._-]+/g, '[token]')
    .replace(/sk_[A-Za-z0-9._-]+/g, '[key]');
}

function extractDetail(raw) {
  if (!raw) return '';
  try {
    const body = JSON.parse(raw);
    const detail = body.detail;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      return [detail.status, detail.message].filter((v) => typeof v === 'string' && v).join(': ');
    }
    if (Array.isArray(detail) && detail[0]) return detail[0].msg || detail[0].message || '';
    return body.message || body.error || '';
  } catch (error) {
    return raw.slice(0, 300);
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/scribe-token', async (_req, res) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ELEVENLABS_API_KEY is not set' });
    return;
  }

  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
    });
  } catch (error) {
    const reason = error && error.cause && error.cause.code ? error.cause.code : 'network error';
    console.error(`Failed to reach ElevenLabs token endpoint (${reason})`);
    res.status(502).json({ error: `Failed to reach ElevenLabs token endpoint (${reason}). Check your internet connection, VPN or proxy.` });
    return;
  }

  if (!response.ok) {
    // Pass ElevenLabs' own reason through (invalid key, missing permission,
    // free tier disabled, ...) so run.js can show it. Secrets are scrubbed.
    const raw = await response.text().catch(() => '');
    const detail = scrubSecrets(extractDetail(raw)) || `status ${response.status}`;
    console.error(`ElevenLabs token request failed (${response.status}): ${detail}`);
    res.status(502).json({
      error: `ElevenLabs refused the token request (${response.status}): ${detail}`,
      status: response.status,
    });
    return;
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    console.error('ElevenLabs token response was not JSON');
    res.status(502).json({ error: 'Token response was not JSON' });
    return;
  }

  if (!data || typeof data.token !== 'string' || data.token.length === 0) {
    console.error('ElevenLabs token response did not include a token');
    res.status(502).json({ error: 'Token response missing token' });
    return;
  }

  res.json({ token: data.token });
});

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Scribe token server listening on http://127.0.0.1:${PORT}`);
  });
}

module.exports = { app };

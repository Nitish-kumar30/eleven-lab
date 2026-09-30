require('dotenv').config();

const express = require('express');

const PORT = Number(process.env.PORT) || 3000;
const TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/batch_scribe';

const app = express();

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
    console.error('Failed to reach ElevenLabs token endpoint');
    res.status(502).json({ error: 'Failed to reach ElevenLabs token endpoint' });
    return;
  }

  if (!response.ok) {
    console.error(`ElevenLabs token request failed with status ${response.status}`);
    res.status(502).json({
      error: 'Failed to create scribe token',
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

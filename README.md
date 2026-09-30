# Local video transcription

Transcribe videos listed in `videos.json` with ElevenLabs Speech-to-Text (`scribe_v2`). The API key stays on the server. Each video gets a new single-use token immediately before upload. Transcripts are written under `./transcripts/` only. Nothing is saved back to a website.

Language is English (`language_code=en`). Speaker diarization and audio-event tags are off.

## Setup

Requires Node.js 18+ and `ffmpeg` / `ffprobe` on your PATH.

```bash
npm install
copy .env.example .env
```

Set `ELEVENLABS_API_KEY` in `.env`. Do not commit `.env`.

Edit `videos.json`. Each entry:

- `id` — used as the transcript filename
- `title` — shown in the report
- `source` — local video path, or an `https://` URL
- `page`, `indexOnPage`, `pageSize` — position in the report (`page N, video I of S`)
- `existingTranscript` — when this is non-empty, the video is flagged and skipped

Videos are processed from last to first. If `page` and `indexOnPage` are missing, the file order is reversed.

## Run

Start the token server:

```bash
node server.js
```

In another terminal, transcribe every video that still needs a transcript. Each video is extracted, transcribed, and marked before the next one starts:

```bash
node run.js
```

`run.js` starts the token server itself when it is not already listening. Pass `--limit 2` to stop after two videos. A finished video is recorded in `transcribed.json`, not by rewriting `videos.json`. A later run skips those ids.

Outputs:

- `transcripts/<video-id>.json` — full Speech-to-Text response, including word timestamps
- `transcripts/<video-id>.txt` — plain `text`

An existing `.json` or `.txt` for that id is not overwritten. Temporary audio files in `tmp/` are deleted after each video.

## Token server

`POST /api/scribe-token` reads `ELEVENLABS_API_KEY` from the environment and calls `POST https://api.elevenlabs.io/v1/single-use-token/batch_scribe`. The key is never written to logs. `GET /health` checks that the server is up without minting a token.

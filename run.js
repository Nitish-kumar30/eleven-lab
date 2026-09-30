require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { extractAudio, probeDurationSeconds } = require('./lib/extractAudio');
const { transcribeFile } = require('./lib/transcribe');
const { loadVideos, markTranscribed, positionLabel, transcriptPaths } = require('./lib/videos');

const ROOT = __dirname;
const MANIFEST_PATH = path.join(ROOT, 'videos.json');
const TRANSCRIPTS_DIR = path.join(ROOT, 'transcripts');
const TMP_DIR = path.join(ROOT, 'tmp');
const PORT = Number(process.env.PORT) || 3000;
const TOKEN_URL = `http://127.0.0.1:${PORT}/api/scribe-token`;
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;

function parseLimit(argv) {
  const index = argv.indexOf('--limit');
  if (index === -1) return null;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('--limit must be a positive integer');
  }
  return value;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${seconds.toFixed(1)}s (${minutes}:${String(remain).padStart(2, '0')})`;
}

function previewText(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= 300) return value;
  return `${value.slice(0, 300)}…`;
}

async function pathExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

async function isServerUp() {
  try {
    const response = await fetch(HEALTH_URL);
    return response.ok;
  } catch (error) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function ensureServer() {
  if (await isServerUp()) return null;

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: process.env,
    stdio: 'ignore',
    windowsHide: true,
  });
  let spawnError = null;
  child.on('error', (error) => {
    spawnError = error;
  });

  const stop = () => {
    if (!child.killed) child.kill();
  };
  process.on('exit', stop);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (spawnError) throw spawnError;
    if (child.exitCode != null) break;
    if (await isServerUp()) return child;
    await sleep(200);
  }

  stop();
  throw new Error(`Scribe token server did not become ready on port ${PORT}`);
}

function isHttpsUrl(source) {
  try {
    const url = new URL(source);
    return url.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

async function materializeSource(video, workDir) {
  if (!video.source) {
    throw new Error('Video source is empty');
  }

  if (isHttpsUrl(video.source)) {
    const dest = path.join(workDir, `${video.id}-source`);
    const response = await fetch(video.source);
    if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(dest, bytes);
    return { inputPath: dest, downloaded: true };
  }

  if (/^[a-z]+:/i.test(video.source) && !/^[a-z]:[\\/]/i.test(video.source)) {
    throw new Error('Remote sources must be https URLs');
  }

  const inputPath = path.resolve(ROOT, video.source);
  const stat = await fs.promises.stat(inputPath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`Video file not found: ${inputPath}`);
  }
  return { inputPath, downloaded: false };
}

async function removeFile(filePath) {
  if (!filePath) return;
  await fs.promises.rm(filePath, { force: true }).catch(() => {});
}

function printReport(result) {
  console.log('---');
  console.log(`Title: ${result.title}`);
  console.log(`ID: ${result.id}`);
  console.log(`Position: ${result.position}`);
  console.log(`Video length: ${result.duration}`);
  console.log(`Audio file size: ${result.audioSize}`);
  console.log(`Detected language: ${result.language}`);
  console.log(`Transcript preview: ${result.preview}`);
  console.log(`Saved on site: ${result.savedOnSite}`);
  console.log(`Saved locally: ${result.savedLocally}`);
  console.log(`Errors: ${result.error || 'none'}`);
}

async function processVideo(video) {
  const position = positionLabel(video);
  const base = {
    id: video.id,
    title: video.title,
    position,
    duration: 'unknown',
    audioSize: 'unknown',
    language: 'unknown',
    preview: '',
    savedOnSite: 'no (local files only; site write-back is not configured)',
    savedLocally: 'no',
    error: '',
  };

  if (video.skipReason) {
    const paths = transcriptPaths(video.id, TRANSCRIPTS_DIR);
    return {
      ...base,
      savedLocally: `skipped, transcript already exists (${video.skipReason}). json=${paths.jsonPath} txt=${paths.txtPath}`,
      preview: video.existingTranscript ? previewText(video.existingTranscript) : '',
    };
  }

  const workDir = path.join(TMP_DIR, video.id);
  let downloadedPath = '';
  let audioPath = '';
  const known = {};

  try {
    await fs.promises.mkdir(workDir, { recursive: true });
    const source = await materializeSource(video, workDir);
    if (source.downloaded) downloadedPath = source.inputPath;

    const probed = await probeDurationSeconds(source.inputPath);
    known.duration = formatDuration(probed);
    audioPath = path.join(workDir, `${video.id}.mp3`);
    await extractAudio(source.inputPath, audioPath);
    const audioStat = await fs.promises.stat(audioPath);
    known.audioSize = formatBytes(audioStat.size);

    const transcript = await transcribeFile(audioPath, { tokenUrl: TOKEN_URL });
    const text = typeof transcript.text === 'string' ? transcript.text : '';
    const durationSeconds = Number.isFinite(Number(transcript.audio_duration_secs))
      ? Number(transcript.audio_duration_secs)
      : probed;

    const paths = transcriptPaths(video.id, TRANSCRIPTS_DIR);
    if (await pathExists(paths.jsonPath) || await pathExists(paths.txtPath)) {
      return {
        ...base,
        duration: formatDuration(durationSeconds),
        audioSize: formatBytes(audioStat.size),
        language: transcript.language_code || 'unknown',
        preview: previewText(text),
        savedLocally: 'skipped, transcript already exists (transcript files appeared before save)',
      };
    }

    await fs.promises.mkdir(TRANSCRIPTS_DIR, { recursive: true });
    await fs.promises.writeFile(paths.jsonPath, `${JSON.stringify(transcript, null, 2)}\n`, 'utf8');
    await fs.promises.writeFile(paths.txtPath, text, 'utf8');
    await markTranscribed(MANIFEST_PATH, video.id);

    return {
      ...base,
      duration: formatDuration(durationSeconds),
      audioSize: formatBytes(audioStat.size),
      language: transcript.language_code || 'unknown',
      preview: previewText(text),
      savedLocally: `${paths.txtPath} and ${paths.jsonPath}`,
    };
  } catch (error) {
    return {
      ...base,
      ...known,
      error: error && error.message ? error.message : String(error),
    };
  } finally {
    await removeFile(audioPath);
    await removeFile(downloadedPath);
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const limit = parseLimit(process.argv.slice(2));

  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('Stopped: ELEVENLABS_API_KEY is not set. Copy .env.example to .env and set the key.');
    process.exitCode = 1;
    return;
  }

  if (!await pathExists(MANIFEST_PATH)) {
    console.error('Stopped: videos.json was not found.');
    process.exitCode = 1;
    return;
  }

  const videos = loadVideos(MANIFEST_PATH, TRANSCRIPTS_DIR);
  const withSources = videos.filter((video) => video.source);
  if (withSources.length === 0) {
    console.error('Stopped: videos.json has no sources. Add a local path or https URL for each video.');
    process.exitCode = 1;
    return;
  }

  // --limit counts only videos that still need a transcript, so re-running
  // moves on to the next ones instead of re-reporting finished videos.
  const pending = videos.filter((video) => !video.skipReason);
  const alreadyDone = videos.length - pending.length;
  const selected = limit == null ? pending : pending.slice(0, limit);
  if (alreadyDone > 0) {
    console.log(`Skipping ${alreadyDone} video(s) that already have a transcript.`);
  }
  if (selected.length === 0) {
    console.log('Nothing left to transcribe.');
    return;
  }
  const scope = limit == null ? 'no limit' : `limit ${limit}`;
  console.log(`Processing ${selected.length} of ${pending.length} remaining video(s), one at a time, last to first (${scope}).`);

  const server = await ensureServer();
  const results = [];
  try {
    for (const video of selected) {
      console.log(`Starting ${video.title} (${video.id})`);
      const result = await processVideo(video);
      results.push(result);
      printReport(result);
    }
  } finally {
    if (server && !server.killed) server.kill();
  }

  const failed = results.filter((result) => result.error).length;
  const remaining = pending.length - selected.length;
  console.log('---');
  console.log(`Finished ${results.length} video(s). Failed: ${failed}. Still remaining: ${remaining}.`);
  if (remaining > 0) console.log('Stopped after the limit. Run again to continue with the next videos.');
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});

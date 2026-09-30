const fs = require('fs');
const path = require('path');

function safeVideoId(id) {
  const value = String(id == null ? '' : id).trim();
  if (!value || value === '.' || value === '..') {
    throw new Error('Video id is missing');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`Video id "${value}" may only contain letters, numbers, dots, underscores, and hyphens`);
  }
  return value;
}

function transcriptPaths(id, transcriptsDir) {
  const safeId = safeVideoId(id);
  return {
    jsonPath: path.join(transcriptsDir, `${safeId}.json`),
    txtPath: path.join(transcriptsDir, `${safeId}.txt`),
  };
}

function localTranscriptExists(video, transcriptsDir) {
  const paths = transcriptPaths(video.id, transcriptsDir);
  return fs.existsSync(paths.jsonPath) || fs.existsSync(paths.txtPath);
}

function orderLastToFirst(videos) {
  const pageReady = videos.length > 0 && videos.every((video) => {
    return Number.isFinite(Number(video.page)) && Number.isFinite(Number(video.indexOnPage));
  });

  if (!pageReady) return videos.slice().reverse();

  return videos.slice().sort((a, b) => {
    const pageDiff = Number(b.page) - Number(a.page);
    if (pageDiff !== 0) return pageDiff;
    return Number(b.indexOnPage) - Number(a.indexOnPage);
  });
}

function transcribedStatusPath(manifestPath) {
  return path.join(path.dirname(manifestPath), 'transcribed.json');
}

function readTranscribedStatus(manifestPath) {
  const file = transcribedStatusPath(manifestPath);
  if (!fs.existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`transcribed.json could not be read: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('transcribed.json must be an object');
  }
  return parsed;
}

function loadVideos(manifestPath, transcriptsDir) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path.basename(manifestPath)} must be an array`);
  }

  const status = readTranscribedStatus(manifestPath);
  const seen = new Set();
  const videos = parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`${path.basename(manifestPath)} entry ${index + 1} is not an object`);
    }
    const id = safeVideoId(entry.id);
    if (seen.has(id)) throw new Error(`Duplicate video id "${id}"`);
    seen.add(id);

    const source = typeof entry.source === 'string' ? entry.source.trim() : '';
    const existingTranscript = typeof entry.existingTranscript === 'string'
      ? entry.existingTranscript.trim()
      : '';

    return {
      id,
      title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : id,
      source,
      page: entry.page,
      indexOnPage: entry.indexOnPage,
      pageSize: entry.pageSize,
      existingTranscript,
      transcribed: entry.transcribed === true || status[id] === true,
      context: typeof entry.context === 'string' ? entry.context.trim() : '',
    };
  });

  return orderLastToFirst(videos).map((video) => {
    let skipReason = '';
    if (video.transcribed) {
      skipReason = 'marked transcribed';
    } else if (video.existingTranscript) {
      skipReason = 'existing transcript on the video record';
    } else if (localTranscriptExists(video, transcriptsDir)) {
      skipReason = 'transcript files already exist';
    }
    return { ...video, skipReason };
  });
}

async function markTranscribed(manifestPath, id) {
  const safeId = safeVideoId(id);
  const manifestRaw = await fs.promises.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);
  if (!Array.isArray(manifest)) {
    throw new Error(`${path.basename(manifestPath)} must be an array`);
  }
  const entry = manifest.find((item) => item && String(item.id).trim() === safeId);
  if (!entry) {
    throw new Error(`${path.basename(manifestPath)} has no entry for "${safeId}"`);
  }

  const file = transcribedStatusPath(manifestPath);
  let status = {};
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('transcribed.json must be an object');
    }
    status = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  status[safeId] = true;
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  await fs.promises.rm(file, { force: true });
  await fs.promises.rename(tmp, file);
}

function positionLabel(video) {
  const page = Number.isFinite(Number(video.page)) ? Number(video.page) : '?';
  const indexOnPage = Number.isFinite(Number(video.indexOnPage)) ? Number(video.indexOnPage) : '?';
  const pageSize = Number.isFinite(Number(video.pageSize)) ? Number(video.pageSize) : '?';
  return `page ${page}, video ${indexOnPage} of ${pageSize}`;
}

module.exports = {
  loadVideos,
  markTranscribed,
  positionLabel,
  safeVideoId,
  transcriptPaths,
};

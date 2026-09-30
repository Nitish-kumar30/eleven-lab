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

function loadVideos(manifestPath, transcriptsDir) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('videos.json must be an array');
  }

  const seen = new Set();
  const videos = parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`videos.json entry ${index + 1} is not an object`);
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
    };
  });

  return orderLastToFirst(videos).map((video) => {
    let skipReason = '';
    if (video.existingTranscript) {
      skipReason = 'existing transcript on the video record';
    } else if (localTranscriptExists(video, transcriptsDir)) {
      skipReason = 'transcript files already exist';
    }
    return { ...video, skipReason };
  });
}

function positionLabel(video) {
  const page = Number.isFinite(Number(video.page)) ? Number(video.page) : '?';
  const indexOnPage = Number.isFinite(Number(video.indexOnPage)) ? Number(video.indexOnPage) : '?';
  const pageSize = Number.isFinite(Number(video.pageSize)) ? Number(video.pageSize) : '?';
  return `page ${page}, video ${indexOnPage} of ${pageSize}`;
}

module.exports = {
  loadVideos,
  positionLabel,
  safeVideoId,
  transcriptPaths,
};

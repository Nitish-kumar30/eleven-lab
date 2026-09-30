const { spawn } = require('child_process');

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new Error(`${command} is not installed or not on PATH`));
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const tail = stderr.trim().slice(-500);
      reject(new Error(`${command} exited with code ${code}${tail ? `: ${tail}` : ''}`));
    });
  });
}

async function extractAudio(inputPath, outputPath) {
  await runProcess('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-b:a',
    '64k',
    outputPath,
  ]);
  return outputPath;
}

async function probeDurationSeconds(inputPath) {
  try {
    const { stdout } = await runProcess('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ]);
    const value = Number(String(stdout).trim());
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
  } catch (error) {
    return null;
  }
}

function mixToMono(audioBuffer) {
  const length = audioBuffer.length;
  const channels = audioBuffer.numberOfChannels;
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += audioBuffer.getChannelData(channel)[i];
    }
    mono[i] = sum / channels;
  }
  return { samples: mono, sampleRate: audioBuffer.sampleRate };
}

function resample(samples, sourceRate, targetRate) {
  if (sourceRate === targetRate) return samples;
  const outLength = Math.max(1, Math.round((samples.length * targetRate) / sourceRate));
  const out = new Float32Array(outLength);
  const last = samples.length - 1;
  for (let i = 0; i < outLength; i += 1) {
    const position = (i * sourceRate) / targetRate;
    const left = Math.floor(position);
    const right = Math.min(left + 1, last);
    const weight = position - left;
    out[i] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return out;
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, value) {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

async function extractAudioInBrowser(file) {
  const AudioCtx = typeof AudioContext !== 'undefined' ? AudioContext : null;
  if (!AudioCtx) {
    throw new Error('extractAudioInBrowser only runs in a browser');
  }

  const audioContext = new AudioCtx({ sampleRate: 16000 });
  try {
    const decoded = await audioContext.decodeAudioData(await file.arrayBuffer());
    const mixed = mixToMono(decoded);
    const samples = resample(mixed.samples, mixed.sampleRate, 16000);
    const wav = encodeWav(samples, 16000);
    return new Blob([wav], { type: 'audio/wav' });
  } finally {
    if (typeof audioContext.close === 'function') {
      await audioContext.close();
    }
  }
}

module.exports = {
  extractAudio,
  probeDurationSeconds,
  extractAudioInBrowser,
  encodeWav,
};

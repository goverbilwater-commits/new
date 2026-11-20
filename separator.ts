import ffmpegStatic from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as ort from 'onnxruntime-node';

const execFileAsync = promisify(execFile);

const MODEL_FILENAME = 'UVR-MDX-NET-Inst_HQ_3.onnx';
const MODEL_URL =
  'https://huggingface.co/seanghay/uvr_models/resolve/main/UVR-MDX-NET-Inst_HQ_3.onnx';

const SAMPLE_RATE = 44100;
const N_FFT = 6144;
const HOP_LENGTH = 1024;
const DIM_F = 3072; // first 3072 bins out of N_FFT/2 + 1 = 3073
const DIM_T = 256;
const HALF_FFT = N_FFT / 2; // 3072
const CHUNK_SAMPLES = (DIM_T - 1) * HOP_LENGTH; // 255 * 1024 = 261,120 (~5.92s)
const OVERLAP_SAMPLES = 32768; // ~0.74s raised-cosine crossfade between chunks
const STEP_SAMPLES = CHUNK_SAMPLES - OVERLAP_SAMPLES; // 228,352 (~5.18s net/chunk)
const INNER_M = 2048; // N_FFT = 3 * 2048

const HANN_WINDOW = new Float32Array(N_FFT);
for (let i = 0; i < N_FFT; i++) {
  HANN_WINDOW[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N_FFT));
}

const BIT_REV_2048 = new Uint16Array(INNER_M);
for (let i = 0; i < INNER_M; i++) {
  let x = i;
  let rev = 0;
  for (let b = 0; b < 11; b++) {
    rev = (rev << 1) | (x & 1);
    x >>= 1;
  }
  BIT_REV_2048[i] = rev;
}

const COS_2048 = new Float64Array(INNER_M / 2);
const SIN_2048 = new Float64Array(INNER_M / 2);
for (let i = 0; i < INNER_M / 2; i++) {
  const angle = (-2 * Math.PI * i) / INNER_M;
  COS_2048[i] = Math.cos(angle);
  SIN_2048[i] = Math.sin(angle);
}

const COS_NFFT = new Float64Array(N_FFT);
const SIN_NFFT = new Float64Array(N_FFT);
for (let i = 0; i < N_FFT; i++) {
  const angle = (-2 * Math.PI * i) / N_FFT;
  COS_NFFT[i] = Math.cos(angle);
  SIN_NFFT[i] = Math.sin(angle);
}

class Fft6144Scratch {
  x0Re = new Float64Array(INNER_M);
  x0Im = new Float64Array(INNER_M);
  x1Re = new Float64Array(INNER_M);
  x1Im = new Float64Array(INNER_M);
  x2Re = new Float64Array(INNER_M);
  x2Im = new Float64Array(INNER_M);
  outRe = new Float64Array(N_FFT);
  outIm = new Float64Array(N_FFT);
  inRe = new Float64Array(N_FFT);
  inIm = new Float64Array(N_FFT);
  accum = new Float64Array(CHUNK_SAMPLES + N_FFT);
  winSq = new Float64Array(CHUNK_SAMPLES + N_FFT);
  outChunk = new Float32Array(CHUNK_SAMPLES);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fft2048InPlace(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < INNER_M; i++) {
    const j = BIT_REV_2048[i];
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let size = 2; size <= INNER_M; size <<= 1) {
    const half = size >> 1;
    const step = INNER_M / size;
    for (let start = 0; start < INNER_M; start += size) {
      for (let k = 0; k < half; k++) {
        const idx = k * step;
        const wr = COS_2048[idx];
        const wi = SIN_2048[idx];
        const even = start + k;
        const odd = even + half;
        const tr = wr * re[odd] - wi * im[odd];
        const ti = wr * im[odd] + wi * re[odd];
        re[odd] = re[even] - tr;
        im[odd] = im[even] - ti;
        re[even] += tr;
        im[even] += ti;
      }
    }
  }
}

function fft6144Forward(
  inRe: Float64Array,
  inIm: Float64Array,
  scratch: Fft6144Scratch
): void {
  const { x0Re, x0Im, x1Re, x1Im, x2Re, x2Im, outRe, outIm } = scratch;

  for (let m = 0; m < INNER_M; m++) {
    const base = m * 3;
    x0Re[m] = inRe[base];
    x0Im[m] = inIm[base];
    x1Re[m] = inRe[base + 1];
    x1Im[m] = inIm[base + 1];
    x2Re[m] = inRe[base + 2];
    x2Im[m] = inIm[base + 2];
  }

  fft2048InPlace(x0Re, x0Im);
  fft2048InPlace(x1Re, x1Im);
  fft2048InPlace(x2Re, x2Im);

  for (let r = 0; r < 3; r++) {
    const offset = r * INNER_M;
    for (let k = 0; k < INNER_M; k++) {
      const p1 = offset + k;
      const p2 = (2 * p1) % N_FFT;
      const w1r = COS_NFFT[p1];
      const w1i = SIN_NFFT[p1];
      const w2r = COS_NFFT[p2];
      const w2i = SIN_NFFT[p2];

      const t1r = w1r * x1Re[k] - w1i * x1Im[k];
      const t1i = w1r * x1Im[k] + w1i * x1Re[k];
      const t2r = w2r * x2Re[k] - w2i * x2Im[k];
      const t2i = w2r * x2Im[k] + w2i * x2Re[k];

      outRe[p1] = x0Re[k] + t1r + t2r;
      outIm[p1] = x0Im[k] + t1i + t2i;
    }
  }
}

async function stftChunkChannelSeparated(
  chunk: Float32Array,
  target: Float32Array,
  realOffset: number,
  imagOffset: number,
  scratch: Fft6144Scratch
): Promise<void> {
  const { inRe, inIm } = scratch;

  for (let t = 0; t < DIM_T; t++) {
    const startSample = t * HOP_LENGTH - HALF_FFT;

    for (let n = 0; n < N_FFT; n++) {
      const idx = startSample + n;
      const sample = idx >= 0 && idx < CHUNK_SAMPLES ? chunk[idx] : 0;
      inRe[n] = sample * HANN_WINDOW[n];
      inIm[n] = 0;
    }

    fft6144Forward(inRe, inIm, scratch);

    for (let f = 0; f < DIM_F; f++) {
      const offset = f * DIM_T + t;
      target[realOffset + offset] = scratch.outRe[f];
      target[imagOffset + offset] = scratch.outIm[f];
    }

    if ((t & 63) === 63) {
      await yieldToEventLoop();
    }
  }
}

async function istftChunkChannelSeparated(
  source: Float32Array,
  realOffset: number,
  imagOffset: number,
  scratch: Fft6144Scratch
): Promise<Float32Array> {
  const { inRe, inIm, accum, winSq, outChunk } = scratch;
  accum.fill(0);
  winSq.fill(0);

  for (let t = 0; t < DIM_T; t++) {
    inRe[0] = source[realOffset + t];
    inIm[0] = -source[imagOffset + t];
    inRe[HALF_FFT] = 0;
    inIm[HALF_FFT] = 0;

    for (let f = 1; f < DIM_F; f++) {
      const offset = f * DIM_T + t;
      const r = source[realOffset + offset];
      const im = source[imagOffset + offset];
      inRe[f] = r;
      inIm[f] = -im;
      inRe[N_FFT - f] = r;
      inIm[N_FFT - f] = im;
    }

    fft6144Forward(inRe, inIm, scratch);

    const frameStart = t * HOP_LENGTH;
    for (let n = 0; n < N_FFT; n++) {
      const timeVal = scratch.outRe[n] / N_FFT;
      const w = HANN_WINDOW[n];
      accum[frameStart + n] += timeVal * w;
      winSq[frameStart + n] += w * w;
    }

    if ((t & 63) === 63) {
      await yieldToEventLoop();
    }
  }

  for (let i = 0; i < CHUNK_SAMPLES; i++) {
    const pIdx = i + HALF_FFT;
    const denom = winSq[pIdx];
    outChunk[i] = denom > 1e-8 ? accum[pIdx] / denom : 0;
  }
  return outChunk;
}

let modelDownloadPromise: Promise<string> | null = null;

async function ensureModelDownloaded(
  modelsDir: string,
  onProgress?: (fraction: number, message: string) => void
): Promise<string> {
  const modelPath = path.join(modelsDir, MODEL_FILENAME);
  try {
    const stat = await fsp.stat(modelPath);
    if (stat.size > 50 * 1024 * 1024) {
      return modelPath;
    }
  } catch {
    // Model not cached yet
  }

  if (modelDownloadPromise) {
    return modelDownloadPromise;
  }

  modelDownloadPromise = (async () => {
    await fsp.mkdir(modelsDir, { recursive: true });
    const tempPath = `${modelPath}.downloading`;
    const response = await fetch(MODEL_URL);
    if (!response.ok || !response.body) {
      throw new Error(
        `Failed to download vocal isolation model (${response.status}).`
      );
    }

    const totalBytes = Number(response.headers.get('content-length')) || 67_000_000;
    const fileHandle = await fsp.open(tempPath, 'w');
    const reader = response.body.getReader();
    let downloaded = 0;
    let lastReportPct = -1;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          await fileHandle.write(value);
          downloaded += value.byteLength;
          const pct = Math.min(99, Math.round((downloaded / totalBytes) * 100));
          if (pct - lastReportPct >= 10) {
            lastReportPct = pct;
            onProgress?.(
              0.02 + (pct / 100) * 0.1,
              `Downloading neural vocal-removal model (${pct}%)...`
            );
          }
        }
      }
    } finally {
      await fileHandle.close();
    }

    await fsp.rename(tempPath, modelPath);
    return modelPath;
  })();

  try {
    return await modelDownloadPromise;
  } finally {
    modelDownloadPromise = null;
  }
}

/**
 * Extracts pure background accompaniment (music + sound effects) with English spoken vocals
 * stripped via UVR-MDX-NET-Inst_HQ_3.onnx using low-memory ONNX Runtime settings and
 * explicit tensor + session disposal so container memory stays bounded.
 */
export async function isolateAccompanimentWithMdxNet(params: {
  videoPath: string;
  outputWavPath: string;
  workDir: string;
  modelsDir: string;
  onProgress?: (fraction: number, message: string) => void;
}): Promise<void> {
  if (!ffmpegStatic) {
    throw new Error('FFmpeg binary is unavailable.');
  }

  const { videoPath, outputWavPath, workDir, modelsDir, onProgress } = params;
  const rawPcmPath = path.join(workDir, 'src_44k_stereo.f32');

  onProgress?.(0.02, 'Preparing neural vocal-removal model (UVR MDX-Net)...');
  const modelPath = await ensureModelDownloaded(modelsDir, onProgress);

  onProgress?.(0.14, 'Extracting 44.1kHz stereo audio for vocal separation...');
  await execFileAsync(
    ffmpegStatic,
    [
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '2',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      'f32le',
      rawPcmPath,
    ],
    { maxBuffer: 10 * 1024 * 1024 }
  );

  let session: ort.InferenceSession | null = null;

  try {
    const rawBytes = await fsp.readFile(rawPcmPath);
    const totalSamples = Math.floor(rawBytes.byteLength / 8); // 2 channels * 4 bytes

    if (totalSamples === 0) {
      throw new Error('Source audio stream contained zero samples.');
    }

    const left = new Float32Array(totalSamples);
    const right = new Float32Array(totalSamples);
    const interleavedView = new Float32Array(
      rawBytes.buffer,
      rawBytes.byteOffset,
      totalSamples * 2
    );
    for (let i = 0; i < totalSamples; i++) {
      left[i] = interleavedView[i * 2];
      right[i] = interleavedView[i * 2 + 1];
    }

    // Delete raw PCM immediately to reclaim disk space
    await fsp.unlink(rawPcmPath).catch(() => {});

    const outLeft = new Float32Array(totalSamples);
    const outRight = new Float32Array(totalSamples);
    const weightSum = new Float32Array(totalSamples);

    const chunkStarts: number[] = [];
    for (let start = 0; start < totalSamples; start += STEP_SAMPLES) {
      chunkStarts.push(start);
      if (start + CHUNK_SAMPLES >= totalSamples) break;
    }

    // Raised-cosine crossfade strictly on the OVERLAP_SAMPLES edges
    const crossfadeWin = new Float32Array(CHUNK_SAMPLES);
    for (let i = 0; i < CHUNK_SAMPLES; i++) {
      if (i < OVERLAP_SAMPLES) {
        crossfadeWin[i] = 0.5 * (1 - Math.cos((Math.PI * i) / OVERLAP_SAMPLES));
      } else if (i >= CHUNK_SAMPLES - OVERLAP_SAMPLES) {
        crossfadeWin[i] =
          0.5 *
          (1 -
            Math.cos((Math.PI * (CHUNK_SAMPLES - 1 - i)) / OVERLAP_SAMPLES));
      } else {
        crossfadeWin[i] = 1.0;
      }
    }

    const cpuThreads = Math.min(2, Math.max(1, os.cpus().length));
    onProgress?.(0.18, 'Initializing MDX-Net separation engine...');
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      enableCpuMemArena: false,
      enableMemPattern: false,
      intraOpNumThreads: cpuThreads,
      interOpNumThreads: 1,
    });

    const scratch = new Fft6144Scratch();
    const channelSize = DIM_F * DIM_T;
    const tensorData = new Float32Array(4 * channelSize);
    const chunkL = new Float32Array(CHUNK_SAMPLES);
    const chunkR = new Float32Array(CHUNK_SAMPLES);

    const lRealOffset = 0;
    const lImagOffset = channelSize;
    const rRealOffset = 2 * channelSize;
    const rImagOffset = 3 * channelSize;

    for (let cIdx = 0; cIdx < chunkStarts.length; cIdx++) {
      const start = chunkStarts[cIdx];
      const copyLen = Math.min(CHUNK_SAMPLES, totalSamples - start);

      chunkL.fill(0);
      chunkR.fill(0);
      chunkL.set(left.subarray(start, start + copyLen), 0);
      chunkR.set(right.subarray(start, start + copyLen), 0);

      await stftChunkChannelSeparated(
        chunkL,
        tensorData,
        lRealOffset,
        lImagOffset,
        scratch
      );
      await stftChunkChannelSeparated(
        chunkR,
        tensorData,
        rRealOffset,
        rImagOffset,
        scratch
      );

      let inputTensor: ort.Tensor | null = null;
      let outputs: Record<string, ort.Tensor> | null = null;
      const outName = session.outputNames[0];

      try {
        inputTensor = new ort.Tensor('float32', tensorData, [
          1,
          4,
          DIM_F,
          DIM_T,
        ]);
        outputs = await session.run({ [session.inputNames[0]]: inputTensor });
        const outData = outputs[outName].data as Float32Array;

        const sepL = await istftChunkChannelSeparated(
          outData,
          lRealOffset,
          lImagOffset,
          scratch
        );
        const comp = 1.035;
        const isFirstChunk = cIdx === 0;
        const isLastChunk = cIdx === chunkStarts.length - 1;

        for (let i = 0; i < copyLen; i++) {
          let w = crossfadeWin[i];
          if (isFirstChunk && i < OVERLAP_SAMPLES) w = 1.0;
          if (isLastChunk && i >= CHUNK_SAMPLES - OVERLAP_SAMPLES) w = 1.0;
          const pos = start + i;
          outLeft[pos] += sepL[i] * comp * w;
          weightSum[pos] += w;
        }

        const sepR = await istftChunkChannelSeparated(
          outData,
          rRealOffset,
          rImagOffset,
          scratch
        );
        for (let i = 0; i < copyLen; i++) {
          let w = crossfadeWin[i];
          if (isFirstChunk && i < OVERLAP_SAMPLES) w = 1.0;
          if (isLastChunk && i >= CHUNK_SAMPLES - OVERLAP_SAMPLES) w = 1.0;
          outRight[start + i] += sepR[i] * comp * w;
        }
      } finally {
        if (outputs && outputs[outName]) {
          outputs[outName].dispose();
        }
        if (inputTensor) {
          inputTensor.dispose();
        }
      }

      const frac = 0.22 + ((cIdx + 1) / chunkStarts.length) * 0.7;
      onProgress?.(
        frac,
        `Stripping English vocals & isolating music/SFX (segment ${cIdx + 1}/${chunkStarts.length})...`
      );
      await yieldToEventLoop();
    }

    onProgress?.(0.95, 'Writing isolated accompaniment track...');
    const dataByteLength = totalSamples * 4; // 2 channels * 2 bytes (pcm_s16le)
    const wavBuffer = Buffer.allocUnsafe(44 + dataByteLength);
    wavBuffer.write('RIFF', 0, 'ascii');
    wavBuffer.writeUInt32LE(36 + dataByteLength, 4);
    wavBuffer.write('WAVE', 8, 'ascii');
    wavBuffer.write('fmt ', 12, 'ascii');
    wavBuffer.writeUInt32LE(16, 16); // PCM fmt chunk size
    wavBuffer.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
    wavBuffer.writeUInt16LE(2, 22); // NumChannels = 2
    wavBuffer.writeUInt32LE(SAMPLE_RATE, 24);
    wavBuffer.writeUInt32LE(SAMPLE_RATE * 4, 28); // ByteRate
    wavBuffer.writeUInt16LE(4, 32); // BlockAlign
    wavBuffer.writeUInt16LE(16, 34); // BitsPerSample
    wavBuffer.write('data', 36, 'ascii');
    wavBuffer.writeUInt32LE(dataByteLength, 40);

    for (let i = 0; i < totalSamples; i++) {
      const lSample = Math.max(-1, Math.min(1, outLeft[i] / (weightSum[i] > 1e-6 ? weightSum[i] : 1.0)));
      const rSample = Math.max(-1, Math.min(1, outRight[i] / (weightSum[i] > 1e-6 ? weightSum[i] : 1.0)));
      const lInt = lSample < 0 ? Math.round(lSample * 32768) : Math.round(lSample * 32767);
      const rInt = rSample < 0 ? Math.round(rSample * 32768) : Math.round(rSample * 32767);
      const bytePos = 44 + i * 4;
      wavBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, lInt)), bytePos);
      wavBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, rInt)), bytePos + 2);
    }

    await fsp.writeFile(outputWavPath, wavBuffer);
  } finally {
    if (session) {
      await session.release().catch(() => {});
    }
    await fsp.unlink(rawPcmPath).catch(() => {});
  }
}

export function checkModelCached(modelsDir: string): boolean {
  return fs.existsSync(path.join(modelsDir, MODEL_FILENAME));
}

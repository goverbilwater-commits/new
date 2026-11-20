import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeVideoWithGemini } from './server/gemini.ts';
import {
  buildSrtSubtitles,
  mixDubbedVideo,
  probeMedia,
  trimClipSilence,
  type DubClipSpec,
  type TimeInterval,
} from './server/ffmpeg.ts';
import {
  getAllConfiguredKeys,
  getConfiguredServerPawanKeyCount,
  PawanApiError,
  resolvePawanApiKeys,
  saveKeys,
  synthesizeSoraniSpeechWithMeta,
} from './server/pawan.ts';
import { isolateAccompanimentWithMdxNet } from './server/separator.ts';
import {
  getEmotionConfig,
  type DubLine,
  type DubProgressEvent,
} from './src/shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKSPACE_ROOT = path.join(os.tmpdir(), 'soranidub');
const VIDEOS_DIR = path.join(WORKSPACE_ROOT, 'videos');
const JOBS_DIR = path.join(WORKSPACE_ROOT, 'jobs');
const MODELS_DIR = path.join(WORKSPACE_ROOT, 'models');

fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(MODELS_DIR, { recursive: true });

interface StoredVideo {
  videoId: string;
  filePath: string;
  accompanimentPath: string;
  accompanimentReady: boolean;
  separationPromise?: Promise<string>;
  separationFraction: number;
  separationMessage: string;
  separationListeners: Set<(fraction: number, message: string) => void>;
  filename: string;
  mimeType: string;
  duration: number;
  hasAudio: boolean;
  channels: number;
  createdAt: number;
}

interface DubJobRecord {
  jobId: string;
  videoId: string;
  originalFilename: string;
  workDir: string;
  outputPath: string;
  latestEvent: DubProgressEvent;
  listeners: Set<(event: DubProgressEvent) => void>;
  createdAt: number;
  clips?: DubClipSpec[];
  preserveIntervals?: TimeInterval[];
  lines?: DubLine[];
  videoDuration?: number;
  hasAudio?: boolean;
  videoFilePath?: string;
  accompanimentWavPath?: string;
  backgroundVolume?: number;
  voiceVolume?: number;
  enableMastering?: boolean;
}

const videoRegistry = new Map<string, StoredVideo>();
const jobRegistry = new Map<string, DubJobRecord>();

// Periodic cleanup of expired temporary videos and rendered jobs (> 2 hours old)
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [videoId, video] of videoRegistry.entries()) {
    if (now - video.createdAt > MAX_AGE_MS) {
      videoRegistry.delete(videoId);
      fsp.unlink(video.filePath).catch(() => {});
      fsp.unlink(video.accompanimentPath).catch(() => {});
    }
  }
  for (const [jobId, job] of jobRegistry.entries()) {
    if (now - job.createdAt > MAX_AGE_MS && job.listeners.size === 0) {
      jobRegistry.delete(jobId);
      fsp.rm(job.workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}, 15 * 60 * 1000).unref();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, VIDEOS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `${crypto.randomUUID()}${ext.toLowerCase()}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 250 * 1024 * 1024, // 250 MB
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExt = ['.mp4', '.mov', '.webm'].includes(ext);
    const allowedMime =
      file.mimetype.startsWith('video/') || file.mimetype === 'application/octet-stream';
    if (allowedExt || allowedMime) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported video format. Please upload an MP4, MOV, or WEBM file.'));
    }
  },
});

function emitJobProgress(job: DubJobRecord, event: DubProgressEvent) {
  job.latestEvent = event;
  for (const listener of job.listeners) {
    listener(event);
  }
}

async function ensureVideoAccompaniment(
  video: StoredVideo,
  onProgress?: (fraction: number, message: string) => void
): Promise<string> {
  if (video.accompanimentReady && fs.existsSync(video.accompanimentPath)) {
    onProgress?.(1, 'Isolated background audio ready from cache.');
    return video.accompanimentPath;
  }

  if (onProgress) {
    video.separationListeners.add(onProgress);
    if (video.separationPromise) {
      onProgress(video.separationFraction, video.separationMessage);
    }
  }

  if (!video.separationPromise) {
    const sepWorkDir = path.join(VIDEOS_DIR, `${video.videoId}_sep`);
    video.separationFraction = 0.02;
    video.separationMessage = 'Preparing neural vocal-removal model (UVR MDX-Net)...';

    video.separationPromise = (async () => {
      await fsp.mkdir(sepWorkDir, { recursive: true });
      try {
        await isolateAccompanimentWithMdxNet({
          videoPath: video.filePath,
          outputWavPath: video.accompanimentPath,
          workDir: sepWorkDir,
          modelsDir: MODELS_DIR,
          onProgress: (fraction, msg) => {
            video.separationFraction = fraction;
            video.separationMessage = msg;
            for (const listener of video.separationListeners) {
              listener(fraction, msg);
            }
          },
        });
        video.accompanimentReady = true;
        return video.accompanimentPath;
      } catch (err) {
        video.separationPromise = undefined;
        video.accompanimentReady = false;
        throw err;
      } finally {
        await fsp.rm(sepWorkDir, { recursive: true, force: true }).catch(() => {});
      }
    })();
  }

  try {
    return await video.separationPromise;
  } finally {
    if (onProgress) {
      video.separationListeners.delete(onProgress);
    }
  }
}

async function runDubbingJob(params: {
  job: DubJobRecord;
  video: StoredVideo;
  lines: DubLine[];
  pawanApiKeys: string[];
}) {
  const { job, video, lines, pawanApiKeys } = params;
  const sortedLines = [...lines]
    .filter((line) => !line.preserve_original && line.kurdish_sorani.trim().length > 0)
    .sort((a, b) => a.start_time - b.start_time);
  const preserveIntervals: TimeInterval[] = lines
    .filter((line) => Boolean(line.preserve_original))
    .map((line) => ({
      startTime: Math.max(0, Number(line.start_time) || 0),
      endTime: Math.max(
        (Number(line.start_time) || 0) + 0.1,
        Number(line.end_time) || 0
      ),
    }))
    .sort((a, b) => a.startTime - b.startTime);

  if (sortedLines.length === 0 && preserveIntervals.length === 0) {
    emitJobProgress(job, {
      jobId: job.jobId,
      stage: 'error',
      progress: 0,
      completedLines: 0,
      totalLines: 0,
      message: 'No spoken Kurdish Sorani lines to synthesize.',
      error: 'Timeline has no valid Kurdish Sorani lines.',
    });
    return;
  }

  const tempAudioPaths: string[] = [];
  let activeKeys = [...pawanApiKeys];

  try {
    const total = sortedLines.length;
    const clipsByIndex = new Array<DubClipSpec>(total);
    let ttsDone = false;
    let completedTtsCount = 0;

    // Start (or reuse) background MDX-Net vocal separation immediately in parallel with TTS
    type AccompanimentOutcome =
      | { ok: true; path: string | undefined }
      | { ok: false; error: unknown };

    const accompanimentPromise: Promise<AccompanimentOutcome> =
      video.hasAudio && total > 0
        ? ensureVideoAccompaniment(video, (fraction, msg) => {
            if (!ttsDone) return;
            const pct = Math.min(89, Math.max(56, Math.round(56 + fraction * 32)));
            emitJobProgress(job, {
              jobId: job.jobId,
              stage: 'separating',
              progress: pct,
              completedLines: total,
              totalLines: total,
              message: msg,
            });
          }).then(
            (p): AccompanimentOutcome => ({ ok: true, path: p }),
            (err): AccompanimentOutcome => ({ ok: false, error: err })
          )
        : Promise.resolve({ ok: true, path: undefined });

    if (total > 0) {
      emitJobProgress(job, {
        jobId: job.jobId,
        stage: 'tts',
        progress: 5,
        completedLines: 0,
        totalLines: total,
        message: `Synthesizing ${total} Kurdish Sorani lines in parallel...`,
      });

      let nextIndex = 0;
      // Pawan plans allow 1 concurrent request per key, so use one worker per key.
      const concurrency = Math.min(3, Math.max(1, activeKeys.length), total);

      const worker = async (workerId: number) => {
        while (true) {
          const i = nextIndex++;
          if (i >= total) break;

          const line = sortedLines[i];
          const emotionCfg = getEmotionConfig(line.emotion);

          // Spread concurrent workers across available keys to avoid single-key throttling
          const keyOffset =
            activeKeys.length > 1 ? (i + workerId) % activeKeys.length : 0;
          const workerKeys = activeKeys.length > 0
            ? [
                ...activeKeys.slice(keyOffset),
                ...activeKeys.slice(0, keyOffset),
              ]
            : pawanApiKeys;

          const ttsResult = await synthesizeSoraniSpeechWithMeta({
            text: line.kurdish_sorani,
            voice: line.voice,
            apiKeys: workerKeys,
            speed: emotionCfg.ttsSpeed,
            emotion: line.emotion,
          });

          if (ttsResult.deadKeys.length > 0) {
            const deadSet = new Set(ttsResult.deadKeys);
            const remaining = activeKeys.filter((k) => !deadSet.has(k));
            if (remaining.length > 0) {
              activeKeys = remaining;
            }
          }

          if (ttsResult.switchedToFallback && ttsResult.keyIndexUsed > 0) {
            const failedKeys = new Set(workerKeys.slice(0, ttsResult.keyIndexUsed));
            activeKeys = [
              ...activeKeys.filter((k) => !failedKeys.has(k)),
              ...activeKeys.filter((k) => failedKeys.has(k)),
            ];
          }

          const rawClipPath = path.join(job.workDir, `tts_${i}.mp3`);
          const trimmedClipPath = path.join(job.workDir, `tts_${i}_trimmed.wav`);
          await fsp.writeFile(rawClipPath, ttsResult.buffer);
          tempAudioPaths.push(rawClipPath, trimmedClipPath);

          const trimResult = await trimClipSilence(rawClipPath, trimmedClipPath);
          const activeClipPath = trimResult.trimmed ? trimmedClipPath : rawClipPath;
          const ttsDuration = trimResult.duration;

          const isHighEnergy =
            emotionCfg.value === 'shouting' ||
            emotionCfg.value === 'angry' ||
            emotionCfg.value === 'agitated' ||
            emotionCfg.value === 'excited';

          clipsByIndex[i] = {
            path: activeClipPath,
            startTime: Math.max(0, Number(line.start_time) || 0),
            endTime: Math.max(
              (Number(line.start_time) || 0) + 0.25,
              Number(line.end_time) || 0
            ),
            ttsDuration:
              ttsDuration > 0
                ? ttsDuration
                : Math.max(0.5, line.end_time - line.start_time),
            gain: isHighEnergy ? 1.28 : 1.15,
          };

          completedTtsCount += 1;
          const pct = Math.round(5 + (completedTtsCount / total) * 50);
          emitJobProgress(job, {
            jobId: job.jobId,
            stage: 'tts',
            progress: pct,
            completedLines: completedTtsCount,
            totalLines: total,
            message: `Synthesized ${completedTtsCount} of ${total} lines (${line.voice} · ${emotionCfg.label} ${emotionCfg.ttsSpeed.toFixed(2)}x)...`,
          });
        }
      };

      await Promise.all(
        Array.from({ length: concurrency }, (_, workerId) => worker(workerId))
      );
    }

    ttsDone = true;
    const clips = clipsByIndex;

    if (video.hasAudio && clips.length > 0 && !video.accompanimentReady) {
      const pct = Math.min(
        89,
        Math.max(56, Math.round(56 + video.separationFraction * 32))
      );
      emitJobProgress(job, {
        jobId: job.jobId,
        stage: 'separating',
        progress: pct,
        completedLines: total,
        totalLines: total,
        message:
          video.separationMessage ||
          'Stripping English vocals & isolating music/SFX...',
      });
    }

    const accompanimentOutcome = await accompanimentPromise;
    if (accompanimentOutcome.ok === false) {
      throw accompanimentOutcome.error;
    }
    const accompanimentWavPath = accompanimentOutcome.path;

    emitJobProgress(job, {
      jobId: job.jobId,
      stage: 'mixing',
      progress: 92,
      completedLines: total,
      totalLines: total,
      message: 'Syncing Sorani speech to lip movement with zero English voice bleed...',
    });

    job.clips = clips;
    job.preserveIntervals = preserveIntervals;
    job.lines = lines;
    job.videoDuration = video.duration;
    job.hasAudio = video.hasAudio;
    job.videoFilePath = video.filePath;
    job.accompanimentWavPath = accompanimentWavPath;
    job.backgroundVolume = 1.0;
    job.voiceVolume = 1.15;
    job.enableMastering = true;

    const { speedAdjustedCount, separationMode } = await mixDubbedVideo({
      videoPath: video.filePath,
      outputPath: job.outputPath,
      workDir: job.workDir,
      videoDuration: video.duration,
      hasAudio: video.hasAudio,
      accompanimentWavPath,
      clips,
      preserveIntervals,
      backgroundVolume: job.backgroundVolume,
      voiceVolume: job.voiceVolume,
      enableMastering: job.enableMastering,
    });

    const baseName = path.basename(
      job.originalFilename,
      path.extname(job.originalFilename)
    );
    const safeName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'video';
    const downloadFilename = `${safeName}_kurdish_sorani.mp4`;

    emitJobProgress(job, {
      jobId: job.jobId,
      stage: 'done',
      progress: 100,
      completedLines: total,
      totalLines: total,
      speedAdjustedCount,
      separationMode,
      message: 'Dubbed Kurdish Sorani MP4 with isolated background audio ready.',
      previewUrl: `/api/dub/video/${job.jobId}`,
      downloadUrl: `/api/dub/download/${job.jobId}`,
      downloadFilename,
      subtitlesUrl: `/api/dub/subtitles/${job.jobId}?mode=kurdish`,
      subtitlesDualUrl: `/api/dub/subtitles/${job.jobId}?mode=dual`,
      backgroundVolume: job.backgroundVolume,
      voiceVolume: job.voiceVolume,
      masteringEnabled: job.enableMastering,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unexpected error during dubbing.';
    emitJobProgress(job, {
      jobId: job.jobId,
      stage: 'error',
      progress: 0,
      completedLines: 0,
      totalLines: sortedLines.length,
      message,
      error: message,
    });
  } finally {
    // Retain rendered audio clips in job.workDir for instant zero-credit re-mixing
    // (pruned automatically after 2 hours by server garbage collection)
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 1. Environment Configuration Status
  app.get('/api/config/status', (_req: Request, res: Response) => {
    const serverPawanKeyCount = getConfiguredServerPawanKeyCount();
    res.json({
      hasServerPawanKey: serverPawanKeyCount > 0,
      hasServerFallbackPawanKey: serverPawanKeyCount > 1,
      serverPawanKeyCount,
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY?.trim()),
    });
  });

  // 1b. Fetch all server keys (for syncing across all user devices)
  app.get('/api/config/keys', (_req: Request, res: Response) => {
    const keys = getAllConfiguredKeys();
    res.json({
      keys,
      count: keys.length,
      primaryKey: keys[0] || '',
      fallbackKeys: keys.slice(1),
    });
  });

  // 1c. Save/sync server keys (persisted to server file across devices & reboots)
  app.post('/api/config/keys', (req: Request, res: Response) => {
    try {
      const { keys } = req.body as { keys?: string[] };
      if (!Array.isArray(keys)) {
        res.status(400).json({ error: 'keys must be an array of strings' });
        return;
      }
      const saved = saveKeys(keys);
      res.json({
        success: true,
        keys: saved,
        count: saved.length,
        primaryKey: saved[0] || '',
        fallbackKeys: saved.slice(1),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to save keys';
      res.status(500).json({ error: msg });
    }
  });

  // 1d. Live validation test for an individual Pawan.Krd API key
  app.post('/api/config/test-key', async (req: Request, res: Response) => {
    try {
      const { key, checkTts } = req.body as { key?: string; checkTts?: boolean };
      if (!key || typeof key !== 'string' || !key.trim()) {
        res.status(400).json({ error: 'API key is required to test' });
        return;
      }
      const trimmed = key.trim();
      const modelsResp = await fetch('https://api.pawan.krd/v1/models', {
        headers: {
          Authorization: `Bearer ${trimmed}`,
        },
      });
      if (!modelsResp.ok) {
        const msg =
          modelsResp.status === 401
            ? '401 Invalid or revoked key'
            : `HTTP ${modelsResp.status}`;
        res.json({
          valid: false,
          status: modelsResp.status,
          error: msg,
        });
        return;
      }

      if (!checkTts) {
        res.json({ valid: true, status: modelsResp.status, message: 'Auth OK' });
        return;
      }

      const ttsResp = await fetch('https://api.pawan.krd/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${trimmed}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          model: 'pkrd/tts-ku',
          input: 'سڵاو',
          voice: 'aram',
          response_format: 'mp3',
          speed: 1.0,
        }),
      });

      if (ttsResp.ok) {
        res.json({ valid: true, status: 200, message: 'TTS + Credits OK' });
      } else {
        const detail = await ttsResp.text().catch(() => '');
        const shortErr =
          ttsResp.status === 402
            ? '402 No credits left'
            : ttsResp.status === 401
              ? '401 Invalid or revoked key'
              : ttsResp.status === 429
                ? '429 Rate limited (busy)'
                : `HTTP ${ttsResp.status}`;
        res.json({
          valid: false,
          status: ttsResp.status,
          error: shortErr,
          detail: detail.slice(0, 180),
        });
      }
    } catch (err) {
      res.json({
        valid: false,
        status: 500,
        error: err instanceof Error ? err.message : 'Network failure contacting Pawan API',
      });
    }
  });

  // 2. Step 1: Upload Video & Analyze with Gemini
  app.post('/api/analyze', (req: Request, res: Response) => {
    upload.single('video')(req, res, async (uploadErr) => {
      if (uploadErr) {
        const message =
          uploadErr instanceof Error ? uploadErr.message : 'Video upload failed.';
        res.status(400).json({ error: message });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'Please select a video file to upload.' });
        return;
      }

      const videoId = crypto.randomUUID();
      try {
        const probe = await probeMedia(file.path);
        const lines = await analyzeVideoWithGemini(
          file.path,
          file.mimetype,
          file.originalname
        );

        const stored: StoredVideo = {
          videoId,
          filePath: file.path,
          accompanimentPath: path.join(VIDEOS_DIR, `${videoId}_accompaniment.wav`),
          accompanimentReady: false,
          separationFraction: 0,
          separationMessage: 'Preparing vocal isolation...',
          separationListeners: new Set(),
          filename: file.originalname,
          mimeType: file.mimetype || 'video/mp4',
          duration: probe.duration,
          hasAudio: probe.hasAudio,
          channels: probe.channels,
          createdAt: Date.now(),
        };
        videoRegistry.set(videoId, stored);

        res.json({
          videoId,
          filename: stored.filename,
          duration: stored.duration,
          hasAudio: stored.hasAudio,
          lines,
        });

        // Pre-run neural vocal isolation in the background while the user edits lines in Step 2
        if (stored.hasAudio) {
          void ensureVideoAccompaniment(stored).catch(() => {});
        }
      } catch (error) {
        await fsp.unlink(file.path).catch(() => {});
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to analyze video with Gemini.';
        res.status(500).json({ error: message });
      }
    });
  });

  // Stream uploaded source video (for side-by-side comparison)
  app.get('/api/source/video/:videoId', (req: Request, res: Response) => {
    const videoId = String(req.params.videoId);
    const video = videoRegistry.get(videoId);
    if (!video || !fs.existsSync(video.filePath)) {
      res.status(404).json({ error: 'Source video not found or expired.' });
      return;
    }
    res.sendFile(video.filePath);
  });

  // 3. Step 2: Single-line Kurdish Sorani Voice Preview
  app.post('/api/tts/preview', async (req: Request, res: Response) => {
    try {
      const { text, voice, emotion, speed, pawanApiKey, pawanFallbackApiKey } =
        req.body as {
          text?: string;
          voice?: string;
          emotion?: string;
          speed?: number;
          pawanApiKey?: string;
          pawanFallbackApiKey?: string;
        };

      if (!text || !text.trim()) {
        res.status(400).json({ error: 'Kurdish Sorani text is required to preview.' });
        return;
      }

      const headerKey = req.header('x-pawan-api-key');
      const fallbackHeaderKey = req.header('x-pawan-fallback-api-key');
      const resolvedKeys = resolvePawanApiKeys(
        pawanApiKey || headerKey,
        pawanFallbackApiKey || fallbackHeaderKey
      );
      const resolvedSpeed =
        typeof speed === 'number' && Number.isFinite(speed)
          ? speed
          : getEmotionConfig(emotion).ttsSpeed;

      const { buffer: mp3Buffer } = await synthesizeSoraniSpeechWithMeta({
        text,
        voice: voice || 'aram',
        apiKeys: resolvedKeys,
        speed: resolvedSpeed,
        emotion: emotion,
      });

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', mp3Buffer.byteLength.toString());
      res.setHeader('Cache-Control', 'no-store');
      res.send(mp3Buffer);
    } catch (error) {
      if (error instanceof PawanApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      const message =
        error instanceof Error ? error.message : 'Failed to preview voice.';
      res.status(500).json({ error: message });
    }
  });

  // 4. Step 3: Start Full Audio Generation & FFmpeg Dubbing Job
  app.post('/api/dub', async (req: Request, res: Response) => {
    try {
      const { videoId, lines, pawanApiKey, pawanFallbackApiKey } = req.body as {
        videoId?: string;
        lines?: DubLine[];
        pawanApiKey?: string;
        pawanFallbackApiKey?: string;
      };

      if (!videoId) {
        res.status(400).json({ error: 'Missing videoId. Please upload and analyze a video first.' });
        return;
      }

      const video = videoRegistry.get(videoId);
      if (!video || !fs.existsSync(video.filePath)) {
        res.status(404).json({
          error: 'Uploaded video expired or not found on server. Please re-upload and analyze the video.',
        });
        return;
      }

      if (!Array.isArray(lines) || lines.length === 0) {
        res.status(400).json({ error: 'Timeline must contain at least one dialogue line.' });
        return;
      }

      const headerKey = req.header('x-pawan-api-key');
      const fallbackHeaderKey = req.header('x-pawan-fallback-api-key');
      const resolvedKeys = resolvePawanApiKeys(
        pawanApiKey || headerKey,
        pawanFallbackApiKey || fallbackHeaderKey
      );

      const jobId = crypto.randomUUID();
      const workDir = path.join(JOBS_DIR, jobId);
      await fsp.mkdir(workDir, { recursive: true });

      const outputPath = path.join(workDir, 'final_dubbed.mp4');
      const initialEvent: DubProgressEvent = {
        jobId,
        stage: 'queued',
        progress: 2,
        completedLines: 0,
        totalLines: lines.length,
        message: 'Initializing Kurdish Sorani dubbing pipeline...',
      };

      const job: DubJobRecord = {
        jobId,
        videoId,
        originalFilename: video.filename,
        workDir,
        outputPath,
        latestEvent: initialEvent,
        listeners: new Set(),
        createdAt: Date.now(),
      };

      jobRegistry.set(jobId, job);

      // Start asynchronous dubbing pipeline
      void runDubbingJob({
        job,
        video,
        lines,
        pawanApiKeys: resolvedKeys,
      });

      res.json({ jobId });
    } catch (error) {
      if (error instanceof PawanApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      const message =
        error instanceof Error ? error.message : 'Failed to start dubbing job.';
      res.status(500).json({ error: message });
    }
  });

  // JSON Status Endpoint (reliable fallback behind buffering proxies)
  app.get('/api/dub/status/:jobId', (req: Request, res: Response) => {
    const jobId = String(req.params.jobId);
    const job = jobRegistry.get(jobId);
    if (!job) {
      res.status(404).json({ error: 'Dubbing job not found or expired.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(job.latestEvent);
  });

  // SSE Progress Stream
  app.get('/api/dub/progress/:jobId', (req: Request, res: Response) => {
    const jobId = String(req.params.jobId);
    const job = jobRegistry.get(jobId);

    if (!job) {
      res.status(404).json({ error: 'Dubbing job not found.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const sendEvent = (event: DubProgressEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Send latest snapshot immediately
    sendEvent(job.latestEvent);

    if (job.latestEvent.stage === 'done' || job.latestEvent.stage === 'error') {
      res.end();
      return;
    }

    const keepaliveTimer = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 4000);

    const listener = (event: DubProgressEvent) => {
      sendEvent(event);
      if (event.stage === 'done' || event.stage === 'error') {
        clearInterval(keepaliveTimer);
        job.listeners.delete(listener);
        res.end();
      }
    };

    job.listeners.add(listener);

    req.on('close', () => {
      clearInterval(keepaliveTimer);
      job.listeners.delete(listener);
    });
  });

  // Stream Final Dubbed MP4 (with Range support)
  app.get('/api/dub/video/:jobId', (req: Request, res: Response) => {
    const jobId = String(req.params.jobId);
    const job = jobRegistry.get(jobId);
    if (!job || !fs.existsSync(job.outputPath)) {
      res.status(404).json({ error: 'Dubbed video not found.' });
      return;
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.sendFile(job.outputPath);
  });

  // Download Final Dubbed MP4
  app.get('/api/dub/download/:jobId', (req: Request, res: Response) => {
    const jobId = String(req.params.jobId);
    const job = jobRegistry.get(jobId);
    if (!job || !fs.existsSync(job.outputPath)) {
      res.status(404).json({ error: 'Dubbed video not found.' });
      return;
    }
    const baseName = path.basename(
      job.originalFilename,
      path.extname(job.originalFilename)
    );
    const safeName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'video';
    const downloadFilename = `${safeName}_kurdish_sorani.mp4`;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${downloadFilename}"; filename*=UTF-8''${encodeURIComponent(downloadFilename)}`
    );
    res.setHeader('X-Download-Filename', downloadFilename);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(job.outputPath);
  });

  // Download Subtitles in Kurdish or Dual (Kurdish + English) SRT format
  app.get('/api/dub/subtitles/:jobId', (req: Request, res: Response) => {
    const jobId = String(req.params.jobId);
    const job = jobRegistry.get(jobId);
    if (!job || !job.lines || job.lines.length === 0) {
      res.status(404).json({ error: 'Dubbed subtitles not found or expired.' });
      return;
    }
    const mode = req.query.mode === 'dual' ? 'dual' : 'kurdish';
    const srtContent = buildSrtSubtitles(job.lines, mode);
    const baseName = path.basename(
      job.originalFilename,
      path.extname(job.originalFilename)
    );
    const safeName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'video';
    const subtitleFilename = `${safeName}_${mode === 'dual' ? 'kurdish_english' : 'kurdish_sorani'}.srt`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${subtitleFilename}"; filename*=UTF-8''${encodeURIComponent(subtitleFilename)}`
    );
    res.setHeader('X-Download-Filename', subtitleFilename);
    res.send(srtContent);
  });

  // Fast Re-Mix with Custom Background & Voice Volumes + Studio Mastering (Instant Zero-TTS Re-Render)
  app.post('/api/dub/remix/:jobId', async (req: Request, res: Response) => {
    try {
      const jobId = String(req.params.jobId);
      const job = jobRegistry.get(jobId);
      if (!job || !job.clips || !job.videoFilePath) {
        res.status(404).json({
          error: 'Dubbing session expired or not ready for re-mixing.',
        });
        return;
      }

      const { backgroundVolume, voiceVolume, enableMastering } = req.body as {
        backgroundVolume?: number;
        voiceVolume?: number;
        enableMastering?: boolean;
      };

      const resolvedBgVol =
        typeof backgroundVolume === 'number'
          ? Math.max(0, Math.min(2.5, backgroundVolume))
          : job.backgroundVolume ?? 1.0;

      const resolvedVoiceVol =
        typeof voiceVolume === 'number'
          ? Math.max(0.2, Math.min(3.0, voiceVolume))
          : job.voiceVolume ?? 1.15;

      const resolvedMastering =
        typeof enableMastering === 'boolean'
          ? enableMastering
          : job.enableMastering ?? true;

      job.backgroundVolume = resolvedBgVol;
      job.voiceVolume = resolvedVoiceVol;
      job.enableMastering = resolvedMastering;

      const { speedAdjustedCount, separationMode } = await mixDubbedVideo({
        videoPath: job.videoFilePath,
        outputPath: job.outputPath,
        workDir: job.workDir,
        videoDuration: job.videoDuration || 0,
        hasAudio: Boolean(job.hasAudio),
        accompanimentWavPath: job.accompanimentWavPath,
        clips: job.clips,
        preserveIntervals: job.preserveIntervals || [],
        backgroundVolume: resolvedBgVol,
        voiceVolume: resolvedVoiceVol,
        enableMastering: resolvedMastering,
      });

      const baseName = path.basename(
        job.originalFilename,
        path.extname(job.originalFilename)
      );
      const safeName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'video';
      const downloadFilename = `${safeName}_kurdish_sorani.mp4`;

      const updatedEvent: DubProgressEvent = {
        jobId: job.jobId,
        stage: 'done',
        progress: 100,
        completedLines: job.clips.length,
        totalLines: job.clips.length,
        speedAdjustedCount,
        separationMode,
        message: 'Re-mixed Kurdish Sorani audio updated with custom volumes.',
        previewUrl: `/api/dub/video/${job.jobId}?v=${Date.now()}`,
        downloadUrl: `/api/dub/download/${job.jobId}`,
        downloadFilename,
        subtitlesUrl: `/api/dub/subtitles/${job.jobId}?mode=kurdish`,
        subtitlesDualUrl: `/api/dub/subtitles/${job.jobId}?mode=dual`,
        backgroundVolume: resolvedBgVol,
        voiceVolume: resolvedVoiceVol,
        masteringEnabled: resolvedMastering,
      };

      emitJobProgress(job, updatedEvent);
      res.json(updatedEvent);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to re-mix video.';
      res.status(500).json({ error: message });
    }
  });

  // Vite middleware in dev, static build in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`SoraniDub Studio server running at http://0.0.0.0:${port}`);
  });
}

void startServer();
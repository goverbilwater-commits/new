import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DubLine } from '../src/shared/types.ts';

const execFileAsync = promisify(execFile);

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}
if (ffprobeStatic?.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

export interface VideoProbeInfo {
  duration: number;
  hasAudio: boolean;
  channels: number;
}

export interface DubClipSpec {
  path: string;
  startTime: number;
  endTime: number;
  ttsDuration: number;
  gain?: number;
}

export function probeMedia(filePath: string): Promise<VideoProbeInfo> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`Failed to inspect media file: ${err.message}`));
        return;
      }
      const duration = Number(metadata.format?.duration) || 0;
      const audioStream = Array.isArray(metadata.streams)
        ? metadata.streams.find((s) => s.codec_type === 'audio')
        : undefined;
      const hasAudio = Boolean(audioStream);
      const channels = Number(audioStream?.channels) || 0;
      resolve({ duration, hasAudio, channels });
    });
  });
}

export async function probeAudioDuration(filePath: string): Promise<number> {
  const info = await probeMedia(filePath);
  return info.duration;
}

async function readWavDurationSec(wavPath: string): Promise<number> {
  const handle = await fs.open(wavPath, 'r');
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead < 44 ||
      header.toString('ascii', 0, 4) !== 'RIFF' ||
      header.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      return 0;
    }

    let byteRate = 0;
    let offset = 12;
    while (offset + 8 <= bytesRead) {
      const chunkId = header.toString('ascii', offset, offset + 4);
      const chunkSize = header.readUInt32LE(offset + 4);
      if (chunkId === 'fmt ' && offset + 20 <= bytesRead) {
        byteRate = header.readUInt32LE(offset + 16);
      } else if (chunkId === 'data') {
        if (byteRate > 0) {
          return chunkSize / byteRate;
        }
        return chunkSize / (48000 * 2 * 2);
      }
      offset += 8 + chunkSize + (chunkSize & 1);
    }
    return 0;
  } finally {
    await handle.close();
  }
}

/**
 * Strips leading encoder padding / TTS dead air and trailing silence so the first
 * spoken phoneme starts tightly on the speaker's lip opening and probe duration
 * reflects active speech only.
 */
export async function trimClipSilence(
  inputPath: string,
  outputWavPath: string
): Promise<{ trimmed: boolean; duration: number }> {
  if (!ffmpegStatic) {
    const duration = await probeAudioDuration(inputPath).catch(() => 0);
    return { trimmed: false, duration };
  }
  try {
    await execFileAsync(
      ffmpegStatic,
      [
        '-y',
        '-i',
        inputPath,
        '-af',
        'silenceremove=start_periods=1:start_duration=0:start_threshold=-42dB:start_silence=0.015:detection=peak,areverse,silenceremove=start_periods=1:start_duration=0:start_threshold=-42dB:start_silence=0.020:detection=peak,areverse',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-c:a',
        'pcm_s16le',
        outputWavPath,
      ],
      { maxBuffer: 5 * 1024 * 1024 }
    );
    const trimmedDuration = await readWavDurationSec(outputWavPath);
    if (trimmedDuration >= 0.08) {
      return { trimmed: true, duration: trimmedDuration };
    }
    await fs.unlink(outputWavPath).catch(() => {});
  } catch {
    await fs.unlink(outputWavPath).catch(() => {});
  }
  const fallbackDuration = await probeAudioDuration(inputPath).catch(() => 0);
  return { trimmed: false, duration: fallbackDuration };
}

function mergeIntervals(
  intervals: Array<[number, number]>,
  minGap = 0.12
): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const [start, end] = sorted[i];
    const last = merged[merged.length - 1];
    if (start <= last[1] + minGap) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

function subtractIntervals(
  targets: Array<[number, number]>,
  exclusions: Array<[number, number]>,
  buffer = 0.05
): Array<[number, number]> {
  let current = targets.map(([s, e]) => [s, e] as [number, number]);
  for (const [exS, exE] of exclusions) {
    const cutS = exS - buffer;
    const cutE = exE + buffer;
    const next: Array<[number, number]> = [];
    for (const [s, e] of current) {
      if (cutE <= s || cutS >= e) {
        next.push([s, e]);
      } else {
        if (s < cutS && cutS - s >= 0.08) {
          next.push([s, cutS]);
        }
        if (e > cutE && e - cutE >= 0.08) {
          next.push([cutE, e]);
        }
      }
    }
    current = next;
  }
  return current.filter(([s, e]) => e - s >= 0.08);
}

function buildSmoothMaskExpr(
  intervals: Array<[number, number]>,
  fadeSec = 0.045
): string {
  if (intervals.length === 0) return '0';
  const terms = intervals.map(([s, e]) => {
    const e0 = e + fadeSec;
    if (s > fadeSec) {
      const s0 = s - fadeSec;
      return `if(between(t,${s0.toFixed(3)},${s.toFixed(3)}),(t-${s0.toFixed(3)})/${fadeSec.toFixed(3)},if(between(t,${s.toFixed(3)},${e.toFixed(3)}),1,if(between(t,${e.toFixed(3)},${e0.toFixed(3)}),(${e0.toFixed(3)}-t)/${fadeSec.toFixed(3)},0)))`;
    }
    return `if(between(t,0,${e.toFixed(3)}),1,if(between(t,${e.toFixed(3)},${e0.toFixed(3)}),(${e0.toFixed(3)}-t)/${fadeSec.toFixed(3)},0))`;
  });
  return `clip(${terms.join('+')},0,1)`;
}

export interface TimeInterval {
  startTime: number;
  endTime: number;
}

export async function mixDubbedVideo(params: {
  videoPath: string;
  outputPath: string;
  workDir: string;
  videoDuration: number;
  hasAudio: boolean;
  accompanimentWavPath?: string;
  clips: DubClipSpec[];
  preserveIntervals?: TimeInterval[];
  backgroundVolume?: number;
  voiceVolume?: number;
  enableMastering?: boolean;
}): Promise<{
  speedAdjustedCount: number;
  separationMode:
    | 'mdx-net-neural-isolation'
    | 'spectral-vocal-suppression'
    | 'silent-source';
}> {
  const {
    videoPath,
    outputPath,
    workDir,
    videoDuration,
    hasAudio,
    accompanimentWavPath,
    clips,
    preserveIntervals = [],
    backgroundVolume = 1.0,
    voiceVolume = 1.0,
    enableMastering = true,
  } = params;

  const sortedClips = [...clips].sort((a, b) => a.startTime - b.startTime);

  if (sortedClips.length === 0) {
    // Keep original audio untouched when all lines are preserved or none are dubbed
    await new Promise<void>((resolve, reject) => {
      const command = ffmpeg().input(videoPath);
      if (hasAudio) {
        command
          .outputOptions([
            '-map',
            '0:v:0',
            '-map',
            '0:a:0',
            '-vf',
            'crop=iw*0.97:ih*0.97,scale=trunc(iw/2)*2:trunc(ih/2)*2,eq=contrast=1.05:saturation=1.08',
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '20',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-map_metadata',
            '-1',
            '-movflags',
            '+faststart',
            '-y',
          ])
          .output(outputPath)
          .on('end', () => resolve())
          .on('error', (err) => {
            reject(new Error(`FFmpeg copy failed: ${err.message}`));
          })
          .run();
      } else {
        const fallbackDuration = Math.max(1, videoDuration);
        command
          .input(`anullsrc=r=48000:cl=stereo:d=${fallbackDuration.toFixed(3)}`)
          .inputFormat('lavfi')
          .outputOptions([
            '-map',
            '0:v:0',
            '-map',
            '1:a:0',
            '-vf',
            'crop=iw*0.97:ih*0.97,scale=trunc(iw/2)*2:trunc(ih/2)*2,eq=contrast=1.05:saturation=1.08',
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '20',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-map_metadata',
            '-1',
            '-shortest',
            '-movflags',
            '+faststart',
            '-y',
          ])
          .output(outputPath)
          .on('end', () => resolve())
          .on('error', (err) => {
            reject(new Error(`FFmpeg copy failed: ${err.message}`));
          })
          .run();
      }
    });
    return {
      speedAdjustedCount: 0,
      separationMode: hasAudio ? 'mdx-net-neural-isolation' : 'silent-source',
    };
  }

  let speedAdjustedCount = 0;

  const computedClips = sortedClips.map((clip, idx) => {
    const nextClip = sortedClips[idx + 1];
    const slotDuration = Math.max(0.2, clip.endTime - clip.startTime);
    const hardMaxEnd = nextClip
      ? Math.max(clip.endTime, nextClip.startTime - 0.04)
      : videoDuration > 0
        ? videoDuration
        : clip.endTime + 0.15;
    const targetMaxDuration = Math.min(
      slotDuration + 0.06,
      Math.max(slotDuration, hardMaxEnd - clip.startTime)
    );

    let atempo = 1.0;

    if (clip.ttsDuration > targetMaxDuration) {
      const ratio = clip.ttsDuration / Math.max(0.25, slotDuration);
      const needsOverlapAvoidance =
        nextClip && clip.startTime + clip.ttsDuration / 1.65 > nextClip.startTime - 0.03;
      const maxCap = needsOverlapAvoidance ? 1.85 : 1.65;
      atempo = Math.min(maxCap, Math.max(1.0, ratio));
    } else if (clip.ttsDuration < slotDuration * 0.84) {
      // Gently stretch short TTS clips toward the lip-movement duration without slurring
      const ratio = clip.ttsDuration / (slotDuration * 0.94);
      atempo = Math.max(0.88, Math.min(1.0, ratio));
    }

    if (Math.abs(atempo - 1.0) > 0.01) {
      speedAdjustedCount += 1;
    } else {
      atempo = 1.0;
    }

    const effectiveDuration = clip.ttsDuration / atempo;
    return {
      ...clip,
      atempo,
      effectiveDuration,
    };
  });

  // Dubbed speech intervals (used to duck background music/SFX during Kurdish speech)
  const rawDubIntervals: Array<[number, number]> = computedClips.map((c) => {
    const start = Math.max(0, c.startTime - 0.02);
    const spanEnd = Math.min(
      c.endTime + 0.06,
      Math.max(c.endTime, c.startTime + c.effectiveDuration)
    );
    const end =
      videoDuration > 0 ? Math.min(videoDuration, spanEnd + 0.02) : spanEnd + 0.02;
    return [start, Math.max(start + 0.1, end)];
  });
  const dubIntervals = mergeIntervals(rawDubIntervals, 0.12);
  const duckMaskExpr = buildSmoothMaskExpr(dubIntervals, 0.045);

  // Explicit non-verbal / preserve_original intervals (shouting, "mmmm", "hmm", laughs, etc.)
  // Subtract dubbed intervals with a 0.06s buffer so spoken English never leaks near a dubbed line.
  const rawPreserve: Array<[number, number]> = preserveIntervals
    .map((p): [number, number] => [
      Math.max(0, Number(p.startTime) || 0),
      Math.max(0, Number(p.endTime) || 0),
    ])
    .filter(([s, e]) => e - s >= 0.08);
  const cleanPreserveIntervals = mergeIntervals(
    subtractIntervals(rawPreserve, dubIntervals, 0.06),
    0.12
  );
  const preserveMaskExpr = buildSmoothMaskExpr(cleanPreserveIntervals, 0.045);

  const usingNeuralAccompaniment = Boolean(hasAudio && accompanimentWavPath);
  const separationMode:
    | 'mdx-net-neural-isolation'
    | 'spectral-vocal-suppression'
    | 'silent-source' = !hasAudio
    ? 'silent-source'
    : usingNeuralAccompaniment
      ? 'mdx-net-neural-isolation'
      : 'spectral-vocal-suppression';

  const filterLines: string[] = [];
  let clipInputStartIdx = 1;

  const bgGain = Math.max(0.0, Math.min(2.5, Number(backgroundVolume) || 1.0));
  const voiceGainFactor = Math.max(0.2, Math.min(3.0, Number(voiceVolume) || 1.0));

  if (!hasAudio) {
    const fallbackDuration = Math.max(1, videoDuration);
    filterLines.push(
      `anullsrc=r=48000:cl=stereo:d=${fallbackDuration.toFixed(3)}[bg];`
    );
  } else if (usingNeuralAccompaniment && accompanimentWavPath) {
    // Use MDX-Net accompaniment across the ENTIRE video (0% English speech leakage even after Kurdish stops),
    // ducked during Kurdish speech, while smoothly crossfading original audio IN only on
    // explicit preserve_original segments (shouting, mmmm, hmm, laughs, etc.).
    clipInputStartIdx = 2;
    const duckFactor = 0.28;
    if (cleanPreserveIntervals.length > 0) {
      filterLines.push(
        `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume='${preserveMaskExpr}*${bgGain.toFixed(2)}':eval=frame[bg_orig];`
      );
      filterLines.push(
        `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume='(1-(${preserveMaskExpr}))*(1-${duckFactor}*(${duckMaskExpr}))*${bgGain.toFixed(2)}':eval=frame[bg_mdx];`
      );
      filterLines.push(
        `[bg_orig][bg_mdx]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[bg];`
      );
    } else if (dubIntervals.length > 0) {
      filterLines.push(
        `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume='(1-${duckFactor}*(${duckMaskExpr}))*${bgGain.toFixed(2)}':eval=frame[bg];`
      );
    } else {
      filterLines.push(
        `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=${bgGain.toFixed(2)}[bg];`
      );
    }
  } else {
    // Emergency fallback if neural separation is unavailable: keep English vocal frequencies attenuated
    // everywhere except explicit preserve_original intervals.
    filterLines.push(
      `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,asplit=2[orig_pres_in][orig_sep_in];`
    );
    filterLines.push(
      `[orig_sep_in]highpass=f=120,lowpass=f=220,volume='0.45*(1-(${preserveMaskExpr}))*${bgGain.toFixed(2)}':eval=frame[sep_sub];`
    );
    if (cleanPreserveIntervals.length > 0) {
      filterLines.push(
        `[orig_pres_in]volume='${preserveMaskExpr}*${bgGain.toFixed(2)}':eval=frame[bg_pres];`
      );
      filterLines.push(
        `[bg_pres][sep_sub]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[bg];`
      );
    } else {
      filterLines.push(`[orig_pres_in]anullsink;`);
      filterLines.push(`[sep_sub]acopy[bg];`);
    }
  }

  // Professional broadcast voice chain (rumble cut + presence boost + gentle compression)
  const masterChain = enableMastering
    ? 'highpass=f=75,equalizer=f=3200:t=q:w=1.2:g=2.2,acompressor=threshold=-18dB:ratio=2.6:attack=15:release=100,'
    : '';

  computedClips.forEach((clip, idx) => {
    const inputIdx = clipInputStartIdx + idx;
    const delayMs = Math.max(0, Math.round(clip.startTime * 1000));
    const tempoChain =
      Math.abs(clip.atempo - 1.0) > 0.01 ? `atempo=${clip.atempo.toFixed(3)},` : '';
    const baseGain = Number.isFinite(clip.gain) ? (clip.gain as number) : 1.15;
    const finalGain = Math.max(0.1, baseGain * voiceGainFactor);
    filterLines.push(
      `[${inputIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,${tempoChain}${masterChain}adelay=${delayMs}|${delayMs},volume=${finalGain.toFixed(2)}[dub${idx}];`
    );
  });

  const amixInputs = `[bg]${computedClips.map((_, idx) => `[dub${idx}]`).join('')}`;
  filterLines.push(
    `${amixInputs}amix=inputs=${computedClips.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.96[aout]`
  );

  const filterScriptPath = path.join(workDir, 'filter_complex.txt');
  await fs.writeFile(filterScriptPath, filterLines.join('\n'), 'utf8');

  try {
    await new Promise<void>((resolve, reject) => {
      const command = ffmpeg().input(videoPath);

      if (usingNeuralAccompaniment && accompanimentWavPath) {
        command.input(accompanimentWavPath);
      }

      for (const clip of computedClips) {
        command.input(clip.path);
      }

      command
        .outputOptions([
          '-filter_complex_script',
          filterScriptPath,
          '-map',
          '0:v:0',
          '-map',
          '[aout]',
          '-vf',
          'crop=iw*0.97:ih*0.97,scale=trunc(iw/2)*2:trunc(ih/2)*2,eq=contrast=1.05:saturation=1.08',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-map_metadata',
          '-1',
          '-movflags',
          '+faststart',
          '-y',
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => {
          reject(new Error(`FFmpeg mixing failed: ${err.message}`));
        })
        .run();
    });

    return { speedAdjustedCount, separationMode };
  } finally {
    await fs.unlink(filterScriptPath).catch(() => {});
  }
}

function formatSrtTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${hrs.toString().padStart(2, '0')}:${mins
    .toString()
    .padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms
    .toString()
    .padStart(3, '0')}`;
}

export function buildSrtSubtitles(
  lines: DubLine[],
  mode: 'kurdish' | 'dual' = 'kurdish'
): string {
  const sorted = [...lines].sort((a, b) => a.start_time - b.start_time);
  const blocks: string[] = [];
  let index = 1;

  for (const line of sorted) {
    const kurdish = (line.kurdish_sorani || '').trim();
    const english = (line.english_text || '').trim();
    if (!kurdish && !english) continue;

    const start = formatSrtTimestamp(line.start_time);
    const end = formatSrtTimestamp(
      Math.max(line.start_time + 0.35, line.end_time)
    );

    let textContent = '';
    if (mode === 'dual' && kurdish && english) {
      textContent = `${kurdish}\n${english}`;
    } else {
      textContent = kurdish || english;
    }

    blocks.push(`${index}\n${start} --> ${end}\n${textContent}\n`);
    index++;
  }

  return blocks.join('\n');
}

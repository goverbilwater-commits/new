import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Columns2,
  Download,
  FileText,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Sliders,
  Sparkles,
  ToggleLeft,
  Volume2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DubProgressEvent } from '../shared/types.ts';

interface DubbingOutputStepProps {
  originalVideoUrl: string;
  progressEvent: DubProgressEvent | null;
  onBackToTimeline: () => void;
  onRetryDubbing: () => void;
  onOpenSettings: () => void;
}

function formatSeparationLabel(
  mode?: DubProgressEvent['separationMode']
): string {
  if (mode === 'mdx-net-neural-isolation') return 'MDX-Net neural vocal removal';
  if (mode === 'spectral-vocal-suppression') return 'Spectral vocal suppression';
  if (mode === 'silent-source') return 'Silent source video';
  return 'Isolated accompaniment';
}

export function DubbingOutputStep({
  originalVideoUrl,
  progressEvent,
  onBackToTimeline,
  onRetryDubbing,
  onOpenSettings,
}: DubbingOutputStepProps) {
  const [activeEvent, setActiveEvent] = useState<DubProgressEvent | null>(
    progressEvent
  );

  useEffect(() => {
    setActiveEvent(progressEvent);
  }, [progressEvent]);

  const [viewMode, setViewMode] = useState<'toggle' | 'side-by-side'>('toggle');
  const [activeTrack, setActiveTrack] = useState<'dubbed' | 'original'>('dubbed');
  const [sideAudioSource, setSideAudioSource] = useState<'dubbed' | 'original'>(
    'dubbed'
  );
  const [isSyncedPlaying, setIsSyncedPlaying] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Advanced studio mixing state
  const [bgVolume, setBgVolume] = useState<number>(100);
  const [voiceVolume, setVoiceVolume] = useState<number>(115);
  const [masteringEnabled, setMasteringEnabled] = useState<boolean>(true);
  const [isRemixing, setIsRemixing] = useState(false);
  const [remixSuccess, setRemixSuccess] = useState<string | null>(null);
  const [isDownloadingSubs, setIsDownloadingSubs] = useState(false);

  const toggleVideoRef = useRef<HTMLVideoElement | null>(null);
  const origSyncRef = useRef<HTMLVideoElement | null>(null);
  const dubSyncRef = useRef<HTMLVideoElement | null>(null);

  const isRunning =
    !activeEvent ||
    activeEvent.stage === 'queued' ||
    activeEvent.stage === 'tts' ||
    activeEvent.stage === 'separating' ||
    activeEvent.stage === 'mixing';

  const isError = activeEvent?.stage === 'error';
  const isDone =
    activeEvent?.stage === 'done' && Boolean(activeEvent.previewUrl);

  const handleSwitchToggleTrack = (nextTrack: 'dubbed' | 'original') => {
    if (nextTrack === activeTrack) return;
    const el = toggleVideoRef.current;
    const savedTime = el?.currentTime ?? 0;
    const wasPlaying = el ? !el.paused : false;
    setActiveTrack(nextTrack);
    requestAnimationFrame(() => {
      if (toggleVideoRef.current) {
        toggleVideoRef.current.currentTime = savedTime;
        if (wasPlaying) {
          void toggleVideoRef.current.play().catch(() => {});
        }
      }
    });
  };

  const handleSyncedPlayPause = () => {
    const orig = origSyncRef.current;
    const dub = dubSyncRef.current;
    if (!orig || !dub) return;

    if (isSyncedPlaying) {
      orig.pause();
      dub.pause();
      setIsSyncedPlaying(false);
    } else {
      orig.currentTime = dub.currentTime;
      void Promise.all([
        orig.play().catch(() => {}),
        dub.play().catch(() => {}),
      ]);
      setIsSyncedPlaying(true);
    }
  };

  const handleRemix = async () => {
    if (!activeEvent?.jobId || isRemixing) return;
    setIsRemixing(true);
    setRemixSuccess(null);
    setDownloadError(null);

    try {
      const res = await fetch(`/api/dub/remix/${activeEvent.jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          backgroundVolume: bgVolume / 100,
          voiceVolume: voiceVolume / 100,
          enableMastering: masteringEnabled,
        }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || 'Failed to re-mix audio.');
      }

      const updated = (await res.json()) as DubProgressEvent;
      setActiveEvent(updated);
      setRemixSuccess('Studio mix updated! Video player reloaded.');
      setTimeout(() => setRemixSuccess(null), 4000);

      // Force video element reload
      if (toggleVideoRef.current) {
        const cur = toggleVideoRef.current.currentTime;
        toggleVideoRef.current.load();
        toggleVideoRef.current.currentTime = cur;
      }
      if (dubSyncRef.current) {
        const cur = dubSyncRef.current.currentTime;
        dubSyncRef.current.load();
        dubSyncRef.current.currentTime = cur;
      }
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : 'Failed to re-mix audio.'
      );
    } finally {
      setIsRemixing(false);
    }
  };

  const handleDownloadSubtitles = async (mode: 'kurdish' | 'dual' = 'kurdish') => {
    const url =
      mode === 'dual' ? activeEvent?.subtitlesDualUrl : activeEvent?.subtitlesUrl;
    if (!url || isDownloadingSubs) return;

    setIsDownloadingSubs(true);
    setDownloadError(null);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Could not download subtitle file.');
      const text = await res.text();
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      const base =
        activeEvent?.downloadFilename?.replace(/\.[^/.]+$/, '') || 'video';
      a.download = `${base}_${mode === 'dual' ? 'kurdish_english' : 'kurdish_sorani'}.srt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : 'Subtitles download failed.'
      );
    } finally {
      setIsDownloadingSubs(false);
    }
  };

  const handleDownloadVideo = async () => {
    const url = activeEvent?.downloadUrl;
    if (!url || isDownloading) return;

    setIsDownloading(true);
    setDownloadProgress(null);
    setDownloadError(null);

    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });

      if (!response.ok) {
        const errBody = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errBody.error ||
            `Download failed (HTTP ${response.status}). Please re-run dubbing if the session expired.`
        );
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        throw new Error(
          'Received an unexpected HTML response instead of the MP4 file. Please refresh and try again.'
        );
      }

      const headerFilename = response.headers.get('x-download-filename');
      const disposition = response.headers.get('content-disposition') || '';
      const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      const asciiMatch = /filename="?([^";]+)"?/i.exec(disposition);
      const resolvedFilename =
        headerFilename ||
        (utf8Match ? decodeURIComponent(utf8Match[1]) : '') ||
        (asciiMatch ? asciiMatch[1] : '') ||
        activeEvent?.downloadFilename ||
        'dubbed_kurdish_sorani.mp4';

      let mp4Blob: Blob;
      const totalBytes = Number(response.headers.get('content-length')) || 0;

      if (response.body && totalBytes > 0) {
        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let received = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            const copy = new Uint8Array(value.byteLength);
            copy.set(value);
            chunks.push(copy);
            received += value.byteLength;
            setDownloadProgress(
              Math.min(99, Math.round((received / totalBytes) * 100))
            );
          }
        }
        mp4Blob = new Blob(chunks, { type: 'video/mp4' });
      } else {
        const rawBlob = await response.blob();
        mp4Blob = new Blob([rawBlob], { type: 'video/mp4' });
      }

      const blobUrl = URL.createObjectURL(mp4Blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = resolvedFilename;
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);

      // Delay revocation so mobile browsers (iOS Safari / Android Chrome) finish saving the blob
      window.setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
      }, 60_000);
    } catch (error) {
      setDownloadError(
        error instanceof Error
          ? error.message
          : 'Failed to download the dubbed MP4 video.'
      );
    } finally {
      setIsDownloading(false);
      setDownloadProgress(null);
    }
  };

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-4 border-b border-slate-800 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">
            Audio Separation &amp; Emotional Kurdish Dub
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Synthesizing emotion-paced <code className="font-mono-tabular text-slate-300">pkrd/tts-ku</code> speech, stripping original English vocals while retaining background music &amp; SFX, and time-syncing with FFmpeg <code className="font-mono-tabular text-slate-300">atempo</code>.
          </p>
        </div>

        <button
          type="button"
          onClick={onBackToTimeline}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#111827] px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Timeline Editor
        </button>
      </div>

      {/* Live Progress View */}
      {isRunning && (
        <div className="rounded-xl border border-slate-800 bg-[#111827] p-8 space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-amber-400 shrink-0" />
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  {progressEvent?.message || 'Starting dubbing pipeline...'}
                </h2>
                <p className="mt-0.5 text-xs text-slate-400 font-mono-tabular">
                  {progressEvent
                    ? `${progressEvent.completedLines} / ${progressEvent.totalLines} lines synthesized`
                    : 'Connecting to render stream...'}
                </p>
              </div>
            </div>
            <span className="text-lg font-semibold text-amber-400 font-mono-tabular">
              {progressEvent?.progress ?? 2}%
            </span>
          </div>

          <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-amber-500 transition-all duration-300"
              style={{ width: `${Math.max(4, progressEvent?.progress ?? 4)}%` }}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 border-t border-slate-800 pt-5 text-xs sm:grid-cols-3">
            <div className="space-y-1">
              <span className="font-medium text-slate-200">
                1. Emotional Sorani TTS
              </span>
              <p className="text-slate-400">
                Adjusts Pawan.Krd speaking rate per line mood with backoff retries.
              </p>
            </div>
            <div className="space-y-1">
              <span className="font-medium text-slate-200">
                2. Vocal Removal &amp; Sound Preservation
              </span>
              <p className="text-slate-400">
                Removes English speech only inside dubbed lines while keeping shouts, hmm/mmmm, music &amp; SFX unmuted.
              </p>
            </div>
            <div className="space-y-1">
              <span className="font-medium text-slate-200">
                3. Lip-Sync Trimming &amp; Mixing
              </span>
              <p className="text-slate-400">
                Strips TTS silence and fits each line tightly to lip movements via atempo and adelay.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Error State */}
      {isError && (
        <div className="rounded-xl border border-red-500/40 bg-red-950/25 p-6 space-y-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-red-200">
                Dubbing Render Failed
              </h2>
              <p className="text-xs leading-relaxed text-red-200/90">
                {progressEvent?.error || progressEvent?.message}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onRetryDubbing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 whitespace-nowrap shrink-0"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry Dubbing
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className="rounded-lg border border-slate-700 bg-[#111827] px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              Configure PAWAN_API_KEY
            </button>
          </div>
        </div>
      )}

      {/* Completed Output View */}
      {isDone && activeEvent?.previewUrl && activeEvent?.downloadUrl && (
        <div className="space-y-6">
          <div className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-[#111827] p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  Kurdish Sorani Dubbing Complete
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono-tabular">
                  <span>{activeEvent.totalLines} lines dubbed</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {activeEvent.speedAdjustedCount ?? 0} clips cadence-adjusted
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{formatSeparationLabel(activeEvent.separationMode)}</span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1 rounded-lg border border-slate-700 bg-[#0B0F17] p-1">
                <button
                  type="button"
                  onClick={() => setViewMode('toggle')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    viewMode === 'toggle'
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <ToggleLeft className="h-3.5 w-3.5" />
                  Toggle Player
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('side-by-side')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    viewMode === 'side-by-side'
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Columns2 className="h-3.5 w-3.5" />
                  Side-by-Side
                </button>
              </div>

              <button
                type="button"
                disabled={isDownloading}
                onClick={() => void handleDownloadVideo()}
                className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-5 py-2.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-amber-400 disabled:cursor-wait disabled:opacity-75 whitespace-nowrap shrink-0"
              >
                {isDownloading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>
                      {downloadProgress !== null
                        ? `Downloading ${downloadProgress}%...`
                        : 'Preparing MP4...'}
                    </span>
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4" />
                    <span>Download Final Dubbed MP4</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Studio Audio Mixing & Mastering Console */}
          <div className="rounded-xl border border-slate-800 bg-[#111827] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
              <div className="flex items-center gap-2">
                <Sliders className="h-4 w-4 text-amber-400" />
                <h3 className="text-sm font-semibold text-slate-100">
                  Studio Audio Mix &amp; Mastering Console
                </h3>
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-mono text-amber-300 border border-amber-500/20">
                  Zero-Credit Fast Re-Mix
                </span>
              </div>

              {/* Subtitle Downloads */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isDownloadingSubs}
                  onClick={() => void handleDownloadSubtitles('kurdish')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
                  title="Download Kurdish Sorani .SRT subtitles"
                >
                  <FileText className="h-3.5 w-3.5 text-amber-400" />
                  <span>Kurdish .SRT</span>
                </button>
                <button
                  type="button"
                  disabled={isDownloadingSubs}
                  onClick={() => void handleDownloadSubtitles('dual')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
                  title="Download Bilingual (Kurdish + English) .SRT subtitles"
                >
                  <FileText className="h-3.5 w-3.5 text-blue-400" />
                  <span>Dual .SRT</span>
                </button>
              </div>
            </div>

            {remixSuccess && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/30 p-2.5 text-xs text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                <span>{remixSuccess}</span>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 items-center">
              {/* Background Music Volume */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-300 font-medium flex items-center gap-1.5">
                    <Volume2 className="h-3.5 w-3.5 text-slate-400" />
                    Background Music / SFX
                  </span>
                  <span className="font-mono text-amber-400 font-semibold">{bgVolume}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="150"
                  step="5"
                  value={bgVolume}
                  onChange={(e) => setBgVolume(Number(e.target.value))}
                  className="w-full accent-amber-500 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                  <span>Mute</span>
                  <span>100% (Default)</span>
                  <span>150%</span>
                </div>
              </div>

              {/* Kurdish Dub Voice Volume */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-300 font-medium flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                    Kurdish Dub Dialogue
                  </span>
                  <span className="font-mono text-amber-400 font-semibold">{voiceVolume}%</span>
                </div>
                <input
                  type="range"
                  min="50"
                  max="200"
                  step="5"
                  value={voiceVolume}
                  onChange={(e) => setVoiceVolume(Number(e.target.value))}
                  className="w-full accent-amber-500 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                  <span>50%</span>
                  <span>115% (ADR Level)</span>
                  <span>200%</span>
                </div>
              </div>

              {/* Mastering Switch & Apply Button */}
              <div className="flex flex-col sm:flex-row md:flex-col gap-2.5 justify-end">
                <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={masteringEnabled}
                    onChange={(e) => setMasteringEnabled(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-900 text-amber-500 focus:ring-0"
                  />
                  <span>Studio ADR Mastering (EQ + Comp + Limiter)</span>
                </label>

                <button
                  type="button"
                  disabled={isRemixing}
                  onClick={() => void handleRemix()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-800 border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700 hover:text-white disabled:opacity-50"
                >
                  {isRemixing ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
                      <span>Applying Mix (1-2s)...</span>
                    </>
                  ) : (
                    <>
                      <Sliders className="h-3.5 w-3.5 text-amber-400" />
                      <span>Apply Studio Mix Changes</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {downloadError && (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/40 bg-red-950/30 p-4 text-xs text-red-200">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                <span>{downloadError}</span>
              </div>
              <button
                type="button"
                onClick={() => setDownloadError(null)}
                className="rounded-md px-2 py-1 text-xs text-red-300 hover:bg-red-900/40 whitespace-nowrap shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}

          {viewMode === 'toggle' ? (
            <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#111827]">
              <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
                <span className="text-xs font-medium text-slate-300">
                  Active Audio Track:{' '}
                  <span className="text-amber-400">
                    {activeTrack === 'dubbed'
                      ? 'Kurdish Sorani Dubbed (Isolated Background)'
                      : 'Original English'}
                  </span>
                </span>

                <div className="flex items-center gap-1 rounded-lg border border-slate-700 bg-[#0B0F17] p-1">
                  <button
                    type="button"
                    onClick={() => handleSwitchToggleTrack('dubbed')}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      activeTrack === 'dubbed'
                        ? 'bg-amber-500 text-slate-950 font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Kurdish Dubbed
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSwitchToggleTrack('original')}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      activeTrack === 'original'
                        ? 'bg-slate-700 text-slate-100'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Original Video
                  </button>
                </div>
              </div>

              <div className="bg-black">
                <video
                  ref={toggleVideoRef}
                  src={
                    activeTrack === 'dubbed'
                      ? activeEvent.previewUrl
                      : originalVideoUrl
                  }
                  controls
                  playsInline
                  className="mx-auto max-h-[540px] w-full object-contain"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-[#111827] px-5 py-3">
                <button
                  type="button"
                  onClick={handleSyncedPlayPause}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0B0F17] px-4 py-2 text-xs font-medium text-slate-100 hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  {isSyncedPlaying ? (
                    <>
                      <Pause className="h-3.5 w-3.5 text-amber-400" />
                      Pause Synced Comparison
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5 text-amber-400" />
                      Play Both Synced
                    </>
                  )}
                </button>

                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-400">Listen to:</span>
                  <div className="flex items-center gap-1 rounded-lg border border-slate-700 bg-[#0B0F17] p-1">
                    <button
                      type="button"
                      onClick={() => setSideAudioSource('dubbed')}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 ${
                        sideAudioSource === 'dubbed'
                          ? 'bg-amber-500 text-slate-950 font-semibold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Kurdish Audio
                    </button>
                    <button
                      type="button"
                      onClick={() => setSideAudioSource('original')}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 ${
                        sideAudioSource === 'original'
                          ? 'bg-slate-700 text-slate-100'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Original Audio
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#111827]">
                  <div className="border-b border-slate-800 px-4 py-2.5 text-xs font-medium text-slate-300">
                    Original English
                  </div>
                  <div className="bg-black">
                    <video
                      ref={origSyncRef}
                      src={originalVideoUrl}
                      controls
                      playsInline
                      muted={sideAudioSource !== 'original'}
                      onEnded={() => setIsSyncedPlaying(false)}
                      className="aspect-video w-full object-contain"
                    />
                  </div>
                </div>

                <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#111827]">
                  <div className="border-b border-slate-800 px-4 py-2.5 text-xs font-medium text-amber-300">
                    Kurdish Sorani Dubbed
                  </div>
                  <div className="bg-black">
                    <video
                      ref={dubSyncRef}
                      src={activeEvent.previewUrl}
                      controls
                      playsInline
                      muted={sideAudioSource !== 'dubbed'}
                      onEnded={() => setIsSyncedPlaying(false)}
                      className="aspect-video w-full object-contain"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { DubbingOutputStep } from './components/DubbingOutputStep.tsx';
import { SettingsModal } from './components/SettingsModal.tsx';
import { TimelineEditorStep } from './components/TimelineEditorStep.tsx';
import { UploadStep } from './components/UploadStep.tsx';
import type {
  AnalyzeResponse,
  ConfigStatus,
  DubLine,
  DubProgressEvent,
} from './shared/types.ts';

type StudioStep = 1 | 2 | 3;

const PAWAN_STORAGE_KEY = 'soranidub_pawan_api_key';
const PAWAN_FALLBACK_STORAGE_KEY = 'soranidub_pawan_fallback_api_key';

function normalizeKeyList(raw: string): string {
  return raw
    .split(/[\s,;]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .join(',');
}

export default function App() {
  const [step, setStep] = useState<StudioStep>(1);
  const [configStatus, setConfigStatus] = useState<ConfigStatus>({
    hasServerPawanKey: false,
    hasServerFallbackPawanKey: false,
    hasGeminiKey: true,
  });
  const [pawanKeyOverride, setPawanKeyOverride] = useState<string>(() => {
    try {
      return normalizeKeyList(localStorage.getItem(PAWAN_STORAGE_KEY) ?? '');
    } catch {
      return '';
    }
  });
  const [pawanFallbackKeyOverride, setPawanFallbackKeyOverride] = useState<string>(() => {
    try {
      return normalizeKeyList(
        localStorage.getItem(PAWAN_FALLBACK_STORAGE_KEY) ?? ''
      );
    } catch {
      return '';
    }
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Step 1 state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // Step 2 state
  const [videoId, setVideoId] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number>(0);
  const [analyzedFilename, setAnalyzedFilename] = useState<string>('');
  const [lines, setLines] = useState<DubLine[]>([]);

  // Step 3 state
  const [progressEvent, setProgressEvent] = useState<DubProgressEvent | null>(
    null
  );
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const syncKeysAcrossDevices = async () => {
    try {
      // 1. Fetch server config status
      const statusRes = await fetch('/api/config/status');
      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as ConfigStatus;
        setConfigStatus(statusData);
      }

      // 2. Fetch server persistent keys to sync across all devices
      const keysRes = await fetch('/api/config/keys');
      if (keysRes.ok) {
        const keysData = (await keysRes.json()) as {
          keys?: string[];
          count?: number;
          primaryKey?: string;
          fallbackKeys?: string[];
        };

        const serverKeys = Array.isArray(keysData.keys) ? keysData.keys : [];

        if (serverKeys.length > 0) {
          // Server has configured keys -> populate local state & save to this device's localStorage
          const primary = serverKeys[0];
          const fallbacks = serverKeys.slice(1).join(',');
          setPawanKeyOverride(primary);
          setPawanFallbackKeyOverride(fallbacks);
          try {
            localStorage.setItem(PAWAN_STORAGE_KEY, primary);
            if (fallbacks) {
              localStorage.setItem(PAWAN_FALLBACK_STORAGE_KEY, fallbacks);
            } else {
              localStorage.removeItem(PAWAN_FALLBACK_STORAGE_KEY);
            }
          } catch {
            // ignore storage quota errors
          }
        } else {
          // Server has NO keys, but this device might have them in localStorage (e.g. after server reboot)
          let localPrimary = '';
          let localFallback = '';
          try {
            localPrimary = normalizeKeyList(
              localStorage.getItem(PAWAN_STORAGE_KEY) ?? ''
            );
            localFallback = normalizeKeyList(
              localStorage.getItem(PAWAN_FALLBACK_STORAGE_KEY) ?? ''
            );
          } catch {
            // ignore
          }

          const localAll = Array.from(
            new Set(
              [...localPrimary.split(','), ...localFallback.split(',')]
                .map((k) => k.trim())
                .filter(Boolean)
            )
          );

          if (localAll.length > 0) {
            // Re-hydrate server with this device's saved keys
            const restoreRes = await fetch('/api/config/keys', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ keys: localAll }),
            });
            if (restoreRes.ok) {
              setPawanKeyOverride(localAll[0]);
              setPawanFallbackKeyOverride(localAll.slice(1).join(','));
              fetch('/api/config/status')
                .then((r) => (r.ok ? r.json() : null))
                .then((s) => {
                  if (s) setConfigStatus(s);
                })
                .catch(() => {});
            }
          }
        }
      }
    } catch (err) {
      console.warn('Failed to sync keys across devices on startup:', err);
    }
  };

  useEffect(() => {
    void syncKeysAcrossDevices();
  }, []);

  useEffect(() => {
    return () => {
      if (localPreviewUrl) {
        URL.revokeObjectURL(localPreviewUrl);
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
      }
    };
  }, [localPreviewUrl]);

  const stopProgressListeners = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const handleSavePawanKeys = (key: string, fallbackKey: string) => {
    const cleanPrimary = normalizeKeyList(key);
    const cleanFallback = normalizeKeyList(fallbackKey);
    setPawanKeyOverride(cleanPrimary);
    setPawanFallbackKeyOverride(cleanFallback);
    try {
      if (cleanPrimary) {
        localStorage.setItem(PAWAN_STORAGE_KEY, cleanPrimary);
      } else {
        localStorage.removeItem(PAWAN_STORAGE_KEY);
      }
      if (cleanFallback) {
        localStorage.setItem(PAWAN_FALLBACK_STORAGE_KEY, cleanFallback);
      } else {
        localStorage.removeItem(PAWAN_FALLBACK_STORAGE_KEY);
      }
    } catch {
      // ignore storage quota errors
    }
  };

  const handleSelectFile = (file: File) => {
    if (localPreviewUrl) {
      URL.revokeObjectURL(localPreviewUrl);
    }
    const url = URL.createObjectURL(file);
    setSelectedFile(file);
    setLocalPreviewUrl(url);
    setAnalyzeError(null);
    // Reset downstream project state when replacing source video
    setVideoId(null);
    setLines([]);
    setProgressEvent(null);
  };

  const handleAnalyze = async () => {
    if (!selectedFile) return;
    setIsAnalyzing(true);
    setAnalyzeError(null);

    try {
      const formData = new FormData();
      formData.append('video', selectedFile);

      const response = await fetch('/api/analyze', {
        method: 'POST',
        body: formData,
      });

      if (response.status === 413) {
        throw new Error(
          'Video file exceeds the 32 MB upload limit of the hosting proxy. Please upload a smaller or compressed MP4 clip.'
        );
      }

      const body = (await response.json().catch(() => ({}))) as Partial<
        AnalyzeResponse
      > & { error?: string };

      if (!response.ok || !body.videoId) {
        throw new Error(body.error || 'Video analysis failed.');
      }

      setVideoId(body.videoId);
      setVideoDuration(body.duration ?? 0);
      setAnalyzedFilename(body.filename || selectedFile.name);
      setLines(body.lines ?? []);
      setProgressEvent(null);
      setStep(2);
    } catch (error) {
      setAnalyzeError(
        error instanceof Error
          ? error.message
          : 'Failed to analyze video with Gemini.'
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  const startPollingStatus = (jobId: string) => {
    if (pollTimerRef.current !== null) return;
    let consecutiveErrors = 0;

    const pollOnce = async () => {
      try {
        const res = await fetch(`/api/dub/status/${jobId}`, {
          cache: 'no-store',
        });
        if (res.status === 404) {
          stopProgressListeners();
          setProgressEvent((prev) => {
            if (prev?.stage === 'done' || prev?.stage === 'error') return prev;
            return {
              jobId,
              stage: 'error',
              progress: 0,
              completedLines: 0,
              totalLines: lines.length,
              message:
                'The server session restarted while rendering. Please click Retry Dubbing (or re-upload if needed).',
              error:
                'The server session restarted while rendering. Please click Retry Dubbing.',
            };
          });
          return;
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        consecutiveErrors = 0;
        const parsed = (await res.json()) as DubProgressEvent;
        setProgressEvent(parsed);
        if (parsed.stage === 'done' || parsed.stage === 'error') {
          stopProgressListeners();
        }
      } catch {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 8) {
          stopProgressListeners();
          setProgressEvent((prev) => {
            if (prev?.stage === 'done' || prev?.stage === 'error') return prev;
            return {
              jobId,
              stage: 'error',
              progress: 0,
              completedLines: prev?.completedLines ?? 0,
              totalLines: lines.length,
              message: 'Lost connection to the dubbing server. Please retry.',
              error: 'Lost connection to the dubbing server. Please retry.',
            };
          });
        }
      }
    };

    void pollOnce();
    pollTimerRef.current = window.setInterval(() => {
      void pollOnce();
    }, 1200);
  };

  const handleStartDubbing = async () => {
    if (!videoId) return;

    stopProgressListeners();

    setStep(3);
    setProgressEvent({
      jobId: 'pending',
      stage: 'queued',
      progress: 2,
      completedLines: 0,
      totalLines: lines.length,
      message: 'Starting Pawan.Krd synthesis and MDX-Net vocal removal...',
    });

    try {
      const cleanPrimaryHeader = normalizeKeyList(pawanKeyOverride);
      const cleanFallbackHeader = normalizeKeyList(pawanFallbackKeyOverride);
      const response = await fetch('/api/dub', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(cleanPrimaryHeader
            ? { 'x-pawan-api-key': cleanPrimaryHeader }
            : {}),
          ...(cleanFallbackHeader
            ? { 'x-pawan-fallback-api-key': cleanFallbackHeader }
            : {}),
        },
        body: JSON.stringify({
          videoId,
          lines,
          pawanApiKey: cleanPrimaryHeader || undefined,
          pawanFallbackApiKey: cleanFallbackHeader || undefined,
        }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        jobId?: string;
        error?: string;
      };

      if (!response.ok || !data.jobId) {
        throw new Error(data.error || 'Could not start dubbing job.');
      }

      const jobId = data.jobId;
      const es = new EventSource(`/api/dub/progress/${jobId}`);
      eventSourceRef.current = es;

      es.onmessage = (msg) => {
        try {
          const parsed = JSON.parse(msg.data) as DubProgressEvent;
          setProgressEvent(parsed);
          if (parsed.stage === 'done' || parsed.stage === 'error') {
            stopProgressListeners();
          }
        } catch {
          // ignore malformed heartbeat
        }
      };

      es.onerror = () => {
        // Proxy or network hiccup on SSE: seamlessly fall back to reliable HTTP status polling
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        startPollingStatus(jobId);
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to start dubbing.';
      setProgressEvent({
        jobId: 'error',
        stage: 'error',
        progress: 0,
        completedLines: 0,
        totalLines: lines.length,
        message,
        error: message,
      });
    }
  };

  const canVisitStep2 = Boolean(videoId);
  const canVisitStep3 = Boolean(videoId && progressEvent);

  const activeVideoUrl =
    localPreviewUrl || (videoId ? `/api/source/video/${videoId}` : '');

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      {/* 3-Zone Top Bar Contract */}
      <header className="border-b border-slate-800/90 bg-[#0B0F17]/95 backdrop-blur-xs">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-8 px-6 py-4">
          {/* Zone 1: Single text element wordmark */}
          <button
            type="button"
            onClick={() => setStep(1)}
            className="text-base font-bold tracking-tight text-slate-100 hover:text-amber-400 transition-colors whitespace-nowrap shrink-0"
          >
            SoraniDub Studio
          </button>

          {/* Zone 2: Stepper links */}
          <nav
            aria-label="Dubbing workflow steps"
            className="hidden md:flex items-center gap-7 text-xs font-medium"
          >
            <button
              type="button"
              onClick={() => setStep(1)}
              className={`pb-0.5 transition-colors whitespace-nowrap shrink-0 ${
                step === 1
                  ? 'border-b border-amber-400 text-amber-400'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              01. Upload &amp; Analyze
            </button>
            <button
              type="button"
              disabled={!canVisitStep2}
              onClick={() => canVisitStep2 && setStep(2)}
              className={`pb-0.5 transition-colors whitespace-nowrap shrink-0 disabled:cursor-not-allowed disabled:opacity-40 ${
                step === 2
                  ? 'border-b border-amber-400 text-amber-400'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              02. Timeline Editor
            </button>
            <button
              type="button"
              disabled={!canVisitStep3}
              onClick={() => canVisitStep3 && setStep(3)}
              className={`pb-0.5 transition-colors whitespace-nowrap shrink-0 disabled:cursor-not-allowed disabled:opacity-40 ${
                step === 3
                  ? 'border-b border-amber-400 text-amber-400'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              03. Dub &amp; Export
            </button>
          </nav>

          {/* Zone 3: Primary action */}
          <div className="shrink-0">
            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              className="rounded-lg border border-slate-700 bg-[#111827] px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              API Settings
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Stepper */}
      <div className="flex items-center justify-center gap-4 border-b border-slate-800/80 px-4 py-2.5 text-xs md:hidden">
        <button
          type="button"
          onClick={() => setStep(1)}
          className={`whitespace-nowrap shrink-0 ${
            step === 1 ? 'font-semibold text-amber-400' : 'text-slate-400'
          }`}
        >
          01. Upload
        </button>
        <span className="text-slate-700">/</span>
        <button
          type="button"
          disabled={!canVisitStep2}
          onClick={() => canVisitStep2 && setStep(2)}
          className={`whitespace-nowrap shrink-0 disabled:opacity-40 ${
            step === 2 ? 'font-semibold text-amber-400' : 'text-slate-400'
          }`}
        >
          02. Timeline
        </button>
        <span className="text-slate-700">/</span>
        <button
          type="button"
          disabled={!canVisitStep3}
          onClick={() => canVisitStep3 && setStep(3)}
          className={`whitespace-nowrap shrink-0 disabled:opacity-40 ${
            step === 3 ? 'font-semibold text-amber-400' : 'text-slate-400'
          }`}
        >
          03. Export
        </button>
      </div>

      {/* Main Studio Workspace */}
      <main className="flex-1 px-4 py-8 sm:px-6 lg:px-8">
        {step === 1 && (
          <UploadStep
            selectedFile={selectedFile}
            previewUrl={localPreviewUrl}
            isAnalyzing={isAnalyzing}
            analyzeError={analyzeError}
            hasExistingAnalysis={Boolean(videoId)}
            onSelectFile={handleSelectFile}
            onAnalyze={() => void handleAnalyze()}
            onGoToTimeline={() => setStep(2)}
          />
        )}

        {step === 2 && videoId && (
          <TimelineEditorStep
            videoUrl={activeVideoUrl}
            filename={analyzedFilename}
            videoDuration={videoDuration}
            lines={lines}
            pawanKeyOverride={pawanKeyOverride}
            pawanFallbackKeyOverride={pawanFallbackKeyOverride}
            onUpdateLines={setLines}
            onStartDubbing={() => void handleStartDubbing()}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        )}

        {step === 3 && videoId && (
          <DubbingOutputStep
            originalVideoUrl={activeVideoUrl}
            progressEvent={progressEvent}
            onBackToTimeline={() => setStep(2)}
            onRetryDubbing={() => void handleStartDubbing()}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        )}
      </main>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        configStatus={configStatus}
        pawanKeyOverride={pawanKeyOverride}
        pawanFallbackKeyOverride={pawanFallbackKeyOverride}
        onSavePawanKeys={handleSavePawanKeys}
        onKeysUpdated={() => void syncKeysAcrossDevices()}
      />
    </div>
  );
}

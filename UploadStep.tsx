import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Film,
  HeartPulse,
  Languages,
  Loader2,
  RefreshCw,
  Scan,
  Sparkles,
  Upload,
  Volume2,
  Zap,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';

interface UploadStepProps {
  selectedFile: File | null;
  previewUrl: string | null;
  isAnalyzing: boolean;
  analyzeError: string | null;
  hasExistingAnalysis: boolean;
  onSelectFile: (file: File) => void;
  onAnalyze: () => void;
  onGoToTimeline: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

interface AnalysisStage {
  stepNumber: number;
  label: string;
  sublabel: string;
  icon: typeof Sparkles;
  pillText?: string;
}

function getActiveStage(progress: number): AnalysisStage {
  if (progress < 22) {
    return {
      stepNumber: 1,
      label: 'Uploading Video & Audio Channel',
      sublabel: 'Streaming media frames to Gemini 2.5 Flash multimodal pipeline...',
      icon: Upload,
      pillText: 'Frame Ingestion',
    };
  }
  if (progress < 48) {
    return {
      stepNumber: 2,
      label: 'Transcribing Speech & Timestamps',
      sublabel: 'Segmenting dialogue sentences with millisecond start/end precision...',
      icon: Volume2,
      pillText: 'Audio Diarization',
    };
  }
  if (progress < 72) {
    return {
      stepNumber: 3,
      label: 'Detecting Emotions & Vocal Moods',
      sublabel: 'Classifying vocal moods (cheerful, angry, shouting, whispering, calm) & gender...',
      icon: HeartPulse,
      pillText: 'Emotion & Energy Mapping',
    };
  }
  if (progress < 90) {
    return {
      stepNumber: 4,
      label: 'Translating into Natural Kurdish Sorani',
      sublabel: 'Generating culturally natural Sorani phrasing matched to speech duration...',
      icon: Languages,
      pillText: 'Syllable Matching',
    };
  }
  return {
    stepNumber: 5,
    label: 'Finalizing Lip Sync & Audio Pipeline',
    sublabel: 'Validating timestamps and initializing neural vocal isolation model...',
    icon: Sparkles,
    pillText: 'Pipeline Ready',
  };
}

const ANALYSIS_PIPELINE_STEPS = [
  { step: 1, label: 'Upload' },
  { step: 2, label: 'Speech' },
  { step: 3, label: 'Emotions' },
  { step: 4, label: 'Sorani' },
  { step: 5, label: 'Sync' },
];

export function UploadStep({
  selectedFile,
  previewUrl,
  isAnalyzing,
  analyzeError,
  hasExistingAnalysis,
  onSelectFile,
  onAnalyze,
  onGoToTimeline,
}: UploadStepProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [videoDuration, setVideoDuration] = useState<number>(0);

  // Dynamic progress state for "Analyze Video & Emotions"
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!isAnalyzing) {
      setAnalysisProgress(0);
      setElapsedSeconds(0);
      return;
    }

    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      setElapsedSeconds(Math.floor(elapsed));

      // Asymptotic realistic progression curve matching Gemini multimodal latency
      setAnalysisProgress(() => {
        if (elapsed < 3) return Math.min(20, Math.round(elapsed * 6.6));
        if (elapsed < 8) return Math.min(48, Math.round(20 + (elapsed - 3) * 5.6));
        if (elapsed < 16) return Math.min(72, Math.round(48 + (elapsed - 8) * 3.0));
        if (elapsed < 26) return Math.min(90, Math.round(72 + (elapsed - 16) * 1.8));
        return Math.min(97, Math.round(90 + (elapsed - 26) * 0.5));
      });
    }, 200);

    return () => clearInterval(interval);
  }, [isAnalyzing]);

  const activeStage = getActiveStage(analysisProgress);
  const StageIcon = activeStage.icon;

  const acceptFile = (file: File | undefined) => {
    if (!file) return;
    const ext = file.name.toLowerCase();
    const isAllowed =
      file.type.startsWith('video/') ||
      ext.endsWith('.mp4') ||
      ext.endsWith('.mov') ||
      ext.endsWith('.webm');
    if (!isAllowed) return;
    onSelectFile(file);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    acceptFile(e.dataTransfer.files?.[0]);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    acceptFile(e.target.files?.[0]);
  };

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100 text-balance">
            Upload English Video &amp; Extract Sorani Script
          </h1>
          <p className="mt-1.5 text-sm text-slate-400">
            Upload an MP4, MOV, or WEBM clip. Gemini transcribes dialogue with exact timestamps, classifies speaker gender &amp; emotions, and generates syllable-matched Kurdish Sorani lines.
          </p>
        </div>
        {hasExistingAnalysis && !isAnalyzing && (
          <button
            type="button"
            onClick={onGoToTimeline}
            className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            Return to Timeline Editor
          </button>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
        onChange={handleFileChange}
        className="hidden"
      />

      {!selectedFile || !previewUrl ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          className={`flex min-h-[340px] cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed transition-colors p-8 text-center ${
            isDragging
              ? 'border-amber-500 bg-amber-500/5'
              : 'border-slate-700 bg-[#111827] hover:border-slate-600 hover:bg-[#141C2D]'
          }`}
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-slate-700 bg-[#0B0F17] text-amber-400">
            <Upload className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-base font-medium text-slate-100">
            Drop your English video here, or browse files
          </h2>
          <p className="mt-2 text-xs text-slate-400">
            Supports MP4, MOV, and WEBM (up to 32 MB)
          </p>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
            className="mt-6 rounded-lg border border-slate-700 bg-[#0B0F17] px-4 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            Select Video File
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-[#111827] overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-12 items-stretch">
            {/* Video Player Preview Column with Laser Scan Effect during Analysis */}
            <div className="relative lg:col-span-7 bg-black flex items-center justify-center border-b lg:border-b-0 lg:border-r border-slate-800 overflow-hidden">
              <video
                src={previewUrl}
                controls={!isAnalyzing}
                playsInline
                onLoadedMetadata={(e) =>
                  setVideoDuration(e.currentTarget.duration || 0)
                }
                className="max-h-[420px] w-full object-contain"
              />

              {/* Active AI Scanning Overlay during Video & Emotion Analysis */}
              {isAnalyzing && (
                <div className="absolute inset-0 pointer-events-none bg-black/40 backdrop-blur-[1px] flex flex-col justify-between p-4 z-10">
                  <div className="flex items-center justify-between">
                    <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/40 bg-black/85 px-3 py-1 text-xs font-medium text-amber-300 shadow-xl backdrop-blur-md">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                      </span>
                      <span className="font-semibold">AI Video &amp; Emotion Analysis</span>
                    </div>

                    <div className="flex items-center gap-2 rounded-md bg-black/85 px-2.5 py-1 font-mono text-xs text-amber-400 border border-slate-800 backdrop-blur-md">
                      <Scan className="h-3 w-3 animate-spin text-amber-400" />
                      <span>{analysisProgress}%</span>
                    </div>
                  </div>

                  {/* Horizontal Glowing Laser Scanning Line */}
                  <div className="absolute left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-amber-400 to-transparent shadow-[0_0_18px_#f59e0b] animate-scanline" />

                  <div className="flex items-center justify-between text-xs bg-black/85 rounded-lg px-3.5 py-2 border border-slate-800 backdrop-blur-md">
                    <span className="flex items-center gap-1.5 font-medium text-amber-300">
                      <HeartPulse className="h-3.5 w-3.5 text-amber-400 animate-pulse" />
                      <span>Detecting vocal energy &amp; emotions...</span>
                    </span>
                    <span className="font-mono text-slate-400">{elapsedSeconds}s</span>
                  </div>
                </div>
              )}
            </div>

            {/* Video Details & Actions Column */}
            <div className="lg:col-span-5 flex flex-col justify-between p-6 space-y-6">
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Film className="h-4 w-4 text-amber-400 shrink-0" />
                    <span className="truncate text-sm font-medium text-slate-100">
                      {selectedFile.name}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={isAnalyzing}
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Replace
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono-tabular">
                  <span>{formatBytes(selectedFile.size)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatDuration(videoDuration)}</span>
                  <span aria-hidden="true">·</span>
                  <span className="uppercase">
                    {selectedFile.name.split('.').pop() || 'VIDEO'}
                  </span>
                </div>

                <div className="border-t border-slate-800 pt-4 space-y-2.5 text-xs text-slate-400 leading-relaxed">
                  <p className="text-slate-300 font-medium flex items-center gap-1.5">
                    <Zap className="h-3.5 w-3.5 text-amber-400" />
                    Multimodal Analysis Features:
                  </p>
                  <p className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                    <span>Exact speech timestamps with zero drift</span>
                  </p>
                  <p className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                    <span>Vocal emotion &amp; mood classification</span>
                  </p>
                  <p className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                    <span>Expressive Sorani Kurdish translation</span>
                  </p>
                </div>
              </div>

              {/* Action Area with Dynamic Loading Line */}
              <div className="space-y-4 pt-2">
                {analyzeError && (
                  <div className="flex items-start gap-2.5 rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-200">
                    <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                    <span>{analyzeError}</span>
                  </div>
                )}

                {/* THE LOADING LINE FOR ANALYZE VIDEO & EMOTIONS */}
                {isAnalyzing ? (
                  <div className="space-y-3.5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4.5 animate-in fade-in duration-300">
                    {/* Header with Step and Active Label */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400 shrink-0">
                          <StageIcon className="h-3.5 w-3.5 animate-pulse" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-100 truncate">
                            {activeStage.label}
                          </div>
                          <div className="text-[11px] text-amber-400/90 font-mono">
                            Stage {activeStage.stepNumber} of 5 · {activeStage.pillText}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-mono text-sm font-bold text-amber-400 tabular-nums">
                          {analysisProgress}%
                        </span>
                      </div>
                    </div>

                    {/* Glowing Progress Loading Line */}
                    <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-slate-800 shadow-inner">
                      {/* Gradient Fill with Glow */}
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-amber-500 via-orange-400 to-amber-300 transition-all duration-300 ease-out shadow-[0_0_14px_rgba(245,158,11,0.7)]"
                        style={{ width: `${analysisProgress}%` }}
                      />
                      {/* Animated Shimmer Reflection traveling along the line */}
                      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/25 to-transparent animate-shimmer" />
                    </div>

                    {/* Step Pipeline Indicators */}
                    <div className="grid grid-cols-5 gap-1 pt-1">
                      {ANALYSIS_PIPELINE_STEPS.map((pipe) => {
                        const isDone = activeStage.stepNumber > pipe.step;
                        const isCurrent = activeStage.stepNumber === pipe.step;
                        return (
                          <div key={pipe.step} className="flex flex-col items-center gap-1">
                            <div
                              className={`h-1.5 w-full rounded-full transition-all duration-300 ${
                                isDone
                                  ? 'bg-amber-400'
                                  : isCurrent
                                  ? 'bg-amber-400 animate-pulse'
                                  : 'bg-slate-800'
                              }`}
                            />
                            <span
                              className={`text-[10px] font-mono tracking-tight ${
                                isCurrent
                                  ? 'font-bold text-amber-400'
                                  : isDone
                                  ? 'text-slate-300'
                                  : 'text-slate-600'
                              }`}
                            >
                              {pipe.label}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Subtitle & Elapsed Timer */}
                    <div className="flex items-center justify-between pt-1 text-[11px] text-slate-400 border-t border-slate-800/80">
                      <span className="truncate pr-2 text-slate-300">
                        {activeStage.sublabel}
                      </span>
                      <span className="flex items-center gap-1 font-mono text-slate-400 shrink-0">
                        <Clock className="h-3 w-3 text-amber-400/80" />
                        <span>{elapsedSeconds}s</span>
                      </span>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={onAnalyze}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-3.5 text-sm font-semibold text-slate-950 transition-all hover:bg-amber-400 hover:shadow-[0_0_20px_rgba(245,158,11,0.3)] whitespace-nowrap shrink-0 active:scale-[0.99]"
                  >
                    <Sparkles className="h-4 w-4" />
                    <span>Analyze Video &amp; Emotions</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

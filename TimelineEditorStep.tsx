import {
  AlertCircle,
  Check,
  Loader2,
  Mic,
  Play,
  Plus,
  Square,
  Trash2,
  User,
  Users,
  Volume2,
  Wand2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  EMOTION_OPTIONS,
  FEMALE_VOICES,
  getDefaultVoiceForGender,
  getEmotionConfig,
  MALE_VOICES,
  type DubLine,
  type PawanVoice,
  type SpeakerEmotion,
  type SpeakerGender,
} from '../shared/types.ts';

interface TimelineEditorStepProps {
  videoUrl: string;
  filename: string;
  videoDuration: number;
  lines: DubLine[];
  pawanKeyOverride: string;
  pawanFallbackKeyOverride: string;
  onUpdateLines: (lines: DubLine[]) => void;
  onStartDubbing: () => void;
  onOpenSettings: () => void;
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.0';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds % 1) * 10);
  return `${mins.toString().padStart(2, '0')}:${secs
    .toString()
    .padStart(2, '0')}.${tenths}`;
}

export function TimelineEditorStep({
  videoUrl,
  filename,
  videoDuration,
  lines,
  pawanKeyOverride,
  pawanFallbackKeyOverride,
  onUpdateLines,
  onStartDubbing,
  onOpenSettings,
}: TimelineEditorStepProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioObjectUrlRef = useRef<string | null>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(
    lines[0]?.id ?? null
  );
  const [previewingLineId, setPreviewingLineId] = useState<string | null>(null);
  const [loadingPreviewId, setLoadingPreviewId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      if (audioObjectUrlRef.current) {
        URL.revokeObjectURL(audioObjectUrlRef.current);
      }
    };
  }, []);

  const stopPreviewAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = null;
    }
    setPreviewingLineId(null);
  };

  const seekToLine = (line: DubLine) => {
    setSelectedLineId(line.id);
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, line.start_time);
      void videoRef.current.play().catch(() => {});
    }
  };

  const handleUpdateLine = (id: string, patch: Partial<DubLine>) => {
    onUpdateLines(
      lines.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  };

  const handleToggleGender = (line: DubLine) => {
    const nextGender: SpeakerGender = line.gender === 'male' ? 'female' : 'male';
    const currentVoiceMatchesNext =
      nextGender === 'male'
        ? (MALE_VOICES as readonly string[]).includes(line.voice)
        : (FEMALE_VOICES as readonly string[]).includes(line.voice);

    handleUpdateLine(line.id, {
      gender: nextGender,
      voice: currentVoiceMatchesNext
        ? line.voice
        : getDefaultVoiceForGender(nextGender),
    });
  };

  const handleAddLine = () => {
    const lastLine = lines[lines.length - 1];
    const start = lastLine
      ? Number((lastLine.end_time + 0.3).toFixed(2))
      : 0;
    const end = Number(
      Math.min(videoDuration || start + 3, start + 2.5).toFixed(2)
    );
    const newLine: DubLine = {
      id: crypto.randomUUID(),
      start_time: start,
      end_time: end > start ? end : Number((start + 1.5).toFixed(2)),
      gender: 'male',
      emotion: 'neutral',
      speaker_type: 'human',
      voice: 'aram',
      english_text: 'Custom added line',
      kurdish_sorani: '',
    };
    onUpdateLines([...lines, newLine]);
    setSelectedLineId(newLine.id);
  };

  const handleDeleteLine = (id: string) => {
    if (previewingLineId === id) {
      stopPreviewAudio();
    }
    onUpdateLines(lines.filter((item) => item.id !== id));
  };

  const handlePreviewVoice = async (line: DubLine) => {
    setPreviewError(null);

    if (previewingLineId === line.id) {
      stopPreviewAudio();
      return;
    }

    stopPreviewAudio();

    if (!line.kurdish_sorani.trim()) {
      setPreviewError('Enter Kurdish Sorani text on this line before previewing.');
      return;
    }

    const emotionCfg = getEmotionConfig(line.emotion);

    setLoadingPreviewId(line.id);
    try {
      const cleanPrimaryKey = pawanKeyOverride
        .split(/[\s,;]+/)
        .map((k) => k.trim())
        .filter(Boolean)
        .join(',');
      const cleanFallbackKey = pawanFallbackKeyOverride
        .split(/[\s,;]+/)
        .map((k) => k.trim())
        .filter(Boolean)
        .join(',');
      const response = await fetch('/api/tts/preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(cleanPrimaryKey ? { 'x-pawan-api-key': cleanPrimaryKey } : {}),
          ...(cleanFallbackKey
            ? { 'x-pawan-fallback-api-key': cleanFallbackKey }
            : {}),
        },
        body: JSON.stringify({
          text: line.kurdish_sorani,
          voice: line.voice,
          emotion: emotionCfg.value,
          speed: emotionCfg.ttsSpeed,
          pawanApiKey: cleanPrimaryKey || undefined,
          pawanFallbackApiKey: cleanFallbackKey || undefined,
        }),
      });

      if (!response.ok) {
        const errBody = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errBody.error || `Preview failed with status ${response.status}`
        );
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      audioObjectUrlRef.current = url;

      const audio = new Audio(url);
      audioRef.current = audio;
      setPreviewingLineId(line.id);

      audio.onended = () => {
        setPreviewingLineId(null);
      };
      audio.onerror = () => {
        setPreviewingLineId(null);
        setPreviewError('Browser could not play the preview audio stream.');
      };

      await audio.play();
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : 'Failed to generate voice preview.';
      setPreviewError(msg);
      setPreviewingLineId(null);
    } finally {
      setLoadingPreviewId(null);
    }
  };

  const [appliedNotification, setAppliedNotification] = useState<string | null>(null);

  const insertPunctuation = (lineId: string, char: string) => {
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    const textarea = document.getElementById(`sorani-${lineId}`) as HTMLTextAreaElement | null;
    if (textarea) {
      const start = textarea.selectionStart ?? line.kurdish_sorani.length;
      const end = textarea.selectionEnd ?? line.kurdish_sorani.length;
      const current = line.kurdish_sorani;
      const updated = current.slice(0, start) + char + current.slice(end);
      handleUpdateLine(lineId, { kurdish_sorani: updated });
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(start + char.length, start + char.length);
      }, 10);
    } else {
      handleUpdateLine(lineId, { kurdish_sorani: line.kurdish_sorani + char });
    }
  };

  const handleApplyVoiceToSpeaker = (targetSpeaker: string, voice: PawanVoice) => {
    let count = 0;
    const updated = lines.map((item) => {
      const spk = item.speaker_name || (item.gender === 'female' ? 'Female Character' : 'Male Character');
      if (spk === targetSpeaker) {
        count++;
        return { ...item, voice };
      }
      return item;
    });
    onUpdateLines(updated);
    setAppliedNotification(`Assigned "${voice}" to ${count} line${count === 1 ? '' : 's'} for ${targetSpeaker}`);
    setTimeout(() => setAppliedNotification(null), 3000);
  };

  const activePlaybackLineId = lines.find(
    (l) => currentTime >= l.start_time && currentTime <= l.end_time
  )?.id;

  const totalSpeechSec = lines.reduce(
    (acc, line) => acc + Math.max(0, line.end_time - line.start_time),
    0
  );

  const uniqueSpeakers = Array.from(
    new Set(
      lines.map(
        (l) => l.speaker_name || (l.gender === 'female' ? 'Female Character' : 'Male Character')
      )
    )
  );

  const canGenerateDub = lines.some(
    (line) => line.preserve_original || line.kurdish_sorani.trim().length > 0
  );

  return (
    <section className="mx-auto max-w-[1400px] space-y-6">
      <div className="flex flex-col gap-4 border-b border-slate-800 pb-5 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">
            Timeline, Emotion &amp; Voice Casting Editor
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="truncate max-w-[280px] text-slate-300">{filename}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular">{lines.length} lines</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular">
              {totalSpeechSec.toFixed(1)}s dialogue
            </span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1 text-amber-400/90 font-medium">
              <Users className="h-3.5 w-3.5" />
              {uniqueSpeakers.length} cast character{uniqueSpeakers.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleAddLine}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#111827] px-3.5 py-2.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Line
          </button>

          <button
            type="button"
            disabled={!canGenerateDub}
            onClick={() => {
              stopPreviewAudio();
              onStartDubbing();
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-5 py-2.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Wand2 className="h-4 w-4" />
            Generate Dubbed Video with Isolated Background
          </button>
        </div>
      </div>

      {appliedNotification && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-950/20 px-4 py-2 text-xs text-amber-200">
          <Check className="h-3.5 w-3.5 text-amber-400 shrink-0" />
          <span>{appliedNotification}</span>
        </div>
      )}

      {previewError && (
        <div className="flex flex-col gap-3 rounded-xl border border-red-500/40 bg-red-950/30 p-4 text-xs text-red-200 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
            <span>{previewError}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {previewError.toLowerCase().includes('key') && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="rounded-lg border border-red-400/40 bg-red-900/40 px-3 py-1.5 text-xs font-medium text-red-100 hover:bg-red-900/70 whitespace-nowrap shrink-0"
              >
                Open API Settings
              </button>
            )}
            <button
              type="button"
              onClick={() => setPreviewError(null)}
              className="rounded-lg px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-900/40 whitespace-nowrap shrink-0"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Left Sticky Video Preview */}
        <div className="lg:col-span-5 lg:sticky lg:top-6 space-y-3">
          <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#111827]">
            <div className="bg-black">
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                playsInline
                onTimeUpdate={(e) =>
                  setCurrentTime(e.currentTarget.currentTime)
                }
                className="aspect-video w-full object-contain"
              />
            </div>

            <div className="flex items-center justify-between border-t border-slate-800 px-4 py-3 text-xs">
              <span className="text-slate-400">
                Click any line on the right to jump playhead
              </span>
              <span className="font-mono-tabular text-amber-400">
                {formatClock(currentTime)} / {formatClock(videoDuration)}
              </span>
            </div>
          </div>
        </div>

        {/* Right Sentence-by-Sentence Timeline & Emotion Editor */}
        <div className="lg:col-span-7 space-y-3">
          {lines.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-[#111827] p-10 text-center">
              <p className="text-sm font-medium text-slate-200">
                No spoken sentences detected in this video.
              </p>
              <p className="mt-1.5 text-xs text-slate-400">
                You can manually add a dialogue line to synthesize custom Kurdish Sorani narration.
              </p>
              <button
                type="button"
                onClick={handleAddLine}
                className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
              >
                <Plus className="h-3.5 w-3.5" />
                Add First Line
              </button>
            </div>
          ) : (
            <>
              {uniqueSpeakers.length > 1 && (
                <div className="rounded-xl border border-slate-800 bg-[#111827] p-4 text-xs space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-medium text-slate-200">
                      <Users className="h-4 w-4 text-amber-400" />
                      <span>Cast Characters ({uniqueSpeakers.length})</span>
                    </div>
                    <span className="text-slate-400 text-[11px]">
                      Auto-cast distinct voices per character
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {uniqueSpeakers.map((spk) => {
                      const spkLines = lines.filter(
                        (l) =>
                          (l.speaker_name ||
                            (l.gender === 'female'
                              ? 'Female Character'
                              : 'Male Character')) === spk
                      );
                      const currentVoice = spkLines[0]?.voice ?? 'aram';
                      const isFemale = spkLines[0]?.gender === 'female';
                      return (
                        <div
                          key={spk}
                          className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-[#0B0F17] p-2.5"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-medium text-slate-200">
                              {spk}
                            </p>
                            <p className="text-[11px] text-slate-400 font-mono-tabular">
                              {spkLines.length} line
                              {spkLines.length === 1 ? '' : 's'} ·{' '}
                              {isFemale ? 'Female' : 'Male'}
                            </p>
                          </div>
                          <select
                            aria-label={`Select voice for ${spk}`}
                            value={currentVoice}
                            onChange={(e) =>
                              handleApplyVoiceToSpeaker(
                                spk,
                                e.target.value as PawanVoice
                              )
                            }
                            className="rounded-md border border-slate-700 bg-[#111827] px-2 py-1 text-xs text-slate-100 capitalize focus:border-amber-500 focus:outline-none shrink-0"
                          >
                            <optgroup label="Male Voices">
                              {MALE_VOICES.map((v) => (
                                <option key={v} value={v}>
                                  {v} (Male)
                                </option>
                              ))}
                            </optgroup>
                            <optgroup label="Female Voices">
                              {FEMALE_VOICES.map((v) => (
                                <option key={v} value={v}>
                                  {v} (Female)
                                </option>
                              ))}
                            </optgroup>
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="divide-y divide-slate-800/90 overflow-hidden rounded-xl border border-slate-800 bg-[#111827]">
                {lines.map((line, index) => {
                  const isActive =
                    activePlaybackLineId === line.id || selectedLineId === line.id;
                  const slotDuration = Math.max(
                    0,
                    line.end_time - line.start_time
                  );
                  const emotionCfg = getEmotionConfig(line.emotion);
                  const isPreviewLoading = loadingPreviewId === line.id;
                  const isPlayingPreview = previewingLineId === line.id;
                  const speakerLabel =
                    line.speaker_name ||
                    (line.gender === 'female'
                      ? 'Female Character'
                      : 'Male Character');
                  const sameSpeakerLines = lines.filter(
                    (l) =>
                      (l.speaker_name ||
                        (l.gender === 'female'
                          ? 'Female Character'
                          : 'Male Character')) === speakerLabel
                  );

                  return (
                    <div
                      key={line.id}
                      onClick={(e) => {
                        const target = e.target as HTMLElement;
                        if (
                          target.closest('input, textarea, select, button')
                        ) {
                          return;
                        }
                        seekToLine(line);
                      }}
                      className={`p-4 sm:p-5 transition-colors cursor-pointer ${
                        isActive ? 'bg-[#161F31]' : 'hover:bg-[#141C2B]'
                      }`}
                    >
                      {/* Top Control Strip */}
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2.5">
                          <button
                            type="button"
                            onClick={() => seekToLine(line)}
                            title="Jump video to this timestamp"
                            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-[#0B0F17] px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-amber-500/60 hover:text-amber-300 font-mono-tabular whitespace-nowrap shrink-0"
                          >
                            <Play className="h-3 w-3 text-amber-400" />
                            #{(index + 1).toString().padStart(2, '0')}
                          </button>

                          {/* Editable Start / End Timestamps */}
                          <div className="flex items-center gap-1.5 text-xs">
                            <label
                              className="sr-only"
                              htmlFor={`start-${line.id}`}
                            >
                              Start seconds
                            </label>
                            <input
                              id={`start-${line.id}`}
                              type="number"
                              step="0.05"
                              min="0"
                              value={line.start_time}
                              onChange={(e) =>
                                handleUpdateLine(line.id, {
                                  start_time: Math.max(
                                    0,
                                    Number(e.target.value) || 0
                                  ),
                                })
                              }
                              className="w-[70px] rounded-md border border-slate-700 bg-[#0B0F17] px-2 py-1 text-xs text-slate-100 font-mono-tabular focus:border-amber-500 focus:outline-none"
                            />
                            <span className="text-slate-500">to</span>
                            <label
                              className="sr-only"
                              htmlFor={`end-${line.id}`}
                            >
                              End seconds
                            </label>
                            <input
                              id={`end-${line.id}`}
                              type="number"
                              step="0.05"
                              min="0"
                              value={line.end_time}
                              onChange={(e) =>
                                handleUpdateLine(line.id, {
                                  end_time: Math.max(
                                    line.start_time + 0.1,
                                    Number(e.target.value) || 0
                                  ),
                                })
                              }
                              className="w-[70px] rounded-md border border-slate-700 bg-[#0B0F17] px-2 py-1 text-xs text-slate-100 font-mono-tabular focus:border-amber-500 focus:outline-none"
                            />
                            <span className="font-mono-tabular text-slate-400 ml-0.5">
                              ({slotDuration.toFixed(2)}s)
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          {/* Keep Original Sound vs Dub Kurdish Toggle */}
                          <button
                            type="button"
                            onClick={() => {
                              if (isPlayingPreview) stopPreviewAudio();
                              handleUpdateLine(line.id, {
                                preserve_original: !line.preserve_original,
                              });
                            }}
                            title="Keep original voice/shout/sound (mmmm, hmm) unmuted instead of replacing with TTS"
                            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                              line.preserve_original
                                ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                                : 'border-slate-700 bg-[#0B0F17] text-slate-300 hover:border-slate-600 hover:bg-slate-800'
                            }`}
                          >
                            <Mic className="h-3 w-3" />
                            {line.preserve_original
                              ? 'Original Kept'
                              : 'Dub Sorani'}
                          </button>

                          {/* Gender Toggle Button */}
                          <button
                            type="button"
                            onClick={() => handleToggleGender(line)}
                            title="Click to switch speaker gender"
                            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                              line.gender === 'female'
                                ? 'border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20'
                                : 'border-sky-500/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20'
                            }`}
                          >
                            {line.gender === 'female' ? 'Female' : 'Male'}
                          </button>

                          {/* Emotion Badge + Emotion Selector Dropdown */}
                          <div
                            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${emotionCfg.badgeClass}`}
                          >
                            <span aria-hidden="true">{emotionCfg.emoji}</span>
                            <select
                              aria-label={`Select emotion for line ${index + 1}`}
                              value={emotionCfg.value}
                              onChange={(e) =>
                                handleUpdateLine(line.id, {
                                  emotion: e.target.value as SpeakerEmotion,
                                })
                              }
                              className="bg-transparent py-0.5 text-xs font-medium focus:outline-none cursor-pointer"
                            >
                              {EMOTION_OPTIONS.map((opt) => (
                                <option
                                  key={opt.value}
                                  value={opt.value}
                                  className="bg-[#0B0F17] text-slate-100"
                                >
                                  {opt.emoji} {opt.label} ({opt.kurdishLabel}) · Pawan: {opt.pawanEmotion} ({opt.ttsSpeed.toFixed(2)}x)
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Voice Selector Dropdown */}
                          <select
                            aria-label={`Select Kurdish Sorani voice for line ${index + 1}`}
                            value={line.voice}
                            disabled={Boolean(line.preserve_original)}
                            onChange={(e) =>
                              handleUpdateLine(line.id, {
                                voice: e.target.value as PawanVoice,
                              })
                            }
                            className="rounded-md border border-slate-700 bg-[#0B0F17] px-2.5 py-1 text-xs font-medium text-slate-100 capitalize focus:border-amber-500 focus:outline-none disabled:opacity-45"
                          >
                            <optgroup label="Male Voices (pkrd/tts-ku)">
                              {MALE_VOICES.map((v) => (
                                <option key={v} value={v}>
                                  {v.charAt(0).toUpperCase() + v.slice(1)} (Male)
                                </option>
                              ))}
                            </optgroup>
                            <optgroup label="Female Voices (pkrd/tts-ku)">
                              {FEMALE_VOICES.map((v) => (
                                <option key={v} value={v}>
                                  {v.charAt(0).toUpperCase() + v.slice(1)} (Female)
                                </option>
                              ))}
                            </optgroup>
                          </select>

                          {/* Individual Preview Line Audio Button */}
                          <button
                            type="button"
                            disabled={
                              isPreviewLoading ||
                              Boolean(line.preserve_original)
                            }
                            onClick={() => void handlePreviewVoice(line)}
                            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-45 disabled:cursor-not-allowed ${
                              isPlayingPreview
                                ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                                : 'border-slate-700 bg-[#0B0F17] text-slate-200 hover:border-slate-600 hover:bg-slate-800'
                            }`}
                          >
                            {isPreviewLoading ? (
                              <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
                                Loading
                              </>
                            ) : isPlayingPreview ? (
                              <>
                                <Square className="h-3 w-3 fill-current" />
                                Stop
                              </>
                            ) : (
                              <>
                                <Volume2 className="h-3.5 w-3.5 text-amber-400" />
                                Preview Line Audio
                              </>
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => handleDeleteLine(line.id)}
                            aria-label={`Delete line ${index + 1}`}
                            className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-red-950/50 hover:text-red-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Speaker Diarization & Quick Bulk Voice Action */}
                      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/60 pt-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center gap-1.5 text-slate-300">
                            <User className="h-3 w-3 text-amber-400 shrink-0" />
                            <span className="font-medium text-slate-200">
                              {speakerLabel}
                            </span>
                          </span>
                          {sameSpeakerLines.length > 1 && (
                            <button
                              type="button"
                              onClick={() =>
                                handleApplyVoiceToSpeaker(
                                  speakerLabel,
                                  line.voice
                                )
                              }
                              title={`Set voice "${line.voice}" for all lines of this character`}
                              className="text-[11px] text-amber-400 hover:text-amber-300 underline decoration-amber-500/40 underline-offset-2 transition-colors whitespace-nowrap"
                            >
                              Apply {line.voice} to all {sameSpeakerLines.length} lines
                            </button>
                          )}
                        </div>

                        <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono-tabular">
                          <span>
                            Pawan Motion: <span className="text-amber-400 font-medium capitalize">{emotionCfg.pawanEmotion}</span>
                          </span>
                          <span aria-hidden="true" className="text-slate-600">·</span>
                          <span>Pacing: {emotionCfg.ttsSpeed.toFixed(2)}x</span>
                        </div>
                      </div>

                      {/* English Reference & Editable Kurdish Sorani RTL Input */}
                      <div className="mt-3.5 space-y-2.5">
                        <p className="text-xs leading-relaxed text-slate-400 select-text">
                          {line.english_text}
                        </p>

                        {line.preserve_original ? (
                          <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3.5 py-2.5 text-xs text-emerald-300">
                            Original audio preserved unmuted for this segment
                            (shouting, humming, or original voice). Click
                            &ldquo;Original Kept&rdquo; to switch back to
                            Kurdish dubbing.
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            <label
                              htmlFor={`sorani-${line.id}`}
                              className="sr-only"
                            >
                              Kurdish Sorani translation for line {index + 1}
                            </label>
                            <textarea
                              id={`sorani-${line.id}`}
                              dir="rtl"
                              lang="ckb"
                              rows={2}
                              value={line.kurdish_sorani}
                              onChange={(e) =>
                                handleUpdateLine(line.id, {
                                  kurdish_sorani: e.target.value,
                                })
                              }
                              placeholder="دەقی کوردی سۆرانی لێرە بنووسە..."
                              className="font-kurdish w-full resize-y rounded-lg border border-slate-700/90 bg-[#0B0F17] px-3.5 py-2.5 text-[15px] text-slate-100 placeholder-slate-600 focus:border-amber-500 focus:outline-none"
                            />

                            {/* Kurdish Intonation & Expressive Punctuation Toolbar */}
                            <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs">
                              <span className="text-[11px] text-slate-500">
                                Insert Kurdish intonation:
                              </span>
                              <button
                                type="button"
                                onClick={() => insertPunctuation(line.id, '، ')}
                                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-[#0B0F17] px-2 py-0.5 text-xs text-slate-200 hover:border-amber-500/60 hover:text-amber-300 transition-colors"
                                title="Kurdish Comma (فاریزە) - adds natural speaking pause & breath"
                              >
                                <span className="font-kurdish font-bold text-amber-400">
                                  ،
                                </span>
                                <span className="text-[11px] text-slate-400">
                                  Pause
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => insertPunctuation(line.id, '؟ ')}
                                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-[#0B0F17] px-2 py-0.5 text-xs text-slate-200 hover:border-amber-500/60 hover:text-amber-300 transition-colors"
                                title="Kurdish Question Mark (نیشانەی پرسیار) - raises ending vocal pitch"
                              >
                                <span className="font-kurdish font-bold text-amber-400">
                                  ؟
                                </span>
                                <span className="text-[11px] text-slate-400">
                                  Question
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => insertPunctuation(line.id, '! ')}
                                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-[#0B0F17] px-2 py-0.5 text-xs text-slate-200 hover:border-amber-500/60 hover:text-amber-300 transition-colors"
                                title="Exclamation (سەرسووڕمان) - dynamic energetic emphasis"
                              >
                                <span className="font-bold text-amber-400">
                                  !
                                </span>
                                <span className="text-[11px] text-slate-400">
                                  Exclaim
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  insertPunctuation(line.id, '... ')
                                }
                                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-[#0B0F17] px-2 py-0.5 text-xs text-slate-200 hover:border-amber-500/60 hover:text-amber-300 transition-colors"
                                title="Suspension dots (وەستان) - dramatic theatrical pause"
                              >
                                <span className="font-bold text-amber-400">
                                  ...
                                </span>
                                <span className="text-[11px] text-slate-400">
                                  Suspense
                                </span>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

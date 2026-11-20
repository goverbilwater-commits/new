export type SpeakerGender = 'male' | 'female';
export type SpeakerType = 'human' | 'ai_system';

export type SpeakerEmotion =
  | 'neutral'
  | 'shouting'
  | 'angry'
  | 'sad'
  | 'agitated'
  | 'fearful'
  | 'confident'
  | 'happy'
  | 'excited'
  | 'calm';

export type PawanSupportedEmotion = 'neutral' | 'angry' | 'happy' | 'sad';

export interface EmotionConfig {
  value: SpeakerEmotion;
  label: string;
  kurdishLabel: string;
  emoji: string;
  ttsSpeed: number;
  pawanEmotion: PawanSupportedEmotion;
  badgeClass: string;
}

export function mapPawanEmotion(emotion?: string): PawanSupportedEmotion {
  if (!emotion) return 'neutral';
  const clean = emotion.trim().toLowerCase();
  switch (clean) {
    case 'angry':
    case 'shouting':
    case 'agitated':
      return 'angry';
    case 'happy':
    case 'excited':
      return 'happy';
    case 'sad':
    case 'fearful':
    case 'fear':
      return 'sad';
    case 'neutral':
    case 'calm':
    case 'confident':
    default:
      return 'neutral';
  }
}

export const EMOTION_OPTIONS: readonly EmotionConfig[] = [
  {
    value: 'neutral',
    label: 'Neutral',
    kurdishLabel: 'ئاسایی',
    emoji: '😐',
    ttsSpeed: 1.0,
    pawanEmotion: 'neutral',
    badgeClass: 'border-slate-700 bg-slate-800/70 text-slate-200',
  },
  {
    value: 'angry',
    label: 'Angry',
    kurdishLabel: 'تووڕە',
    emoji: '😠',
    ttsSpeed: 1.12,
    pawanEmotion: 'angry',
    badgeClass: 'border-red-500/40 bg-red-500/10 text-red-300',
  },
  {
    value: 'happy',
    label: 'Happy',
    kurdishLabel: 'دڵخۆش',
    emoji: '😊',
    ttsSpeed: 1.05,
    pawanEmotion: 'happy',
    badgeClass: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  },
  {
    value: 'sad',
    label: 'Sad',
    kurdishLabel: 'دڵتەنگ',
    emoji: '😢',
    ttsSpeed: 0.88,
    pawanEmotion: 'sad',
    badgeClass: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300',
  },
  {
    value: 'shouting',
    label: 'Shouting',
    kurdishLabel: 'هاوار',
    emoji: '🗣️',
    ttsSpeed: 1.14,
    pawanEmotion: 'angry',
    badgeClass: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  },
  {
    value: 'agitated',
    label: 'Agitated',
    kurdishLabel: 'نیگەران',
    emoji: '😤',
    ttsSpeed: 1.15,
    pawanEmotion: 'angry',
    badgeClass: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
  },
  {
    value: 'fearful',
    label: 'Fearful',
    kurdishLabel: 'ترساو',
    emoji: '😨',
    ttsSpeed: 1.08,
    pawanEmotion: 'sad',
    badgeClass: 'border-purple-500/40 bg-purple-500/10 text-purple-300',
  },
  {
    value: 'excited',
    label: 'Excited',
    kurdishLabel: 'بەپەرۆش',
    emoji: '🤩',
    ttsSpeed: 1.12,
    pawanEmotion: 'happy',
    badgeClass: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300',
  },
  {
    value: 'confident',
    label: 'Confident',
    kurdishLabel: 'بەبڕوا',
    emoji: '😎',
    ttsSpeed: 0.98,
    pawanEmotion: 'neutral',
    badgeClass: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  },
  {
    value: 'calm',
    label: 'Calm',
    kurdishLabel: 'ئارام',
    emoji: '😌',
    ttsSpeed: 0.92,
    pawanEmotion: 'neutral',
    badgeClass: 'border-teal-500/40 bg-teal-500/10 text-teal-300',
  },
] as const;

export function getEmotionConfig(emotion?: string): EmotionConfig {
  const normalized = (emotion || 'neutral').toLowerCase() as SpeakerEmotion;
  return (
    EMOTION_OPTIONS.find((item) => item.value === normalized) ?? EMOTION_OPTIONS[0]
  );
}

export const MALE_VOICES = [
  'aram',
  'rebin',
  'soran',
  'shwan',
  'karwan',
  'hemin',
  'bakhtiyar',
  'kamaran',
  'dilshad',
  'rostam',
] as const;

export const FEMALE_VOICES = [
  'shilan',
  'lana',
  'rozhin',
  'shno',
  'hawnaz',
  'nazanin',
  'kazhal',
  'sozan',
  'gulala',
  'shirin',
] as const;

export type MaleVoice = (typeof MALE_VOICES)[number];
export type FemaleVoice = (typeof FEMALE_VOICES)[number];
export type PawanVoice = MaleVoice | FemaleVoice;

export const DEFAULT_MALE_VOICE: MaleVoice = 'aram';
export const DEFAULT_FEMALE_VOICE: FemaleVoice = 'shilan';

export function getDefaultVoiceForGender(gender: SpeakerGender): PawanVoice {
  return gender === 'female' ? DEFAULT_FEMALE_VOICE : DEFAULT_MALE_VOICE;
}

export interface DubLine {
  id: string;
  start_time: number;
  end_time: number;
  gender: SpeakerGender;
  emotion: SpeakerEmotion;
  speaker_type: SpeakerType;
  speaker_name?: string;
  voice: PawanVoice;
  english_text: string;
  kurdish_sorani: string;
  preserve_original?: boolean;
}

export interface AnalyzeResponse {
  videoId: string;
  filename: string;
  duration: number;
  hasAudio: boolean;
  lines: DubLine[];
}

export interface ConfigStatus {
  hasServerPawanKey: boolean;
  hasServerFallbackPawanKey?: boolean;
  serverPawanKeyCount?: number;
  hasGeminiKey: boolean;
}

export interface DubProgressEvent {
  jobId: string;
  stage: 'queued' | 'tts' | 'separating' | 'mixing' | 'done' | 'error';
  progress: number; // 0 to 100
  completedLines: number;
  totalLines: number;
  message: string;
  speedAdjustedCount?: number;
  separationMode?:
    | 'mdx-net-neural-isolation'
    | 'spectral-vocal-suppression'
    | 'silent-source';
  previewUrl?: string;
  downloadUrl?: string;
  downloadFilename?: string;
  subtitlesUrl?: string;
  subtitlesDualUrl?: string;
  backgroundVolume?: number;
  voiceVolume?: number;
  masteringEnabled?: boolean;
  error?: string;
}

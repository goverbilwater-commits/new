import { GoogleGenAI, Type } from '@google/genai';
import crypto from 'node:crypto';
import {
  getDefaultVoiceForGender,
  getEmotionConfig,
  type DubLine,
  type SpeakerGender,
  type SpeakerType,
} from '../src/shared/types.ts';

// Models tried in order. Override with GEMINI_MODEL / GEMINI_FALLBACK_MODELS (comma-separated).
function getModelChain(): string[] {
  const primary = process.env.GEMINI_MODEL?.trim() || 'gemini-4-hydrogen';
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.1-flash-lite')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return [primary, ...fallbacks.filter((m) => m !== primary)];
}

function getErrorStatus(err: unknown): number {
  const e = err as { status?: number; code?: number; message?: string };
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.code === 'number') return e.code;
  const m = /"code"\s*:\s*(\d{3})/.exec(e?.message ?? '');
  return m ? Number(m[1]) : 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retries temporary overload errors (429/500/503/504) with backoff, then falls back to the next model.
async function generateWithFallback(
  ai: GoogleGenAI,
  params: Parameters<GoogleGenAI['models']['generateContent']>[0]
) {
  const models = getModelChain();
  let lastError: unknown;
  for (const model of models) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        return await ai.models.generateContent({ ...params, model });
      } catch (err) {
        lastError = err;
        const status = getErrorStatus(err);
        if (status === 404) break; // model name not available -> next model
        const temporary = [429, 500, 503, 504].includes(status);
        if (!temporary) throw err;
        if (attempt < 4) {
          await sleep(2000 * 2 ** (attempt - 1) + Math.random() * 500);
        }
      }
    }
    console.warn(`[Gemini] Model ${model} unavailable, trying next model if any.`);
  }
  const msg = lastError instanceof Error ? lastError.message : 'Gemini is unavailable.';
  throw new Error(
    `Gemini is overloaded right now. Please try again in a few minutes. (${msg})`
  );
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add it in the Settings > Secrets panel.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function normalizeMimeType(mimeType: string, filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (mimeType && mimeType.startsWith('video/')) return mimeType;
  return 'video/mp4';
}

interface RawGeminiLine {
  start_time: number;
  end_time: number;
  gender: string;
  emotion: string;
  speaker_type: string;
  speaker_name?: string;
  english_text: string;
  kurdish_sorani: string;
  preserve_original?: boolean;
}

export async function analyzeVideoWithGemini(
  videoPath: string,
  mimeType: string,
  filename: string
): Promise<DubLine[]> {
  const ai = getGeminiClient();
  const resolvedMimeType = normalizeMimeType(mimeType, filename);

  const uploadedFile = await ai.files.upload({
    file: videoPath,
    config: {
      mimeType: resolvedMimeType,
      displayName: filename,
    },
  });

  if (!uploadedFile.name) {
    throw new Error('Failed to upload video file to Gemini Files API.');
  }

  try {
    let activeFile = uploadedFile;
    const deadline = Date.now() + 180_000;

    while (activeFile.state === 'PROCESSING') {
      if (Date.now() > deadline) {
        throw new Error('Timed out while Gemini processed the uploaded video.');
      }
      await new Promise((resolve) => setTimeout(resolve, 1800));
      activeFile = await ai.files.get({ name: uploadedFile.name });
    }

    if (activeFile.state === 'FAILED' || !activeFile.uri) {
      throw new Error(
        `Gemini video processing failed${activeFile.error?.message ? `: ${activeFile.error.message}` : '.'}`
      );
    }

    const prompt = [
      'Watch the speaker lip/mouth movements AND listen carefully to the audio from start to finish.',
      'Extract every spoken English phrase AND every standalone pure non-verbal vocalization in strict chronological order for frame-accurate ADR dubbing.',
      'For each segment, provide:',
      '1. start_time: Exact decimal timestamp in seconds (0.01s precision, e.g. 1.18, NOT rounded to 0.5s) at the exact moment the speaker lips start moving / vocal sound begins.',
      '2. end_time: Exact decimal timestamp in seconds (0.01s precision, e.g. 2.74) when the final English syllable or non-verbal sound finishes and the lips close or pause. Ensure end_time > start_time.',
      '3. gender: Speaker vocal gender, either "male" or "female".',
      '4. emotion: Speaker emotional mood based on vocal tone, volume, delivery, and facial expression. Choose one of: "neutral", "shouting", "angry", "sad", "agitated", "fearful", "confident", "happy", "excited", "calm". Use "shouting" whenever the speaker yells or screams.',
      '5. speaker_name: Consistent character identifier across the entire video, e.g. "Speaker 1", "Speaker 2", "Narrator", "Host", or character name if known.',
      '6. speaker_type: Whether the voice is a "human" speaker or an "ai_system" / synthetic voice.',
      '7. preserve_original: Boolean.',
      '   - Set false for ALL spoken English words/phrases/sentences that must be dubbed into Kurdish Sorani.',
      '   - Set true ONLY for pure, wordless non-verbal human sounds (such as "mmmm", "hmm", "uhh", "ahh", wordless screams/shouts, groans, grunts, sighs, gasps, laughs, or crying) where ZERO English words are spoken.',
      '8. english_text: Exact verbatim English transcription (if preserve_original is false), or a short label like "[Non-verbal: shouting]" / "[Non-verbal: hmm]" (if preserve_original is true).',
      '9. kurdish_sorani: Expressive, conversational translation in standard Kurdish Sorani (Arabic script, using proper characters ڕ، ڵ، ڤ، گ، ک، چ، ژ، پ، ۆ، ێ، ە). Include authentic Kurdish punctuation (،, ؟, !, ...) because the TTS engine uses punctuation marks to inflect questions, emotional exclamations, and pauses naturally.',
      '',
      'CRITICAL LIP-SYNC & ANTI-LEAKAGE RULES:',
      '- LIP-SYNC PRECISION: Anchor start_time and end_time tightly to actual lip movement and vocal word boundaries. Split long sentences at any pause >= 0.25s into separate segments so every line stays locked to the speaker lips.',
      '- DURATION MATCHING: Match kurdish_sorani closely in syllable count and speaking duration so it fits inside (end_time - start_time) without trailing past lip closure.',
      '- NO ENGLISH LEAKAGE: NEVER set preserve_original to true on any interval that contains spoken English words (not even short fillers like "yeah", "okay", "hey", "no", "wait", or trailing English syllables). Every spoken English word MUST have preserve_original=false and a Kurdish Sorani translation.',
      '- PRESERVE NON-VERBAL SOUNDS: Only use preserve_original=true for pure wordless vocalizations ("mmmm", "hmm", wordless shouts/screams, laughs, cries, sighs, gasps) strictly separated from English speech.',
      '- Do not include translator notes, parentheses, stage directions, or transliteration in kurdish_sorani.',
      '- If there are no spoken words or non-verbal vocalizations in the video, return [].',
    ].join('\n');

    const response = await generateWithFallback(ai, {
      model: 'gemini-4-hydrogen',
      contents: [
        {
          role: 'user',
          parts: [
            {
              fileData: {
                fileUri: activeFile.uri,
                mimeType: activeFile.mimeType || resolvedMimeType,
              },
            },
            { text: prompt },
          ],
        },
      ],
      config: {
        systemInstruction:
          'You are an expert audiovisual ADR lip-sync director, emotion analyst, and native Kurdish Sorani translator. You align dialogue timestamps to exact mouth/lip movements to 10ms precision, never let English speech leak through, use authentic Kurdish punctuation (،, ؟, !, ...) for natural vocal intonation, and tag pure wordless non-verbal sounds with preserve_original=true.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              start_time: {
                type: Type.NUMBER,
                description:
                  'Exact start timestamp in seconds (0.01s precision) when speaker lips begin forming the first word or vocalization.',
              },
              end_time: {
                type: Type.NUMBER,
                description:
                  'Exact end timestamp in seconds (0.01s precision) when speaker finishes the final word or vocalization.',
              },
              gender: {
                type: Type.STRING,
                enum: ['male', 'female'],
                description: 'Speaker gender: male or female.',
              },
              emotion: {
                type: Type.STRING,
                enum: [
                  'neutral',
                  'shouting',
                  'angry',
                  'sad',
                  'agitated',
                  'fearful',
                  'confident',
                  'happy',
                  'excited',
                  'calm',
                ],
                description: 'Detected speaker emotion or vocal mood.',
              },
              speaker_name: {
                type: Type.STRING,
                description:
                  'Consistent character identifier, e.g. "Speaker 1", "Speaker 2", "Narrator".',
              },
              speaker_type: {
                type: Type.STRING,
                enum: ['human', 'ai_system'],
                description: 'Speaker type: human or ai_system.',
              },
              preserve_original: {
                type: Type.BOOLEAN,
                description:
                  'True ONLY for pure wordless non-verbal vocalizations (mmmm, hmm, wordless shouts/screams, laughs, sighs, gasps) with zero English words; false for all spoken English dialogue.',
              },
              english_text: {
                type: Type.STRING,
                description:
                  'Exact English transcript of the spoken words, or short non-verbal tag when preserve_original is true.',
              },
              kurdish_sorani: {
                type: Type.STRING,
                description:
                  'Natural conversational Kurdish Sorani translation in Arabic script matched in spoken duration to the lip movement, or empty string when preserve_original is true.',
              },
            },
            required: [
              'start_time',
              'end_time',
              'gender',
              'emotion',
              'speaker_type',
              'preserve_original',
              'english_text',
              'kurdish_sorani',
            ],
          },
        },
      },
    });

    const rawText = (response.text ?? '[]').trim();
    let parsed: RawGeminiLine[];
    try {
      parsed = JSON.parse(rawText) as RawGeminiLine[];
    } catch {
      throw new Error('Gemini returned malformed JSON while analyzing the video.');
    }

    if (!Array.isArray(parsed)) {
      throw new Error('Unexpected response format from Gemini video analysis.');
    }

    const maleVoiceRotation: (typeof import('../src/shared/types.ts').MALE_VOICES)[number][] = [
      'aram',
      'rebin',
      'soran',
      'shwan',
      'karwan',
      'hemin',
      'bakhtiyar',
      'kamaran',
    ];
    const femaleVoiceRotation: (typeof import('../src/shared/types.ts').FEMALE_VOICES)[number][] = [
      'shilan',
      'lana',
      'rozhin',
      'shno',
      'hawnaz',
      'nazanin',
      'kazhal',
      'sozan',
    ];
    const speakerVoiceMap = new Map<string, (typeof maleVoiceRotation)[number] | (typeof femaleVoiceRotation)[number]>();
    let maleCount = 0;
    let femaleCount = 0;

    const lines: DubLine[] = parsed
      .filter(
        (item) =>
          item &&
          typeof item.english_text === 'string' &&
          (item.preserve_original === true ||
            (typeof item.kurdish_sorani === 'string' &&
              item.kurdish_sorani.trim().length > 0))
      )
      .map((item) => {
        const start = Math.max(0, Number(item.start_time) || 0);
        const rawEnd = Number(item.end_time) || start + 1.5;
        const end = rawEnd > start ? rawEnd : Number((start + 1.0).toFixed(2));
        const gender: SpeakerGender =
          item.gender === 'female' ? 'female' : 'male';
        const emotion = getEmotionConfig(item.emotion).value;
        const speakerType: SpeakerType =
          item.speaker_type === 'ai_system' ? 'ai_system' : 'human';
        const preserveOriginal = Boolean(item.preserve_original);

        const rawSpeaker = (item.speaker_name || '').trim();
        const speakerName = rawSpeaker || (gender === 'female' ? 'Speaker 2 (Female)' : 'Speaker 1 (Male)');

        let assignedVoice = speakerVoiceMap.get(speakerName);
        if (!assignedVoice) {
          if (gender === 'female') {
            assignedVoice = femaleVoiceRotation[femaleCount % femaleVoiceRotation.length];
            femaleCount++;
          } else {
            assignedVoice = maleVoiceRotation[maleCount % maleVoiceRotation.length];
            maleCount++;
          }
          speakerVoiceMap.set(speakerName, assignedVoice);
        }

        return {
          id: crypto.randomUUID(),
          start_time: Number(start.toFixed(2)),
          end_time: Number(end.toFixed(2)),
          gender,
          emotion,
          speaker_type: speakerType,
          speaker_name: speakerName,
          voice: assignedVoice,
          english_text: item.english_text.trim(),
          kurdish_sorani: preserveOriginal ? '' : (item.kurdish_sorani || '').trim(),
          preserve_original: preserveOriginal,
        };
      })
      .sort((a, b) => a.start_time - b.start_time);

    return lines;
  } finally {
    await ai.files.delete({ name: uploadedFile.name }).catch(() => {});
  }
}
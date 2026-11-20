import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MALE_VOICE,
  FEMALE_VOICES,
  MALE_VOICES,
  mapPawanEmotion,
  type PawanVoice,
} from '../src/shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KEYS_FILE = path.join(__dirname, '..', 'pawan_keys.json');

const PAWAN_TTS_ENDPOINT = 'https://api.pawan.krd/v1/audio/speech';
const VALID_VOICES = new Set<string>([...MALE_VOICES, ...FEMALE_VOICES]);

let serverPersistentKeys: string[] = [];

export class PawanApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'PawanApiError';
    this.status = status;
  }
}

function splitKeyString(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,;]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

function getNumberedServerPawanKeys(): string[] {
  const numberedVarNames = Object.keys(process.env)
    .filter((name) => /^PAWAN_API_KEY_\d+$/i.test(name))
    .sort((a, b) => {
      const numA = Number(a.match(/\d+$/)?.[0] ?? 0);
      const numB = Number(b.match(/\d+$/)?.[0] ?? 0);
      return numA - numB;
    });
  return numberedVarNames.flatMap((name) => splitKeyString(process.env[name]));
}

let keysFileLoaded = false;

export function loadSavedKeys(): string[] {
  keysFileLoaded = true;
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const content = fs.readFileSync(KEYS_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.keys)) {
        serverPersistentKeys = parsed.keys
          .map((k: unknown) => (typeof k === 'string' ? k.trim() : ''))
          .filter((k: string) => k.length > 0);
        return serverPersistentKeys;
      }
    }
  } catch (err) {
    console.warn('[Pawan] Could not read pawan_keys.json:', err);
  }

  // Seed with initial environment variables if file is absent
  const initial = [
    ...splitKeyString(process.env.PAWAN_API_KEY),
    ...splitKeyString(process.env.PAWAN_API_KEY_FALLBACK),
    ...splitKeyString(process.env.PAWAN_API_KEYS),
    ...getNumberedServerPawanKeys(),
  ];
  const unique = Array.from(new Set(initial.filter((k) => k.length > 0)));
  serverPersistentKeys = unique;
  if (unique.length > 0) {
    saveKeys(unique);
  }
  return unique;
}

export function saveKeys(keys: string[]): string[] {
  keysFileLoaded = true;
  const cleaned = Array.from(
    new Set(
      keys
        .map((k) => (typeof k === 'string' ? k.trim() : ''))
        .filter((k) => k.length > 0)
    )
  );
  serverPersistentKeys = cleaned;
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ keys: cleaned }, null, 2), 'utf-8');
    process.env.PAWAN_API_KEY = cleaned[0] || '';
    process.env.PAWAN_API_KEYS = cleaned.slice(1).join(',');
  } catch (err) {
    console.warn('[Pawan] Could not write pawan_keys.json:', err);
  }

  // Also write to .env for extra persistence across server restarts
  try {
    const envFile = path.join(__dirname, '..', '.env');
    let envContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : '';
    const primary = cleaned[0] || '';
    const fallbacks = cleaned.slice(1).join(',');

    if (/^PAWAN_API_KEY=.*/m.test(envContent)) {
      envContent = envContent.replace(/^PAWAN_API_KEY=.*/m, `PAWAN_API_KEY="${primary}"`);
    } else {
      envContent += `\nPAWAN_API_KEY="${primary}"`;
    }

    if (/^PAWAN_API_KEYS=.*/m.test(envContent)) {
      envContent = envContent.replace(/^PAWAN_API_KEYS=.*/m, `PAWAN_API_KEYS="${fallbacks}"`);
    } else if (fallbacks) {
      envContent += `\nPAWAN_API_KEYS="${fallbacks}"`;
    }

    fs.writeFileSync(envFile, envContent.trim() + '\n', 'utf-8');
  } catch (err) {
    console.warn('[Pawan] Could not update .env file:', err);
  }

  return cleaned;
}

export function getAllConfiguredKeys(): string[] {
  if (!keysFileLoaded) {
    loadSavedKeys();
  }
  return serverPersistentKeys;
}

export function resolvePawanApiKeys(
  primaryOverride?: string,
  fallbackOverride?: string
): string[] {
  if (!keysFileLoaded) {
    loadSavedKeys();
  }

  // Once pawan_keys.json exists with saved keys, treat it as authoritative so deleted
  // or revoked env secrets don't sneak back into rotation.
  const hasSavedFile = fs.existsSync(KEYS_FILE) && serverPersistentKeys.length > 0;
  const envFallback = hasSavedFile
    ? []
    : [
        ...splitKeyString(process.env.PAWAN_API_KEY),
        ...splitKeyString(process.env.PAWAN_API_KEY_FALLBACK),
        ...splitKeyString(process.env.PAWAN_API_KEYS),
        ...getNumberedServerPawanKeys(),
      ];

  const ordered = [
    ...splitKeyString(primaryOverride),
    ...splitKeyString(fallbackOverride),
    ...serverPersistentKeys,
    ...envFallback,
  ];

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const key of ordered) {
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(key);
    }
  }

  if (unique.length === 0) {
    throw new PawanApiError(
      'Pawan.Krd API key is missing. Set PAWAN_API_KEY in environment secrets or enter your key in API Settings.',
      401
    );
  }
  return unique;
}

export function getConfiguredServerPawanKeyCount(): number {
  if (!keysFileLoaded) {
    loadSavedKeys();
  }
  if (fs.existsSync(KEYS_FILE) && serverPersistentKeys.length > 0) {
    return serverPersistentKeys.length;
  }
  const ordered = [
    ...serverPersistentKeys,
    ...splitKeyString(process.env.PAWAN_API_KEY),
    ...splitKeyString(process.env.PAWAN_API_KEY_FALLBACK),
    ...splitKeyString(process.env.PAWAN_API_KEYS),
    ...getNumberedServerPawanKeys(),
  ];
  return new Set(ordered).size;
}

export function resolvePawanApiKey(overrideKey?: string): string {
  return resolvePawanApiKeys(overrideKey)[0];
}

function sanitizeVoice(voice: string): PawanVoice {
  if (VALID_VOICES.has(voice)) {
    return voice as PawanVoice;
  }
  return DEFAULT_MALE_VOICE;
}

async function parseErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return `HTTP ${response.status}`;
    try {
      const json = JSON.parse(text) as {
        error?: { message?: string; code?: string } | string;
        message?: string;
      };
      if (typeof json.error === 'string') return json.error;
      if (json.error?.message) return json.error.message;
      if (json.message) return json.message;
    } catch {
      return text.slice(0, 240);
    }
    return text.slice(0, 240);
  } catch {
    return `HTTP ${response.status}`;
  }
}

function formatFriendlyError(status: number, detail: string): string {
  if (status === 401) {
    return `Pawan.Krd authentication failed (${detail}). Please check your PAWAN_API_KEY in API Settings.`;
  }
  if (status === 402 || status === 403) {
    return `Pawan.Krd credit or permission error (${detail}). Please verify your account credits and key permissions.`;
  }
  if (status === 429) {
    return `Pawan.Krd rate limit exceeded (${detail}). Please wait a moment and try again.`;
  }
  return `Pawan.Krd TTS error (${status}): ${detail}`;
}

// Per-key serialization queue so we never send simultaneous requests on the same key
// (Pawan.Krd plans limit concurrent requests per key and trigger 429 when hit concurrently).
const keyQueues = new Map<string, Promise<void>>();
const keyLastFinishedAt = new Map<string, number>();
const MIN_KEY_GAP_MS = 250;

async function withKeyLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = keyQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  keyQueues.set(key, previous.then(() => current));

  await previous;
  try {
    const lastDone = keyLastFinishedAt.get(key) ?? 0;
    const waitMs = MIN_KEY_GAP_MS - (Date.now() - lastDone);
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    return await task();
  } finally {
    keyLastFinishedAt.set(key, Date.now());
    release();
    if (keyQueues.get(key) === current) {
      keyQueues.delete(key);
    }
  }
}

export interface SynthesizeSpeechResult {
  buffer: Buffer;
  keyIndexUsed: number;
  switchedToFallback: boolean;
  deadKeys: string[];
}

export async function synthesizeSoraniSpeechWithMeta(params: {
  text: string;
  voice: string;
  apiKey?: string;
  apiKeys?: string[];
  speed?: number;
  emotion?: string;
}): Promise<SynthesizeSpeechResult> {
  const cleanText = params.text.trim();
  if (!cleanText) {
    throw new PawanApiError('Cannot synthesize empty Kurdish Sorani text.', 400);
  }

  const keys =
    params.apiKeys && params.apiKeys.length > 0
      ? params.apiKeys
      : params.apiKey
        ? [params.apiKey]
        : resolvePawanApiKeys();

  const resolvedSpeed = Number(
    Math.min(1.25, Math.max(0.75, Number(params.speed) || 1.0)).toFixed(2)
  );
  const resolvedEmotion = mapPawanEmotion(params.emotion);

  const payload = JSON.stringify({
    model: 'pkrd/tts-ku',
    input: cleanText,
    voice: sanitizeVoice(params.voice),
    response_format: 'mp3',
    speed: resolvedSpeed,
    emotion: resolvedEmotion,
  });

  const bodyBytes = Buffer.from(payload, 'utf8');
  const deadKeys = new Set<string>();
  let lastTransientError: PawanApiError | null = null;
  let lastAuthOrCreditError: PawanApiError | null = null;

  const maxRounds = 5;
  for (let round = 1; round <= maxRounds; round++) {
    let anyRetryableThisRound = false;
    let suggestedWaitMs = 0;

    for (let keyIdx = 0; keyIdx < keys.length; keyIdx++) {
      const activeKey = keys[keyIdx];
      if (deadKeys.has(activeKey)) continue;

      try {
        const outcome = await withKeyLock(activeKey, async () => {
          const response = await fetch(PAWAN_TTS_ENDPOINT, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${activeKey}`,
              'Content-Type': 'application/json; charset=utf-8',
              Accept: 'audio/mpeg, application/json',
            },
            body: bodyBytes,
          });

          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            if (buffer.byteLength < 100) {
              return {
                ok: false as const,
                status: 502,
                detail: 'Pawan.Krd returned an unexpectedly empty audio file.',
                retryAfterMs: 0,
              };
            }
            return { ok: true as const, buffer };
          }

          const detail = await parseErrorDetail(response);
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterMs = retryAfterHeader
            ? Math.min(12_000, Math.max(800, Number(retryAfterHeader) * 1000 || 0))
            : 0;
          return {
            ok: false as const,
            status: response.status,
            detail,
            retryAfterMs,
          };
        });

        if (outcome.ok) {
          return {
            buffer: outcome.buffer,
            keyIndexUsed: keyIdx,
            switchedToFallback: keyIdx > 0,
            deadKeys: Array.from(deadKeys),
          };
        }

        const err = new PawanApiError(
          formatFriendlyError(outcome.status, outcome.detail),
          outcome.status
        );

        // Permanent key errors (401 invalid/revoked, 402 out of credits, 403 forbidden)
        if (
          outcome.status === 401 ||
          outcome.status === 402 ||
          outcome.status === 403
        ) {
          deadKeys.add(activeKey);
          lastAuthOrCreditError = err;
          console.warn(
            `[Pawan TTS] Key #${keyIdx + 1} unavailable (${outcome.status}: ${outcome.detail}). Marking inactive for this request.`
          );
          continue;
        }

        // Transient rate-limit (429) or server error (5xx): keep key alive and retry after backoff
        if (outcome.status === 429 || outcome.status >= 500) {
          anyRetryableThisRound = true;
          lastTransientError = err;
          if (outcome.retryAfterMs > suggestedWaitMs) {
            suggestedWaitMs = outcome.retryAfterMs;
          }
          continue;
        }

        // Other 4xx client errors (e.g. 400 bad text) should fail immediately
        throw err;
      } catch (error) {
        if (error instanceof PawanApiError && error.status < 500 && error.status !== 429) {
          throw error;
        }
        anyRetryableThisRound = true;
        const message =
          error instanceof Error ? error.message : 'Network error calling Pawan.Krd';
        lastTransientError = new PawanApiError(
          `Network error calling Pawan.Krd TTS: ${message}`,
          503
        );
      }
    }

    if (!anyRetryableThisRound || round === maxRounds) {
      break;
    }

    const backoffMs =
      suggestedWaitMs ||
      Math.round(1400 * Math.pow(1.8, round - 1) + Math.random() * 400);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }

  // Prefer reporting transient rate-limit error if at least one non-dead key existed,
  // so a dead fallback key (401/402) never masks a rate-limited working key.
  throw (
    lastTransientError ??
    lastAuthOrCreditError ??
    new PawanApiError('Failed to synthesize Kurdish Sorani speech.', 500)
  );
}

export async function synthesizeSoraniSpeech(params: {
  text: string;
  voice: string;
  apiKey?: string;
  apiKeys?: string[];
  speed?: number;
}): Promise<Buffer> {
  const result = await synthesizeSoraniSpeechWithMeta(params);
  return result.buffer;
}
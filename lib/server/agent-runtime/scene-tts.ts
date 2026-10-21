import { DEFAULT_MAX_DELAY_MS } from '@openmaic/generation';
import {
  agentToolBudgetRemainingMs,
  DEFAULT_AGENT_TOOL_TIMEOUT_MS,
} from '@/lib/agent/runtime/tool-timeout';
import { configuredDefaultVoice } from '@/lib/audio/provider-default-voice';
import { authorizeMediaModel } from '@/lib/server/model-config/media';
import { DEFAULT_TTS_MODELS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';
import { generateTTS, TTSRateLimitError, TTSRequestTimeoutError } from '@/lib/audio/tts-providers';
import { runFailureCode, type RunFailureErrorCode } from '@/lib/server/generation/run/failure-code';
import { SCENE_MAX_RETRIES, withRouteRetry } from '@/lib/server/generation/run/retry';
import { createSemaphore } from '@/lib/utils/concurrency';
import type { TTSProviderId } from '@/lib/audio/types';
import { BROWSER_NATIVE_TTS_PROVIDER_ID } from '@/lib/audio/provider-enablement';
import type { LegacySpeechAction, SpeechAction } from '@/lib/types/action';
import type { GeneratedAgentConfig, Scene } from '@/lib/types/stage';
import { adapterOptions } from '@/lib/server/model-config/adapter-options';
import { serverMediaConnection } from '@/lib/server/model-config/media';
import { resolveTTSModel, slotTTSModel } from '@/lib/server/provider-config';
import { persistClassroomMediaBytes } from '@/lib/server/classroom-media-bytes';

export interface SceneTtsFailure {
  id: string;
  /** `runFailureCode().errorCode`. Never a provider body or `error.message`. */
  reason: RunFailureErrorCode;
}

export interface SceneTtsSummary {
  available: boolean;
  changed: boolean;
  generated: number;
  skipped: number;
  failed: SceneTtsFailure[];
}

/** One in-flight provider call, shared by parallel agent tool calls of that provider. */
const AGENT_TTS_IN_FLIGHT_LIMIT = 1;

const providerGates = new Map<string, ReturnType<typeof createSemaphore>>();

function providerGate(providerId: string) {
  let gate = providerGates.get(providerId);
  if (!gate) {
    gate = createSemaphore(AGENT_TTS_IN_FLIGHT_LIMIT);
    providerGates.set(providerId, gate);
  }
  return gate;
}

export interface SceneTtsInput {
  scene: Scene;
  force: boolean;
  roster?: readonly GeneratedAgentConfig[] | null;
  signal?: AbortSignal;
  /** The run's owner, whose tts slot applies. */
  ownerId?: string;
  /** Retry sleep. Production waits; tests pass a fake clock. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Budget when `signal` is not the tool-timeout signal. Defaults to the
   * `generate_tts` budget. A tool-timeout deadline on `signal` wins.
   */
  budgetMs?: number;
}

function remainingBudgetMs(input: SceneTtsInput, startedAt: number): number {
  const fromTool = agentToolBudgetRemainingMs(input.signal);
  if (fromTool !== undefined) return fromTool;
  return (input.budgetMs ?? DEFAULT_AGENT_TOOL_TIMEOUT_MS) - (Date.now() - startedAt);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function narratorVoice(roster: SceneTtsInput['roster']) {
  return roster?.find((agent) => agent.role === 'teacher' && agent.voiceConfig)?.voiceConfig;
}

function audioMime(format: string) {
  return format === 'wav' ? 'audio/wav' : format === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
}

/** Server-configured narration synthesis into the stage's classroom-media path. */
export async function synthesizeSceneNarration(input: SceneTtsInput): Promise<SceneTtsSummary> {
  const startedAt = Date.now();
  // The tts slot decides the provider; the narrator's bound voice applies
  // only when it belongs to that provider.
  const connection = await serverMediaConnection('tts', input.ownerId);
  if (
    !connection ||
    connection === 'off' ||
    connection.providerId === BROWSER_NATIVE_TTS_PROVIDER_ID
  ) {
    return { available: false, changed: false, generated: 0, skipped: 0, failed: [] };
  }
  const providerId = connection.providerId as TTSProviderId;
  const bound = narratorVoice(input.roster);
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  const apiKey = connection.apiKey ?? '';
  if (provider?.requiresApiKey && !apiKey) {
    return { available: false, changed: false, generated: 0, skipped: 0, failed: [] };
  }
  const voice =
    bound?.providerId === providerId && bound.voiceId
      ? bound.voiceId
      : configuredDefaultVoice(connection.options, connection.voices) ||
        DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] ||
        '';
  const model =
    connection.modelId ?? (DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '');
  // A configured slot's own model; the legacy server pins apply only to a default.
  const modelId =
    (connection.origin === 'configuration'
      ? slotTTSModel(providerId, model, voice, connection.voices)
      : resolveTTSModel(providerId, model, voice, connection.voices)) || '';
  authorizeMediaModel(connection, 'tts', modelId);
  let generated = 0;
  let skipped = 0;
  const failed: SceneTtsFailure[] = [];
  for (const action of input.scene.actions ?? []) {
    if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
    const speech = action as SpeechAction;
    if (!input.force && speech.audioId) {
      skipped += 1;
      continue;
    }
    if (input.signal?.aborted) throw new Error('aborted');
    // Same retry as a classroom narration clip: a retryable failure, including
    // 429, sleeps before the next attempt, and never longer than that clip's
    // backoff cap. The semaphore stays held during the sleep. A wait the
    // remaining tool budget cannot cover fails this line instead of sleeping.
    // A timeout still aborts the tool instead of being retried.
    let retryAfterMs = 0;
    let lastError: unknown;
    try {
      const audio = await providerGate(providerId).run(() =>
        withRouteRetry(
          async () => {
            if (input.signal?.aborted) throw new Error('aborted');
            try {
              return await generateTTS(
                {
                  providerId,
                  modelId,
                  apiKey,
                  baseUrl: connection.baseUrl,
                  managed: connection.managed,
                  publicOnly: connection.userEndpoint,
                  voice,
                  ...(connection.voices ? { voices: connection.voices } : {}),
                  speed: speech.speed,
                  // The provider's own options (a VoxCPM backend, say).
                  providerOptions: adapterOptions(connection),
                  signal: input.signal,
                },
                speech.text,
              );
            } catch (error) {
              lastError = error;
              if (error instanceof TTSRateLimitError && error.retryAfterMs !== undefined) {
                retryAfterMs = Math.max(retryAfterMs, error.retryAfterMs);
              }
              throw error;
            }
          },
          {
            label: `agent-tts ${action.id}`,
            maxRetries: SCENE_MAX_RETRIES,
            refusalStatus: 400,
            signal: input.signal,
            sleep: (ms, signal) => {
              if (signal?.aborted || input.signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
              }
              const pace = retryAfterMs;
              retryAfterMs = 0;
              const wait = Math.min(DEFAULT_MAX_DELAY_MS, Math.max(ms, pace));
              if (wait > 0 && wait >= remainingBudgetMs(input, startedAt)) {
                throw (
                  lastError ??
                  Object.assign(new Error('TTS retry wait exceeds the remaining tool budget'), {
                    statusCode: 429,
                  })
                );
              }
              return (input.sleep ?? abortableSleep)(wait, signal);
            },
            rethrow: (error) =>
              error instanceof TTSRequestTimeoutError || input.signal?.aborted === true,
          },
        ),
      );
      if (input.signal?.aborted) throw new Error('aborted');
      // The persisted reference is the RELATIVE classroom-media path (the
      // agent runtime has no request origin; relative stays valid on any
      // deployment origin — see classroom-media-bytes.ts). The browser's
      // narration consumers (timeline status/preview, playback, exports)
      // resolve a speech line through the legacy (audioId, audioUrl) pair:
      // `audioId` alone is never resolvable to bytes client-side, while a
      // present `audioUrl` marks the line voiced and is what the audio
      // element / fetch fallback plays. Stamp the same relative path on both.
      const audioId = await persistClassroomMediaBytes({
        stageId: input.scene.stageId,
        bytes: Buffer.from(audio.audio),
        mime: audioMime(audio.format),
        prefix: `tts-${action.id}`,
        signal: input.signal,
      });
      speech.audioId = audioId;
      (speech as LegacySpeechAction).audioUrl = audioId;
      generated += 1;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      // A hung provider must fail the tool call with the retryable timeout
      // error instead of degrading into a per-action failure: the remaining
      // actions would hit the same hung upstream and the session would wedge.
      if (error instanceof TTSRequestTimeoutError) throw error;
      failed.push({ id: action.id, reason: runFailureCode(error).errorCode });
    }
  }
  return {
    available: true,
    changed: generated > 0,
    generated,
    skipped,
    failed,
  };
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_DELAY_MS } from '@openmaic/generation';

import { DEFAULT_AGENT_TOOL_TIMEOUT_MS } from '@/lib/agent/runtime/tool-timeout';
import { TTSRateLimitError, TTSRequestTimeoutError } from '@/lib/audio/tts-providers';
import type { SceneTtsFailure } from '@/lib/server/agent-runtime/scene-tts';
import { runFailureCode, type RunFailureErrorCode } from '@/lib/server/generation/run/failure-code';
import { SCENE_MAX_RETRIES } from '@/lib/server/generation/run/retry';
import { ProviderQuotaExhaustedError } from '@/lib/server/provider-quota';
import type { Scene } from '@/lib/types/stage';

type ReasonMatchesClassifier = SceneTtsFailure['reason'] extends RunFailureErrorCode
  ? RunFailureErrorCode extends SceneTtsFailure['reason']
    ? true
    : never
  : never;
const reasonMatchesClassifier: ReasonMatchesClassifier = true;
void reasonMatchesClassifier;

const mocks = vi.hoisted(() => ({
  providers: vi.fn(),
  generate: vi.fn(),
  persist: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  resolveTTSModel: vi.fn(() => ''),
  slotTTSModel: vi.fn(() => ''),
}));
vi.mock('@/lib/server/model-config/media', async (original) => ({
  ...(await original<typeof import('@/lib/server/model-config/media')>()),
  serverMediaConnection: (...args: unknown[]) => mocks.providers(...args),
}));
vi.mock('@/lib/audio/tts-providers', async (original) => ({
  ...(await original<typeof import('@/lib/audio/tts-providers')>()),
  generateTTS: (...args: unknown[]) => mocks.generate(...args),
}));
vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: (...args: unknown[]) => mocks.persist(...args),
}));

import { synthesizeSceneNarration } from '@/lib/server/agent-runtime/scene-tts';

/** Parallel agent calls must share one in-flight provider request, not one each. */
const IN_FLIGHT_CAP = 1;
const PARALLEL_CALLS = 8;

const RAW_PROVIDER_BODY = 'RAW_PROVIDER_BODY {"base_resp":{"status_msg":"secret-upstream"}}';

const connection = {
  providerId: 'configured-tts',
  managed: true,
  userEndpoint: false,
  origin: 'configuration',
};

function scene(id: string): Scene {
  return {
    id: `scene-${id}`,
    stageId: 'stage-a',
    order: 1,
    title: 'A',
    type: 'slide',
    content: { type: 'slide' },
    actions: [{ id: `speech-${id}`, type: 'speech', text: 'Hello' }],
  } as Scene;
}

describe('agent TTS in-flight cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providers.mockResolvedValue(connection);
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts.mp3');
  });

  it('never has more provider calls in flight than the shared cap', async () => {
    expect(IN_FLIGHT_CAP).toBeLessThan(PARALLEL_CALLS);

    let inFlight = 0;
    let peak = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.generate.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await gate;
        return { audio: new Uint8Array([1]), format: 'mp3' };
      } finally {
        inFlight -= 1;
      }
    });

    const pending = Promise.all(
      Array.from({ length: PARALLEL_CALLS }, (_, index) =>
        synthesizeSceneNarration({
          scene: scene(String(index)),
          force: false,
          ownerId: 'user:alice',
        }),
      ),
    );

    try {
      await vi.waitFor(() =>
        expect(mocks.generate.mock.calls.length).toBeGreaterThanOrEqual(IN_FLIGHT_CAP),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(peak).toBe(IN_FLIGHT_CAP);
      expect(inFlight).toBeLessThanOrEqual(IN_FLIGHT_CAP);
    } finally {
      release();
    }

    const summaries = await pending;
    expect(peak).toBe(IN_FLIGHT_CAP);
    expect(summaries).toHaveLength(PARALLEL_CALLS);
    expect(
      summaries.every((summary) => summary.generated === 1 && summary.failed.length === 0),
    ).toBe(true);
  });

  it('caps each provider id even when two owners share it', async () => {
    mocks.providers.mockImplementation(async (_kind: unknown, ownerId: unknown) => ({
      ...connection,
      providerId: ownerId === 'user:b' ? 'provider-b' : 'provider-a',
    }));
    let inFlightA = 0;
    let inFlightB = 0;
    let peakA = 0;
    let peakB = 0;
    let peakTotal = 0;
    let releaseA = () => {};
    let releaseB = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    mocks.generate.mockImplementation(async (config: { providerId?: string }) => {
      const providerA = config.providerId === 'provider-a';
      if (providerA) inFlightA += 1;
      else inFlightB += 1;
      peakA = Math.max(peakA, inFlightA);
      peakB = Math.max(peakB, inFlightB);
      peakTotal = Math.max(peakTotal, inFlightA + inFlightB);
      try {
        await (providerA ? gateA : gateB);
        return { audio: new Uint8Array([1]), format: 'mp3' };
      } finally {
        if (providerA) inFlightA -= 1;
        else inFlightB -= 1;
      }
    });

    const pending = Promise.all([
      synthesizeSceneNarration({ scene: scene('a1'), force: false, ownerId: 'user:a' }),
      synthesizeSceneNarration({ scene: scene('c1'), force: false, ownerId: 'user:c' }),
      synthesizeSceneNarration({ scene: scene('b1'), force: false, ownerId: 'user:b' }),
    ]);
    try {
      await vi.waitFor(() => expect(mocks.generate.mock.calls.length).toBeGreaterThanOrEqual(2));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(peakA).toBe(1);
      expect(peakB).toBe(1);
      expect(peakTotal).toBe(2);
      expect(mocks.generate.mock.calls.length).toBe(2);
    } finally {
      releaseA();
      releaseB();
    }
    const summaries = await pending;
    expect(peakA).toBe(1);
    expect(peakB).toBe(1);
    expect(peakTotal).toBe(2);
    expect(summaries.every((summary) => summary.generated === 1)).toBe(true);
  });

  it('samples the in-flight count during a Retry-After sleep and stays within the cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const samplesDuringSleep: number[] = [];
    const limited = new Set<string>();
    let releaseSleep = () => {};
    const sleepGate = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    let enteredSleep: () => void = () => {};
    const sleepStarted = new Promise<void>((resolve) => {
      enteredSleep = resolve;
    });
    mocks.generate.mockImplementation(async (_config: unknown, text: unknown) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        const key = String(text);
        if (!limited.has(key)) {
          limited.add(key);
          throw new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000);
        }
        return { audio: new Uint8Array([1]), format: 'mp3' };
      } finally {
        inFlight -= 1;
      }
    });

    const sleep = async (ms: number) => {
      expect(ms).toBeGreaterThanOrEqual(5_000);
      expect(ms).toBeLessThanOrEqual(DEFAULT_MAX_DELAY_MS);
      samplesDuringSleep.push(inFlight);
      enteredSleep();
      await sleepGate;
      samplesDuringSleep.push(inFlight);
    };
    const pending = Promise.all([
      synthesizeSceneNarration({
        scene: scene('a'),
        force: false,
        ownerId: 'user:alice',
        sleep,
      }),
      synthesizeSceneNarration({
        scene: scene('b'),
        force: false,
        ownerId: 'user:alice',
        sleep,
      }),
    ]);

    try {
      await sleepStarted;
      await new Promise((resolve) => setTimeout(resolve, 40));
      samplesDuringSleep.push(inFlight);
      expect(inFlight).toBeLessThanOrEqual(IN_FLIGHT_CAP);
      expect(peak).toBeLessThanOrEqual(IN_FLIGHT_CAP);
      expect(mocks.generate).toHaveBeenCalledTimes(1);
    } finally {
      releaseSleep();
    }

    const summaries = await pending;
    expect(samplesDuringSleep.length).toBeGreaterThan(0);
    expect(samplesDuringSleep.every((count) => count <= IN_FLIGHT_CAP)).toBe(true);
    expect(peak).toBe(IN_FLIGHT_CAP);
    expect(
      summaries.every((summary) => summary.generated === 1 && summary.failed.length === 0),
    ).toBe(true);
  });
});

describe('agent TTS failure classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providers.mockResolvedValue(connection);
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts.mp3');
  });

  it.each([
    {
      label: 'provider quota',
      reason: 'PROVIDER_QUOTA_EXHAUSTED',
      makeError: () => new ProviderQuotaExhaustedError('MiniMax', RAW_PROVIDER_BODY),
    },
    {
      label: 'typed rate limit',
      reason: 'RATE_LIMITED',
      makeError: () => new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY),
    },
    {
      label: 'upstream auth status',
      reason: 'UPSTREAM_ERROR',
      makeError: () => Object.assign(new Error(RAW_PROVIDER_BODY), { statusCode: 401 }),
    },
    {
      label: 'http 429',
      reason: 'RATE_LIMITED',
      makeError: () => Object.assign(new Error(RAW_PROVIDER_BODY), { statusCode: 429 }),
    },
    {
      label: 'other provider failure',
      reason: 'INTERNAL_ERROR',
      makeError: () => new Error(RAW_PROVIDER_BODY),
    },
  ])('records $label as { id, reason } ($reason)', async ({ makeError, reason }) => {
    const error = makeError();
    mocks.generate.mockRejectedValue(error);

    const summary = await synthesizeSceneNarration({
      scene: scene('a'),
      force: false,
      ownerId: 'user:alice',
      sleep: async () => {},
    });

    expect(summary.failed).toEqual([{ id: 'speech-a', reason }]);
    expect(reason).toBe(runFailureCode(error).errorCode);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
    expect(JSON.stringify(summary)).not.toContain('secret-upstream');
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('still aborts the call on TTSRequestTimeoutError', async () => {
    mocks.generate.mockRejectedValue(new TTSRequestTimeoutError('MiniMax', 'request timed out'));

    await expect(
      synthesizeSceneNarration({
        scene: scene('a'),
        force: false,
        ownerId: 'user:alice',
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(TTSRequestTimeoutError);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
});

describe('agent TTS classroom retry throttle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providers.mockResolvedValue(connection);
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts.mp3');
  });

  function speeches(ids: string[]): Scene {
    return {
      ...scene('page'),
      actions: ids.map((id) => ({ id, type: 'speech', text: id })),
    } as Scene;
  }

  it('sleeps for Retry-After before the next speech line and retries the limited line', async () => {
    const events: string[] = [];
    let calls = 0;
    mocks.generate.mockImplementation(async (_config: unknown, text: unknown) => {
      calls += 1;
      events.push(`generate:${String(text)}`);
      if (calls === 1) throw new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000);
      return { audio: new Uint8Array([1]), format: 'mp3' };
    });

    const summary = await synthesizeSceneNarration({
      scene: speeches(['speech-1', 'speech-2']),
      force: false,
      ownerId: 'user:alice',
      sleep: async (ms) => {
        events.push(`sleep:${ms}`);
      },
    });

    expect(events[0]).toBe('generate:speech-1');
    expect(events[1]?.startsWith('sleep:')).toBe(true);
    expect(Number(events[1]?.slice('sleep:'.length))).toBeGreaterThanOrEqual(5_000);
    expect(events[2]).toBe('generate:speech-1');
    expect(events[3]).toBe('generate:speech-2');
    expect(summary.generated).toBe(2);
    expect(summary.failed).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
  });

  it('clamps a Retry-After larger than the classroom backoff cap', async () => {
    const huge = DEFAULT_AGENT_TOOL_TIMEOUT_MS * 2;
    const sleeps: number[] = [];
    mocks.generate.mockRejectedValue(new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, huge));

    const summary = await synthesizeSceneNarration({
      scene: scene('a'),
      force: false,
      ownerId: 'user:alice',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(huge).toBeGreaterThan(DEFAULT_MAX_DELAY_MS);
    expect(sleeps).toHaveLength(SCENE_MAX_RETRIES);
    expect(sleeps.every((ms) => ms === DEFAULT_MAX_DELAY_MS)).toBe(true);
    expect(summary.failed).toEqual([{ id: 'speech-a', reason: 'RATE_LIMITED' }]);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
  });

  it('fails the line instead of sleeping when the remaining budget cannot fit the wait', async () => {
    const sleeps: number[] = [];
    mocks.generate.mockRejectedValue(new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000));

    const summary = await synthesizeSceneNarration({
      scene: scene('a'),
      force: false,
      ownerId: 'user:alice',
      budgetMs: 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toEqual([]);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(summary.failed).toEqual([{ id: 'speech-a', reason: 'RATE_LIMITED' }]);
    expect(summary.generated).toBe(0);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
  });

  it('still aborts on TTSRequestTimeoutError when the remaining budget is too small to wait', async () => {
    mocks.generate.mockRejectedValue(new TTSRequestTimeoutError('MiniMax', 'request timed out'));

    await expect(
      synthesizeSceneNarration({
        scene: scene('a'),
        force: false,
        ownerId: 'user:alice',
        budgetMs: 1,
        sleep: async () => {
          throw new Error('slept');
        },
      }),
    ).rejects.toBeInstanceOf(TTSRequestTimeoutError);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it('uses the classroom narration retry budget before recording a rate limit', async () => {
    const sleeps: number[] = [];
    mocks.generate.mockRejectedValue(new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000));

    const summary = await synthesizeSceneNarration({
      scene: scene('a'),
      force: false,
      ownerId: 'user:alice',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(mocks.generate).toHaveBeenCalledTimes(SCENE_MAX_RETRIES + 1);
    expect(sleeps).toHaveLength(SCENE_MAX_RETRIES);
    expect(sleeps.every((ms) => ms >= 5_000)).toBe(true);
    expect(summary.failed).toEqual([{ id: 'speech-a', reason: 'RATE_LIMITED' }]);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
  });

  it('does not retry a rate-limit error whose cause is quota exhaustion', async () => {
    const error = new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000, {
      cause: new ProviderQuotaExhaustedError('MiniMax', RAW_PROVIDER_BODY),
    });
    const sleeps: number[] = [];
    mocks.generate.mockRejectedValue(error);

    const summary = await synthesizeSceneNarration({
      scene: scene('a'),
      force: false,
      ownerId: 'user:alice',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(summary.failed).toEqual([{ id: 'speech-a', reason: 'PROVIDER_QUOTA_EXHAUSTED' }]);
    expect(summary.failed[0]?.reason).toBe(runFailureCode(error).errorCode);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
  });
});

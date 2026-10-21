import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TTSRateLimitError, TTSRequestTimeoutError } from '@/lib/audio/tts-providers';
import { runFailureCode } from '@/lib/server/generation/run/failure-code';
import { ProviderQuotaExhaustedError } from '@/lib/server/provider-quota';
import type { Scene } from '@/lib/types/stage';

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
      synthesizeSceneNarration({ scene: scene('a'), force: false, ownerId: 'user:alice' }),
    ).rejects.toBeInstanceOf(TTSRequestTimeoutError);
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});

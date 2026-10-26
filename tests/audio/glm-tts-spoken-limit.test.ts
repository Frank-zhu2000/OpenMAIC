import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { generateTTS } from '@/lib/audio/tts-providers';
import { normalizeMathSymbolsForTts } from '@/lib/audio/tts-utils';

const mockFetch = vi.hoisted(() => vi.fn() as Mock);

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

function audioResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'audio/wav' },
    arrayBuffer: async () => new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer,
  };
}

function glmConfig(voices?: { id: string; name: string; language: string }[]) {
  return {
    providerId: 'glm-tts' as const,
    apiKey: 'glm-key',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    voice: 'tongtong',
    ...(voices ? { voices } : {}),
  };
}

describe('GLM TTS spoken length', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(audioResponse());
  });

  it('does not send a direct GLM request when Chinese pronunciation exceeds 1024 characters', async () => {
    const caption = 'x'.repeat(1023) + 'α';
    expect(caption).toHaveLength(1024);
    expect(normalizeMathSymbolsForTts(caption, 'zh')).toHaveLength(1026);
    expect(caption.endsWith('α')).toBe(true);

    await expect(generateTTS(glmConfig(), caption)).rejects.toThrow(/1024/);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(caption).toBe('x'.repeat(1023) + 'α');
  });

  it('still sends a caption whose spoken form is exactly 1024 characters', async () => {
    const caption = 'x'.repeat(1021) + 'α';
    expect(normalizeMathSymbolsForTts(caption, 'zh')).toHaveLength(1024);

    await generateTTS(glmConfig(), caption);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as { input: string };
    expect(body.input).toHaveLength(1024);
    expect(body.input.endsWith('阿尔法')).toBe(true);
    expect(caption.endsWith('α')).toBe(true);
  });

  it('still sends an unexpanded Greek reading that fits, using the two-argument call', async () => {
    const caption = 'x'.repeat(1023) + 'α';

    await generateTTS(
      glmConfig([{ id: 'tongtong', name: 'Tongtong', language: 'el-GR' }]),
      caption,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as { input: string };
    expect(body.input).toBe(caption);
    expect(body.input).toHaveLength(1024);
  });
});

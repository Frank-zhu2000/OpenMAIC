/**
 * Generated agents must not keep a catalog voice of the opposite gender.
 * MiniMax names its voices in Chinese, so the model cannot infer gender from
 * the display name when the course is in another language.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaConnection } from '@/lib/server/model-config/media';
import {
  advertisedVoices,
  type RunNarrationTarget,
} from '@/lib/server/generation/run/narration-voice';
import {
  generateAgentProfiles,
  type AgentProfilesInput,
} from '@/lib/server/generation/steps/agent-profiles';

import { fakeModel, testLogger } from './helpers';

const callLLM = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/llm', () => ({
  callLLM: (...args: unknown[]) => callLLM(...args),
}));

type VoiceGender = 'male' | 'female' | 'neutral';

/** MiniMax-style catalogue: Chinese display names, gender only on the entry. */
const MINIMAX_VOICES: NonNullable<AgentProfilesInput['availableVoices']> = [
  {
    providerId: 'minimax-tts',
    voiceId: 'English_Graceful_Lady',
    voiceName: 'Graceful Lady',
    voiceLanguage: 'en-US',
    gender: 'female',
  },
  {
    providerId: 'minimax-tts',
    voiceId: 'female-yujie',
    voiceName: '御姐音色',
    voiceLanguage: 'zh-CN',
    gender: 'female',
  },
  {
    providerId: 'minimax-tts',
    voiceId: 'male-qn-jingying',
    voiceName: '精英青年',
    voiceLanguage: 'zh-CN',
    gender: 'male',
  },
  {
    providerId: 'minimax-tts',
    voiceId: 'female-shaonv',
    voiceName: '少女音色',
    voiceLanguage: 'zh-CN',
    gender: 'female',
  },
  {
    providerId: 'minimax-tts',
    voiceId: 'Chinese (Mandarin)_Gentleman',
    voiceName: '温润男声',
    voiceLanguage: 'zh-CN',
    gender: 'male',
  },
  {
    providerId: 'minimax-tts',
    voiceId: 'English_expressive_narrator',
    voiceName: 'Expressive Narrator',
    voiceLanguage: 'en-US',
    gender: 'neutral',
  },
  {
    providerId: 'minimax-tts',
    voiceId: 'custom-clone',
    voiceName: '未标注音色',
    voiceLanguage: 'zh-CN',
  },
];

const minimaxTarget: RunNarrationTarget = {
  connection: {
    providerId: 'minimax-tts',
    managed: true,
    userEndpoint: false,
    origin: 'configuration',
  } as MediaConnection,
  providerId: 'minimax-tts',
};

function token(voiceId: string): string {
  return `minimax-tts::${voiceId}`;
}

function profile(extra: Record<string, unknown> & { name: string; role: string }) {
  return {
    persona: 'Takes part in the class.',
    avatar: '/a.png',
    color: '#111111',
    priority: extra.role === 'teacher' ? 10 : 5,
    voiceDesign: {
      identity: 'middle-aged female teacher',
      texture: 'warm low',
      delivery: 'calm',
    },
    ...extra,
  };
}

async function generate(agents: unknown[], extra: Partial<AgentProfilesInput> = {}) {
  callLLM.mockResolvedValue({ text: JSON.stringify({ agents }) });
  return generateAgentProfiles(
    {
      stageInfo: { name: 'Intro to Algebra' },
      languageDirective: 'Respond in European Portuguese.',
      availableAvatars: ['/a.png', '/b.png'],
      availableVoices: MINIMAX_VOICES,
      model: fakeModel(),
      ...extra,
    },
    { log: testLogger() },
  );
}

function voiceListFromPrompt(): Array<{ name: string; gender?: VoiceGender }> {
  const prompt = callLLM.mock.calls[0][0].prompt as string;
  const marker = 'from this list: ';
  const start = prompt.lastIndexOf(marker);
  const json = prompt.slice(start + marker.length, prompt.indexOf('\n', start));
  return JSON.parse(json);
}

describe('agent profiles — voice gender', () => {
  beforeEach(() => callLLM.mockReset());

  it('advertises MiniMax catalog gender, including Chinese voice names', () => {
    const voices = advertisedVoices(minimaxTarget);
    expect(voices.find((voice) => voice.voiceId === 'female-yujie')).toMatchObject({
      voiceName: '御姐音色',
      voiceLanguage: 'zh-CN',
      gender: 'female',
    });
    expect(voices.find((voice) => voice.voiceId === 'male-qn-jingying')?.gender).toBe('male');
  });

  it('tells the model each known voice gender and to match voiceDesign.identity', async () => {
    await generate([
      profile({ name: 'Lin', role: 'teacher', voice: token('male-qn-jingying') }),
      profile({
        name: 'Sam',
        role: 'student',
        voice: token('female-shaonv'),
        voiceDesign: { identity: 'young male student', texture: 'bright', delivery: 'quick' },
      }),
    ]);

    const prompt = callLLM.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("The voice's gender must match the agent's voiceDesign.identity");
    const list = voiceListFromPrompt();
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '御姐音色', gender: 'female' }),
        expect.objectContaining({ name: '精英青年', gender: 'male' }),
        expect.objectContaining({ name: 'Expressive Narrator', gender: 'neutral' }),
      ]),
    );
    expect(list.find((voice) => voice.name === '未标注音色')).not.toHaveProperty('gender');
  });

  it("tells the model to keep the agent's name and persona consistent with the matched gender", async () => {
    const agents = [
      profile({ name: 'Lin', role: 'teacher', voice: token('male-qn-jingying') }),
      profile({
        name: 'Sam',
        role: 'student',
        voice: token('female-shaonv'),
        voiceDesign: { identity: 'young male student', texture: 'bright', delivery: 'quick' },
      }),
    ];
    const required = "Keep the agent's name and persona consistent with that gender";

    await generate(agents);
    const openAssignment = callLLM.mock.calls[0][0].prompt as string;
    expect(openAssignment).toContain(required);

    await generate(agents, {
      narratorVoice: { providerId: 'minimax-tts', voiceId: 'female-yujie' },
    });
    const pinnedTeacher = callLLM.mock.calls[1][0].prompt as string;
    expect(pinnedTeacher).toContain(required);
  });

  it('swaps a female identity off a male Chinese voice to an unused same-language female voice', async () => {
    const agents = await generate([
      profile({ name: 'Lin', role: 'teacher', voice: token('male-qn-jingying') }),
      profile({
        name: 'Sam',
        role: 'student',
        voice: token('Chinese (Mandarin)_Gentleman'),
        voiceDesign: { identity: 'young male student', texture: 'bright', delivery: 'quick' },
      }),
    ]);

    // English_Graceful_Lady is earlier in the list; 御姐音色 matches zh-CN.
    expect(agents[0].voiceConfig).toEqual({ providerId: 'minimax-tts', voiceId: 'female-yujie' });
    expect(agents[1].voiceConfig).toEqual({
      providerId: 'minimax-tts',
      voiceId: 'Chinese (Mandarin)_Gentleman',
    });
  });

  it('swaps a male identity off a female voice and keeps an already matching voice', async () => {
    const agents = await generate([
      profile({ name: 'Lin', role: 'teacher', voice: token('female-yujie') }),
      profile({
        name: 'Sam',
        role: 'student',
        voice: token('female-shaonv'),
        voiceDesign: { identity: 'young male student', texture: 'bright', delivery: 'quick' },
      }),
    ]);

    expect(agents[0].voiceConfig).toEqual({ providerId: 'minimax-tts', voiceId: 'female-yujie' });
    expect(agents[1].voiceConfig).toEqual({
      providerId: 'minimax-tts',
      voiceId: 'male-qn-jingying',
    });
  });

  it('does not reuse a voice already assigned, including the fixed narrator voice', async () => {
    const agents = await generate(
      [
        profile({ name: 'Lin', role: 'teacher' }),
        profile({
          name: 'Ana',
          role: 'student',
          voice: token('male-qn-jingying'),
          voiceDesign: { identity: 'young female student', texture: 'bright', delivery: 'quick' },
        }),
        profile({
          name: 'Bao',
          role: 'student',
          voice: token('Chinese (Mandarin)_Gentleman'),
          voiceDesign: { identity: 'young female student', texture: 'light', delivery: 'lively' },
        }),
      ],
      { narratorVoice: { providerId: 'minimax-tts', voiceId: 'female-yujie' } },
    );

    expect(agents[0].voiceConfig).toEqual({ providerId: 'minimax-tts', voiceId: 'female-yujie' });
    // Same-language 少女音色, not the narrator 御姐音色 and not the earlier English voice.
    expect(agents[1].voiceConfig).toEqual({ providerId: 'minimax-tts', voiceId: 'female-shaonv' });
    // Both Chinese female voices are taken, so Bao falls back to the English female voice.
    expect(agents[2].voiceConfig).toEqual({
      providerId: 'minimax-tts',
      voiceId: 'English_Graceful_Lady',
    });
    const prompt = callLLM.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("The voice's gender must match the agent's voiceDesign.identity");
  });

  it('leaves a voice with unknown or neutral gender as-is', async () => {
    const agents = await generate([
      profile({
        name: 'Lin',
        role: 'teacher',
        voice: token('custom-clone'),
        voiceDesign: { identity: 'middle-aged female teacher', texture: 'warm', delivery: 'calm' },
      }),
      profile({
        name: 'Sam',
        role: 'student',
        voice: token('English_expressive_narrator'),
        voiceDesign: { identity: 'young male student', texture: 'bright', delivery: 'quick' },
      }),
    ]);

    expect(agents[0].voiceConfig).toEqual({ providerId: 'minimax-tts', voiceId: 'custom-clone' });
    expect(agents[1].voiceConfig).toEqual({
      providerId: 'minimax-tts',
      voiceId: 'English_expressive_narrator',
    });
  });

  it('leaves a localized identity that does not say male or female unchanged', async () => {
    const agents = await generate([
      profile({
        name: 'Lúcia',
        role: 'teacher',
        voice: token('male-qn-jingying'),
        voiceDesign: {
          identity: 'professora de meia-idade',
          texture: 'calorosa',
          delivery: 'calma',
        },
      }),
      profile({
        name: 'Rui',
        role: 'student',
        voice: token('female-shaonv'),
        voiceDesign: {
          identity: 'aluno adolescente',
          texture: 'clara',
          delivery: 'rápida',
        },
      }),
    ]);

    // One identity sits on a male voice and one on a female voice. Treating
    // either "no English gender word" as male or as female would move one of them.
    expect(agents[0].voiceConfig).toEqual({
      providerId: 'minimax-tts',
      voiceId: 'male-qn-jingying',
    });
    expect(agents[1].voiceConfig).toEqual({
      providerId: 'minimax-tts',
      voiceId: 'female-shaonv',
    });
  });

  it('does not reassign the fixed narrator voice when its gender conflicts', async () => {
    const agents = await generate(
      [
        profile({
          name: 'Lin',
          role: 'teacher',
          voice: token('female-yujie'),
          voiceDesign: {
            identity: 'middle-aged female teacher',
            texture: 'warm low',
            delivery: 'calm',
          },
        }),
        profile({
          name: 'Sam',
          role: 'student',
          voice: token('female-shaonv'),
          voiceDesign: { identity: 'young female student', texture: 'bright', delivery: 'quick' },
        }),
      ],
      { narratorVoice: { providerId: 'minimax-tts', voiceId: 'male-qn-jingying' } },
    );

    expect(agents[0].voiceConfig).toEqual({
      providerId: 'minimax-tts',
      voiceId: 'male-qn-jingying',
    });
    expect(agents[1].voiceConfig).toEqual({ providerId: 'minimax-tts', voiceId: 'female-shaonv' });
  });

  it('falls back to another language when no same-language voice of the matching gender is free', async () => {
    const agents = await generate(
      [
        profile({ name: 'Lin', role: 'teacher', voice: token('male-qn-jingying') }),
        profile({
          name: 'Sam',
          role: 'student',
          voice: token('Chinese (Mandarin)_Gentleman'),
          voiceDesign: { identity: 'young male student', texture: 'bright', delivery: 'quick' },
        }),
      ],
      {
        availableVoices: [
          {
            providerId: 'minimax-tts',
            voiceId: 'male-qn-jingying',
            voiceName: '精英青年',
            voiceLanguage: 'zh-CN',
            gender: 'male',
          },
          {
            providerId: 'minimax-tts',
            voiceId: 'Chinese (Mandarin)_Gentleman',
            voiceName: '温润男声',
            voiceLanguage: 'zh-CN',
            gender: 'male',
          },
          {
            providerId: 'minimax-tts',
            modelId: 'speech-2.8-hd',
            voiceId: 'English_Graceful_Lady',
            voiceName: 'Graceful Lady',
            voiceLanguage: 'en-US',
            gender: 'female',
          },
        ],
      },
    );

    expect(agents[0].voiceConfig).toEqual({
      providerId: 'minimax-tts',
      modelId: 'speech-2.8-hd',
      voiceId: 'English_Graceful_Lady',
    });
  });

  it('does not gender-match a catalogue of only neutral voices', async () => {
    const googleTarget: RunNarrationTarget = {
      connection: {
        providerId: 'google-tts',
        managed: true,
        userEndpoint: false,
        origin: 'configuration',
      } as MediaConnection,
      providerId: 'google-tts',
    };
    const voxTarget: RunNarrationTarget = {
      connection: {
        providerId: 'voxcpm-tts',
        managed: true,
        userEndpoint: false,
        origin: 'configuration',
      } as MediaConnection,
      providerId: 'voxcpm-tts',
    };
    const googleVoices = advertisedVoices(googleTarget);
    const voxVoices = advertisedVoices(voxTarget);
    expect(googleVoices.length).toBeGreaterThan(1);
    expect(googleVoices.every((voice) => voice.gender === 'neutral')).toBe(true);
    expect(voxVoices.map((voice) => voice.voiceId)).toEqual(['voxcpm:auto']);
    expect(voxVoices[0]?.gender).toBe('neutral');

    const match = "The voice's gender must match the agent's voiceDesign.identity";
    const persona = "Keep the agent's name and persona consistent with that gender";

    const googleAgents = await generate(
      [
        profile({
          name: 'Lin',
          role: 'teacher',
          voice: `google-tts::${googleVoices[0].voiceId}`,
          voiceDesign: {
            identity: 'middle-aged female teacher',
            texture: 'warm',
            delivery: 'calm',
          },
        }),
        profile({
          name: 'Sam',
          role: 'student',
          voice: `google-tts::${googleVoices[1].voiceId}`,
          voiceDesign: { identity: 'young male student', texture: 'bright', delivery: 'quick' },
        }),
      ],
      { availableVoices: googleVoices },
    );
    const googlePrompt = callLLM.mock.calls.at(-1)?.[0].prompt as string;
    expect(googlePrompt).not.toContain(match);
    expect(googlePrompt).not.toContain(persona);
    expect(googlePrompt).toContain('"gender":"neutral"');
    expect(googleAgents[0].voiceConfig).toEqual({
      providerId: 'google-tts',
      voiceId: googleVoices[0].voiceId,
    });
    expect(googleAgents[1].voiceConfig).toEqual({
      providerId: 'google-tts',
      voiceId: googleVoices[1].voiceId,
    });

    await generate(
      [
        profile({
          name: 'Lin',
          role: 'teacher',
          voiceDesign: {
            identity: 'middle-aged female teacher',
            texture: 'warm',
            delivery: 'calm',
          },
        }),
        profile({
          name: 'Sam',
          role: 'student',
          voice: 'voxcpm-tts::voxcpm:auto',
          voiceDesign: { identity: 'young male student', texture: 'bright', delivery: 'quick' },
        }),
      ],
      {
        availableVoices: voxVoices,
        narratorVoice: { providerId: 'voxcpm-tts', voiceId: 'voxcpm:auto' },
      },
    );
    const voxPrompt = callLLM.mock.calls.at(-1)?.[0].prompt as string;
    expect(voxPrompt).not.toContain(match);
    expect(voxPrompt).not.toContain(persona);
    expect(voxPrompt).toContain('voxcpm:auto');
    expect(voxPrompt).toContain('"gender":"neutral"');
  });

  it('scopes gender matching to male and female voices when the catalogue is mixed', async () => {
    await generate([
      profile({ name: 'Lin', role: 'teacher', voice: token('male-qn-jingying') }),
      profile({
        name: 'Sam',
        role: 'student',
        voice: token('English_expressive_narrator'),
        voiceDesign: { identity: 'young male student', texture: 'bright', delivery: 'quick' },
      }),
    ]);
    const prompt = callLLM.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("The voice's gender must match the agent's voiceDesign.identity");
    expect(prompt).toContain('A neutral voice, or a voice with no gender, is not mismatched');
  });

  /** OpenAI-shaped pool: two male voices, then the two female voices are not adjacent. */
  const OPENAI_VOICES: NonNullable<AgentProfilesInput['availableVoices']> = [
    {
      providerId: 'openai-tts',
      voiceId: 'echo',
      voiceName: 'Echo',
      voiceLanguage: 'en',
      gender: 'male',
    },
    {
      providerId: 'openai-tts',
      voiceId: 'nova',
      voiceName: 'Nova',
      voiceLanguage: 'en',
      gender: 'female',
    },
    {
      providerId: 'openai-tts',
      voiceId: 'onyx',
      voiceName: 'Onyx',
      voiceLanguage: 'en',
      gender: 'male',
    },
    {
      providerId: 'openai-tts',
      voiceId: 'shimmer',
      voiceName: 'Shimmer',
      voiceLanguage: 'en',
      gender: 'female',
    },
  ];

  function openaiToken(voiceId: string): string {
    return `openai-tts::${voiceId}`;
  }

  it('frees a matching voice held by a later opposite-gender agent and reassigns everyone', async () => {
    const agents = await generate(
      [
        profile({
          name: 'Lin',
          role: 'teacher',
          voice: openaiToken('echo'),
          voiceDesign: {
            identity: 'middle-aged female teacher',
            texture: 'warm',
            delivery: 'calm',
          },
        }),
        profile({
          name: 'Sam',
          role: 'student',
          voice: openaiToken('nova'),
          voiceDesign: { identity: 'young male student', texture: 'bright', delivery: 'quick' },
        }),
        profile({
          name: 'Bao',
          role: 'student',
          voice: openaiToken('shimmer'),
          voiceDesign: { identity: 'young male student', texture: 'light', delivery: 'lively' },
        }),
      ],
      { availableVoices: OPENAI_VOICES },
    );

    // One left-to-right pass leaves echo / onyx / shimmer: the female agent
    // gives up while both female voices are still held, then a male agent
    // moves onto onyx and frees nova too late.
    expect(agents.map((entry) => entry.voiceConfig?.voiceId)).toEqual(['nova', 'echo', 'onyx']);
  });

  it('reassigns a full opposite-gender permutation when every catalogue voice is already in use', async () => {
    const agents = await generate(
      [
        profile({
          name: 'Lin',
          role: 'teacher',
          voice: openaiToken('echo'),
          voiceDesign: {
            identity: 'middle-aged female teacher',
            texture: 'warm',
            delivery: 'calm',
          },
        }),
        profile({
          name: 'Sam',
          role: 'student',
          voice: openaiToken('nova'),
          voiceDesign: { identity: 'young male student', texture: 'bright', delivery: 'quick' },
        }),
        profile({
          name: 'Ana',
          role: 'student',
          voice: openaiToken('onyx'),
          voiceDesign: {
            identity: 'young female student',
            texture: 'bright',
            delivery: 'quick',
          },
        }),
        profile({
          name: 'Bao',
          role: 'student',
          voice: openaiToken('shimmer'),
          voiceDesign: { identity: 'young male student', texture: 'light', delivery: 'lively' },
        }),
      ],
      { availableVoices: OPENAI_VOICES },
    );

    expect(agents.map((entry) => entry.voiceConfig?.voiceId)).toEqual([
      'nova',
      'echo',
      'shimmer',
      'onyx',
    ]);
  });
});

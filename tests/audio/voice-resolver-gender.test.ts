/**
 * When a generated agent's voice is missing or invalid, the fallback must
 * prefer a catalog voice of that agent's gender. A catalogue with no gender
 * data keeps the index pick.
 */
import { describe, expect, it } from 'vitest';

import {
  getEnabledProvidersWithVoices,
  resolveAgentVoice,
  type ProviderWithVoices,
} from '@/lib/audio/voice-resolver';
import type { AgentConfig } from '@/lib/orchestration/registry/types';

function agent(partial: Partial<AgentConfig>): AgentConfig {
  return partial as AgentConfig;
}

function withIdentity(identity: string, voiceConfig?: AgentConfig['voiceConfig']): AgentConfig {
  return agent({
    voiceConfig,
    voiceDesign: { identity, texture: 'warm', delivery: 'calm' },
  });
}

/** Index 0 is male, so a gender-blind pick cannot satisfy a female agent. */
const gendered: ProviderWithVoices = {
  providerId: 'openai-tts',
  providerName: 'OpenAI TTS',
  voices: [
    { id: 'lead-male', name: 'Lead Male', gender: 'male' },
    { id: 'lead-female', name: 'Lead Female', gender: 'female' },
    { id: 'second-female', name: 'Second Female', gender: 'female' },
    { id: 'narrator', name: 'Narrator', gender: 'neutral' },
  ],
  modelGroups: [],
};

/** Same order, no gender field — the catalogue cannot prefer a gender. */
const ungendered: ProviderWithVoices = {
  providerId: 'custom-tts-lab',
  providerName: 'Lab',
  voices: [
    { id: 'v0', name: 'Zero' },
    { id: 'v1', name: 'One' },
  ],
  modelGroups: [],
};

describe('resolveAgentVoice gender fallback', () => {
  it('picks a female voice when the choice is missing and index 0 is male', () => {
    expect(resolveAgentVoice(withIdentity('middle-aged female teacher'), 0, [gendered])).toEqual({
      providerId: 'openai-tts',
      voiceId: 'lead-female',
    });
  });

  it('picks a female voice when the stored choice is not in the catalogue', () => {
    const resolved = resolveAgentVoice(
      withIdentity('middle-aged female teacher', {
        providerId: 'openai-tts',
        voiceId: 'not-in-list',
      }),
      0,
      [gendered],
    );
    expect(resolved).toEqual({ providerId: 'openai-tts', voiceId: 'lead-female' });
  });

  it('keeps a valid voice even when its gender differs from the agent', () => {
    expect(
      resolveAgentVoice(
        withIdentity('middle-aged female teacher', {
          providerId: 'openai-tts',
          voiceId: 'lead-male',
        }),
        0,
        [gendered],
      ),
    ).toEqual({ providerId: 'openai-tts', modelId: undefined, voiceId: 'lead-male' });
  });

  it('uses the agent index inside the same-gender voices', () => {
    expect(resolveAgentVoice(withIdentity('young female student'), 1, [gendered])?.voiceId).toBe(
      'second-female',
    );
  });

  it('does not treat a neutral voice as a female match', () => {
    const neutralFirst: ProviderWithVoices = {
      ...gendered,
      voices: [
        { id: 'narrator', name: 'Narrator', gender: 'neutral' },
        { id: 'lead-female', name: 'Lead Female', gender: 'female' },
      ],
    };
    expect(
      resolveAgentVoice(withIdentity('middle-aged female teacher'), 0, [neutralFirst])?.voiceId,
    ).toBe('lead-female');
  });

  it('falls back by index when no voice has the agent gender', () => {
    const malesOnly: ProviderWithVoices = {
      ...gendered,
      voices: [
        { id: 'only-male', name: 'Only', gender: 'male' },
        { id: 'also-male', name: 'Also', gender: 'male' },
      ],
    };
    expect(resolveAgentVoice(withIdentity('middle-aged female teacher'), 1, [malesOnly])).toEqual({
      providerId: 'openai-tts',
      voiceId: 'also-male',
    });
  });

  it('keeps the index pick when the catalogue has no gender data', () => {
    const female = withIdentity('middle-aged female teacher');
    expect(resolveAgentVoice(female, 0, [ungendered])).toEqual({
      providerId: 'custom-tts-lab',
      voiceId: 'v0',
    });
    expect(resolveAgentVoice(female, 1, [ungendered])?.voiceId).toBe('v1');
  });

  it('keeps the index pick when the identity does not say male or female', () => {
    expect(
      resolveAgentVoice(withIdentity('professora de meia-idade'), 0, [gendered])?.voiceId,
    ).toBe('lead-male');
  });

  it('uses MiniMax catalog gender from the enabled provider list, not the index', () => {
    const providers = getEnabledProvidersWithVoices({
      'minimax-tts': { apiKey: 'k', enabled: true },
    });
    // Catalog order starts with 御姐音色 (female). A male agent must not land there.
    expect(resolveAgentVoice(withIdentity('young male student'), 0, providers)?.voiceId).toBe(
      'male-qn-jingying',
    );
    // Index 1 is 精英青年 (male). A female agent takes the second female voice.
    expect(resolveAgentVoice(withIdentity('young female student'), 1, providers)?.voiceId).toBe(
      'female-shaonv',
    );
  });

  it('skips a Qwen clone and a leading male catalog voice for a female agent', () => {
    const qwen: ProviderWithVoices = {
      providerId: 'qwen-tts',
      providerName: 'Qwen TTS',
      voices: [
        { id: 'clone-not-in-catalog', name: 'Clone', gender: 'female' },
        { id: 'Ethan', name: 'Ethan', gender: 'male' },
        { id: 'Cherry', name: 'Cherry', gender: 'female' },
      ],
      modelGroups: [],
    };
    expect(resolveAgentVoice(withIdentity('young female student'), 0, [qwen])).toEqual({
      providerId: 'qwen-tts',
      voiceId: 'Cherry',
    });
  });
});

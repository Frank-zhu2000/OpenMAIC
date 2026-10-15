import type { TTSProviderId } from '@/lib/audio/types';
import { isCustomTTSProvider } from '@/lib/audio/types';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  isQwenCatalogVoice,
  isQwenCloneVoice,
  isQwenVoiceCloneModel,
  DEFAULT_TTS_VOICES,
  resolveTTSModelForVoice,
  TTS_PROVIDERS,
  voiceServesModel,
} from '@/lib/audio/constants';
import {
  BROWSER_NATIVE_TTS_PROVIDER_ID,
  isTTSProviderEnabled,
  type TTSEnablementConfig,
} from '@/lib/audio/provider-enablement';
import {
  VOXCPM_TTS_PROVIDER_ID,
  getVoxCPMProfileVoiceId,
  normalizeVoxCPMBackend,
  voxCPMBackendSupportsReferenceAudio,
} from '@/lib/audio/voxcpm';
import { isVoiceBindingUnavailable } from '@/lib/audio/unavailable-voice-bindings';

export interface ResolvedVoice {
  providerId: TTSProviderId;
  modelId?: string;
  voiceId: string;
}

/** A user-picked voice for one agent (same shape as AgentConfig.voiceConfig). */
export interface AgentVoiceOverride {
  providerId: TTSProviderId;
  modelId?: string;
  voiceId: string;
}

/** Persisted per-agent voice picks, keyed by agent id (settings store). */
export type AgentVoiceOverrides = Record<string, AgentVoiceOverride>;

type ProviderConfigMap = Record<string, (TTSEnablementConfig & { modelId?: string }) | undefined>;

/** Prefer a persisted narrator binding, retaining the global fallback when it is unusable. */
export function resolveNarratorVoiceBinding(
  bound: AgentConfig['voiceConfig'] | undefined,
  globalVoice: ResolvedVoice,
  providerConfigs: ProviderConfigMap,
): ResolvedVoice {
  if (
    bound &&
    bound.voiceId.trim() &&
    isTTSProviderEnabled(bound.providerId, providerConfigs[bound.providerId]) &&
    // A voice the provider's model in use cannot speak is not usable.
    voiceServesModel(
      bound.providerId,
      bound.voiceId,
      providerConfigs[bound.providerId]?.modelId || bound.modelId,
    )
  ) {
    // Qwen clone IDs are account-scoped but self-contained: local IndexedDB is
    // not an authority. Catalog voices remain validated against the catalog.
    return {
      providerId: bound.providerId,
      modelId: resolveTTSModelForVoice(bound.providerId, bound.voiceId, bound.modelId),
      voiceId: bound.voiceId,
    };
  }
  return {
    ...globalVoice,
    modelId: resolveTTSModelForVoice(
      globalVoice.providerId,
      globalVoice.voiceId,
      globalVoice.modelId,
    ),
  };
}

/** Roster passed when several agents are resolved together. */
export interface ResolveAgentVoiceOptions {
  /**
   * Agents in the same order as `agentIndex`. When present, a male/female
   * fallback uses a per-gender ordinal and skips configured voices, the
   * lecture voice reserved for an unbound teacher, and earlier same-gender
   * fallbacks. Omit it to keep the index pick.
   */
  roster?: AgentConfig[];
  /**
   * Lecture voice an unbound teacher speaks. When it names a voice of the
   * fallback provider, that id is reserved. Omit it to reserve the catalogue
   * default, which discussion speaks when the user has not picked a voice.
   * The agent bar and discussion playback must pass the same value.
   */
  globalVoice?: { providerId: string; voiceId: string };
}

/**
 * Resolve the TTS provider + voice for an agent, choosing only among ENABLED
 * providers (`enabledProviders` is the output of getEnabledProvidersWithVoices,
 * which already excludes disabled/unconfigured providers and browser-native).
 *
 * 1. If the user picked a voice for this agent (persisted `overrides`, keyed by
 *    agent id) whose provider is in `enabledProviders` and can speak that id,
 *    use it. Browser-native accepts any id once enabled. Qwen accepts a catalog
 *    id or any non-empty id. Other providers must name a voice the enabled model
 *    offers. The agent's own voiceConfig is validated the same way next.
 * 2. Otherwise, deterministically pick the first enabled provider. When the
 *    catalogue lists the agent's gender, the pick stays in that male or female
 *    subset. With a roster, that subset uses a per-gender ordinal and skips
 *    configured voices, the lecture voice reserved for an unbound teacher,
 *    and earlier same-gender fallbacks. Without a roster, or
 *    when that subset is empty (no gender on those voices, or only neutral),
 *    the pick is `agentIndex` modulo the pool. Browser-native is in the pool
 *    only when the caller included it: getEnabledProvidersWithVoices excludes
 *    it, getSelectableProvidersWithVoices appends it LAST, so it is the index
 *    target only when it is the sole enabled provider.
 * 3. If the list is empty, return null — the caller must skip TTS rather than
 *    silently falling back to browser-native (#665 symptom 4).
 */
export function resolveAgentVoice(
  agent: AgentConfig,
  agentIndex: number,
  enabledProviders: ProviderWithVoices[],
  overrides?: AgentVoiceOverrides,
  options?: ResolveAgentVoiceOptions,
): ResolvedVoice | null {
  const configured = resolveConfiguredAgentVoice(agent, enabledProviders, overrides);
  if (configured) return configured;

  // Fallback: same-gender catalog voice when the catalogue has one, else index.
  // Neutral-only catalogues have no male/female subset, so they stay on the index.
  return resolveDeterministicFallbackVoice(
    enabledProviders,
    agentIndex,
    agentBinaryGender(agent),
    options?.roster
      ? { agents: options.roster, overrides, globalVoice: options.globalVoice }
      : undefined,
  );
}

/**
 * Roster and index for one AgentBar voice pill.
 *
 * Discussion playback resolves voices against the selected agents in
 * `selectedAgentIds` order. The pill must use that roster. An unselected
 * catalogue agent would otherwise reserve a configured voice or take an
 * earlier same-gender fallback, and the pill would name a voice playback
 * will not speak. A row that is not selected is appended, so its pill is the
 * voice that agent would speak if the user selected it now.
 */
export function voicePillPlaybackRoster(
  agents: readonly AgentConfig[],
  selectedAgentIds: readonly string[],
  agent: AgentConfig,
): { roster: AgentConfig[]; index: number } {
  const byId = new Map(agents.map((entry) => [entry.id, entry]));
  const selected: AgentConfig[] = [];
  for (const id of selectedAgentIds) {
    const entry = byId.get(id);
    if (entry) selected.push(entry);
  }
  const index = selected.findIndex((entry) => entry.id === agent.id);
  if (index >= 0) return { roster: selected, index };
  return { roster: [...selected, agent], index: selected.length };
}

/**
 * A stored or overridden voice whose provider is enabled. Browser-native is
 * accepted when that provider is in the enabled list (its voices are dynamic).
 * Qwen accepts a catalog voice or any non-empty id, including a clone that is
 * not in the static list. Other providers must name a voice the enabled model
 * offers. Null when the agent must take the deterministic fallback.
 */
function resolveConfiguredAgentVoice(
  agent: AgentConfig,
  enabledProviders: ProviderWithVoices[],
  overrides?: AgentVoiceOverrides,
): ResolvedVoice | null {
  // Candidates in priority order: the user's persisted per-agent override
  // (settings store — survives reloads; registry records for default/generated
  // agents do not), then the agent's own voiceConfig. Each is honored only
  // when its provider is still enabled and can speak that id.
  const candidates = [overrides?.[agent.id], agent.voiceConfig];
  for (const choice of candidates) {
    if (!choice) continue;
    // Browser-native voices are dynamic (not in static registry); it is a
    // first-class provider only when present in the enabled list.
    if (choice.providerId === 'browser-native-tts') {
      if (enabledProviders.some((p) => p.providerId === 'browser-native-tts')) {
        return { providerId: choice.providerId, modelId: choice.modelId, voiceId: choice.voiceId };
      }
      continue;
    }
    const fromEnabled = enabledProviders.find((p) => p.providerId === choice.providerId);
    if (!fromEnabled) continue;
    if (choice.providerId === 'qwen-tts') {
      const catalogVoice = isQwenCatalogVoice(choice.voiceId);
      if (catalogVoice || choice.voiceId.trim()) {
        return {
          providerId: choice.providerId,
          modelId: resolveTTSModelForVoice(choice.providerId, choice.voiceId, choice.modelId),
          voiceId: choice.voiceId,
        };
      }
      continue;
    }
    const list = getServerVoiceList(choice.providerId);
    const allVoiceIds = new Set([...list, ...fromEnabled.voices.map((v) => v.id)]);
    const matchingModelGroup = choice.modelId
      ? fromEnabled.modelGroups.find((group) => group.modelId === choice.modelId)
      : undefined;
    const provider = TTS_PROVIDERS[choice.providerId as keyof typeof TTS_PROVIDERS];
    const declaredVoice = provider?.voices.find((voice) => voice.id === choice.voiceId);
    const defaultModelGroup = provider
      ? fromEnabled.modelGroups.find((group) => group.modelId === provider.defaultModelId)
      : undefined;
    const staleModelCanUseDefault = declaredVoice?.compatibleModels
      ? defaultModelGroup?.voices.some((voice) => voice.id === choice.voiceId) === true
      : true;
    // Without compatibility metadata, legacy providers are assumed to accept
    // their known voices on the configured default model, preserving prior behavior.
    const modelCompatible =
      matchingModelGroup?.voices.some((voice) => voice.id === choice.voiceId) ??
      staleModelCanUseDefault;
    // The provider's list holds only the voices its model in use can speak.
    const offered =
      !declaredVoice || fromEnabled.voices.some((voice) => voice.id === choice.voiceId);
    if (allVoiceIds.has(choice.voiceId) && modelCompatible && offered) {
      return {
        providerId: choice.providerId,
        ...(matchingModelGroup ? { modelId: choice.modelId } : {}),
        voiceId: choice.voiceId,
      };
    }
  }

  return null;
}

/** English male/female in voiceDesign.identity. A localized identity has neither word. */
function identityGender(identity: string | undefined): 'male' | 'female' | undefined {
  if (!identity) return undefined;
  const female = /\bfemale\b/i.test(identity);
  const male = /\bmale\b/i.test(identity);
  if (female === male) return undefined;
  return female ? 'female' : 'male';
}

/** Explicit voiceDesign.gender wins. Absent field keeps the English identity fallback. */
function agentBinaryGender(agent: AgentConfig): 'male' | 'female' | undefined {
  const explicit = agent.voiceDesign?.gender;
  if (explicit === 'male' || explicit === 'female') return explicit;
  return identityGender(agent.voiceDesign?.identity);
}

/**
 * The deterministic last-resort voice pick shared by `resolveAgentVoice` and
 * the narrator fallback: the first ENABLED provider in canonical order and one
 * of its catalog voices (Qwen clones are excluded — only catalog voices are
 * guaranteed usable without account state). When `agentGender` is male or
 * female and the catalogue lists that gender, the pick stays inside those
 * voices. Neutral voices are not male or female, so a neutral-only catalogue
 * keeps the index pick, the same as a catalogue with no gender data. With a
 * roster, the gendered subset uses a per-gender ordinal and skips configured
 * voice ids, the lecture voice reserved for an unbound teacher, and earlier
 * same-gender fallbacks, instead of `index` modulo that subset. Returns null
 * when no enabled provider can serve a voice.
 */
export function resolveDeterministicFallbackVoice(
  enabledProviders: ProviderWithVoices[],
  index: number,
  agentGender?: 'male' | 'female',
  roster?: {
    agents: AgentConfig[];
    overrides?: AgentVoiceOverrides;
    globalVoice?: { providerId: string; voiceId: string };
  },
): ResolvedVoice | null {
  if (enabledProviders.length === 0) return null;
  const first = enabledProviders[0];
  const fallbackVoices =
    first.providerId === 'qwen-tts'
      ? first.voices.filter((voice) => isQwenCatalogVoice(voice.id))
      : first.voices;
  if (fallbackVoices.length === 0) return null;
  const sameGender = agentGender
    ? fallbackVoices.filter((voice) => voice.gender === agentGender)
    : [];
  const pool = sameGender.length > 0 ? sameGender : fallbackVoices;
  const voiceId =
    roster && agentGender && sameGender.length > 0
      ? distinctGenderVoiceId(pool, roster, index, agentGender, enabledProviders)
      : pool[index % pool.length].id;
  return {
    providerId: first.providerId,
    voiceId,
  };
}

/** Next unused voice in `pool`, or a stable wrap once every matching voice is taken. */
function distinctVoiceId(pool: Array<{ id: string }>, used: Set<string>, overflow: number): string {
  const free = pool.filter((voice) => !used.has(voice.id));
  if (free.length > 0) return free[0].id;
  return pool[overflow % pool.length].id;
}

/**
 * Catalogue default for this provider (`DEFAULT_TTS_VOICES`). When the enabled
 * model cannot speak that id, the first voice it offers. Used for an unbound
 * teacher only when the caller did not pass the lecture voice. Undefined for a
 * provider with no built-in default.
 */
function providerDefaultVoiceId(provider: ProviderWithVoices | undefined): string | undefined {
  if (!provider) return undefined;
  const preferred = (DEFAULT_TTS_VOICES as Record<string, string>)[provider.providerId];
  if (!preferred) return undefined;
  if (provider.voices.some((voice) => voice.id === preferred)) return preferred;
  return provider.voices[0]?.id;
}

/**
 * Binding discussion playback speaks once `preferred` is marked unavailable.
 * The stored binding is not changed. Callers pass the same lecture voice and
 * the same provider-enabled check the discussion hook uses, so the picker,
 * playback, and fallback allocation stay on one voice.
 */
export function playbackVoiceAfterUnavailableFallback<
  T extends { providerId: string; voiceId: string },
>(
  preferred: T,
  fallback: T,
  firstVoice: () => T | null,
  fallbackProviderEnabled: boolean,
): T | null {
  if (!isVoiceBindingUnavailable(preferred)) return preferred;
  return fallbackProviderEnabled ? fallback : firstVoice();
}

/**
 * Voice an unbound teacher speaks on `provider`: the lecture voice when it is
 * one of that provider's voices, otherwise the catalogue default when the
 * caller passed no lecture voice. A lecture voice on another provider is not
 * this catalogue's default, so nothing here is reserved for it.
 */
function unboundTeacherReservedVoiceId(
  provider: ProviderWithVoices | undefined,
  globalVoice: { providerId: string; voiceId: string } | undefined,
): string | undefined {
  if (!provider) return undefined;
  if (
    globalVoice &&
    globalVoice.providerId === provider.providerId &&
    provider.voices.some((voice) => voice.id === globalVoice.voiceId)
  ) {
    return globalVoice.voiceId;
  }
  if (globalVoice) return undefined;
  return providerDefaultVoiceId(provider);
}

/**
 * Voice id playback substitutes for a teacher's unavailable stored binding, when
 * that voice belongs to the catalogue this fallback allocates from.
 */
function unavailableTeacherPlaybackVoiceId(
  agent: AgentConfig,
  configured: ResolvedVoice,
  enabledProviders: ProviderWithVoices[],
  globalVoice: { providerId: string; voiceId: string } | undefined,
): string | undefined {
  if (agent.role !== 'teacher') return undefined;
  const provider = enabledProviders[0];
  if (!provider) return undefined;
  const lecture = globalVoice
    ? { providerId: globalVoice.providerId, voiceId: globalVoice.voiceId }
    : configured;
  const lectureEnabled =
    !!globalVoice && enabledProviders.some((entry) => entry.providerId === globalVoice.providerId);
  const effective = playbackVoiceAfterUnavailableFallback(
    configured,
    lecture,
    () => {
      const first = provider.voices[0];
      return first ? { providerId: provider.providerId, voiceId: first.id } : null;
    },
    lectureEnabled,
  );
  // The stored id is reserved by the caller. Only the substituted lecture voice
  // needs a second slot, and only when it belongs to this catalogue.
  if (
    !effective ||
    effective.providerId !== provider.providerId ||
    effective.voiceId === configured.voiceId
  ) {
    return undefined;
  }
  return effective.voiceId;
}

/**
 * Voice for one unbound agent of `agentGender`. Before allocating fallbacks,
 * reserve every configured roster voice (including one that appears later) and
 * the lecture voice an unbound teacher speaks. A teacher whose stored binding
 * playback has marked unavailable still keeps that binding, but allocation
 * reserves the voice playback speaks after the unavailable-binding fallback.
 * That reservation does not consume a fallback slot. Earlier unbound agents of
 * the same gender then take the remaining voices. An unbound teacher does not
 * take a slot, because discussion playback does not speak this fallback for them.
 */
function distinctGenderVoiceId(
  pool: Array<{ id: string }>,
  roster: {
    agents: AgentConfig[];
    overrides?: AgentVoiceOverrides;
    globalVoice?: { providerId: string; voiceId: string };
  },
  index: number,
  agentGender: 'male' | 'female',
  enabledProviders: ProviderWithVoices[],
): string {
  const used = new Set<string>();
  const teacherVoice = unboundTeacherReservedVoiceId(enabledProviders[0], roster.globalVoice);
  for (const other of roster.agents) {
    if (!other) continue;
    const configured = resolveConfiguredAgentVoice(other, enabledProviders, roster.overrides);
    if (configured) {
      used.add(configured.voiceId);
      const played = unavailableTeacherPlaybackVoiceId(
        other,
        configured,
        enabledProviders,
        roster.globalVoice,
      );
      if (played) used.add(played);
      continue;
    }
    if (other.role === 'teacher' && teacherVoice) used.add(teacherVoice);
  }
  let overflow = 0;
  for (let i = 0; i < index; i++) {
    const earlier = roster.agents[i];
    if (!earlier) continue;
    if (resolveConfiguredAgentVoice(earlier, enabledProviders, roster.overrides)) continue;
    if (earlier.role === 'teacher') continue;
    if (agentBinaryGender(earlier) !== agentGender) continue;
    used.add(distinctVoiceId(pool, used, overflow));
    overflow += 1;
  }
  return distinctVoiceId(pool, used, overflow);
}

/** Whether a narrator binding names a voice other than the global one. */
export function narratorBindingDiffers(
  bound: { providerId: string; voiceId: string } | undefined,
  globalVoice: { providerId: string; voiceId: string },
): boolean {
  return (
    !!bound &&
    (bound.providerId !== globalVoice.providerId || bound.voiceId !== globalVoice.voiceId)
  );
}

/** The deterministic last-resort narrator voice among the enabled providers, or null. */
export function deterministicNarratorVoice(
  providerConfigs: ProviderConfigMap,
): ResolvedVoice | null {
  return resolveDeterministicFallbackVoice(
    getEnabledProvidersWithVoices(
      providerConfigs as Parameters<typeof getEnabledProvidersWithVoices>[0],
    ),
    0,
  );
}

/**
 * The one voice a narration clip is retried with after the provider said the
 * voice clone it used does not exist (QWEN_VC_VOICE_NOT_FOUND), or null when
 * no retry applies. Only a clip that used the bound narrator voice is
 * retried: with the global voice when the binding differs from it, else (a
 * pinned narrator, bound == global) with the deterministic enabled-provider
 * pick — unless the clip already used an explicit fallback voice.
 */
export function narratorVoiceAfterMissingClone(input: {
  bound: AgentConfig['voiceConfig'] | undefined;
  globalVoice: ResolvedVoice;
  failed: ResolvedVoice;
  providerConfigs: ProviderConfigMap;
  usedFallbackVoice: boolean;
}): ResolvedVoice | null {
  const { bound, globalVoice, failed } = input;
  if (!bound || bound.providerId !== failed.providerId || bound.voiceId !== failed.voiceId) {
    return null;
  }
  if (narratorBindingDiffers(bound, globalVoice)) {
    return resolveNarratorVoiceBinding(undefined, globalVoice, input.providerConfigs);
  }
  if (input.usedFallbackVoice) return null;
  return deterministicNarratorVoice(input.providerConfigs);
}

/**
 * The narrator (teacher) voice to pin at agent-profile generation time.
 *
 * Returns undefined when the global voice is unusable — no voice selected, or
 * its provider disabled/unconfigured — so the teacher is never pinned to a
 * voice the fallback machinery cannot serve. The advertised list contains only
 * enabled providers, so an unpinned narrator lets the LLM pick a working voice;
 * and because the pin makes bound == global, pinning an unusable voice would
 * defeat `resolveNarratorVoiceBinding`'s enabled-provider fallback at narration.
 */
export function resolveNarratorVoiceForGeneration(
  providerId: TTSProviderId,
  voiceId: string | undefined,
  providerConfig: (TTSEnablementConfig & { modelId?: string }) | undefined,
): ResolvedVoice | undefined {
  const trimmed = voiceId?.trim();
  if (!providerId || !trimmed) return undefined;
  if (!isTTSProviderEnabled(providerId, providerConfig)) return undefined;
  if (!voiceServesModel(providerId, trimmed, providerConfig?.modelId)) return undefined;
  const modelId =
    providerId === 'qwen-tts' && isQwenCloneVoice(trimmed)
      ? resolveTTSModelForVoice(providerId, trimmed, providerConfig?.modelId)
      : undefined;
  return { providerId, voiceId: trimmed, ...(modelId ? { modelId } : {}) };
}

/**
 * Get the list of voice IDs for a TTS provider.
 * For browser-native-tts, returns empty (browser voices are dynamic).
 * For custom providers, reads from ttsProvidersConfig.customVoices.
 */
export function getServerVoiceList(
  providerId: TTSProviderId,
  ttsProvidersConfig?: Record<string, Record<string, unknown>>,
): string[] {
  if (providerId === 'browser-native-tts') return [];
  if (isCustomTTSProvider(providerId) && ttsProvidersConfig) {
    const customVoices = ttsProvidersConfig[providerId]?.customVoices as
      | Array<{ id: string }>
      | undefined;
    return customVoices?.map((v) => v.id) || [];
  }
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  if (!provider) return [];
  return provider.voices.map((v) => v.id);
}

export interface ModelVoiceGroup {
  modelId: string;
  modelName: string;
  voices: Array<{ id: string; name: string; language?: string }>;
}

export interface ProviderWithVoices {
  providerId: TTSProviderId;
  providerName: string;
  voices: Array<{
    id: string;
    name: string;
    language?: string;
    /**
     * This voice's catalogue gender, when the provider lists one. Clones and
     * custom voices omit it even beside gendered presets. `neutral` is an
     * explicit value, not a missing field.
     */
    gender?: 'male' | 'female' | 'neutral';
  }>;
  modelGroups: ModelVoiceGroup[]; // voices grouped by model
}

export interface UserVoiceProfile {
  id: string;
  providerId?: string;
  name: string;
  kind?: string;
}

/**
 * Get all ENABLED providers and their voices for the voice picker UI and for
 * deterministic auto-assignment.
 *
 * A provider is included only when {@link isTTSProviderEnabled} holds:
 * configured (server-managed, client API key, or explicit base URL — the
 * registry `defaultBaseUrl` no longer counts), not server-disabled, and the
 * user's per-provider `enabled` flag is not false (#665). Browser-native is
 * excluded here (no static voice list); the agent UI injects its dynamic voices
 * separately, gated on the same predicate.
 */
export function getEnabledProvidersWithVoices(
  ttsProvidersConfig: Record<
    string,
    TTSEnablementConfig & {
      modelId?: string;
      providerOptions?: Record<string, unknown>;
      customName?: string;
    }
  >,
  voiceProfiles: UserVoiceProfile[] = [],
): ProviderWithVoices[] {
  const result: ProviderWithVoices[] = [];

  // Built-in providers
  for (const [id, config] of Object.entries(TTS_PROVIDERS)) {
    const providerId = id as TTSProviderId;
    if (providerId === 'browser-native-tts') continue;
    if (config.voices.length === 0) continue;

    const providerConfig = ttsProvidersConfig[providerId];
    if (!isTTSProviderEnabled(providerId, providerConfig)) continue;

    const providerProfiles = voiceProfiles.filter(
      (profile) =>
        (profile.providerId || VOXCPM_TTS_PROVIDER_ID) === providerId && profile.kind === 'clone',
    );
    const visibleVoxCPMProfiles =
      providerId === VOXCPM_TTS_PROVIDER_ID
        ? voiceProfiles.filter((profile) => {
            if ((profile.providerId || VOXCPM_TTS_PROVIDER_ID) !== providerId) return false;
            const backend = normalizeVoxCPMBackend(providerConfig?.providerOptions?.backend);
            return profile.kind !== 'clone' || voxCPMBackendSupportsReferenceAudio(backend);
          })
        : [];
    const userVoices =
      providerId === VOXCPM_TTS_PROVIDER_ID
        ? visibleVoxCPMProfiles.map((profile) => ({
            id: getVoxCPMProfileVoiceId(profile.id),
            name: profile.name,
            language: 'auto',
          }))
        : providerProfiles.map((profile) => ({
            id: profile.id,
            name: profile.name,
            language: 'auto',
          }));

    {
      const allVoices = [
        ...config.voices.map((v) => ({
          id: v.id,
          name: v.name,
          language: v.language,
          ...(v.gender ? { gender: v.gender } : {}),
        })),
        ...userVoices,
      ];

      // Build model groups
      const modelGroups: ModelVoiceGroup[] = [];
      if (config.models.length > 0) {
        for (const model of config.models) {
          const compatibleVoices =
            providerId === 'qwen-tts' && isQwenVoiceCloneModel(model.id)
              ? []
              : config.voices
                  .filter((v) => !v.compatibleModels || v.compatibleModels.includes(model.id))
                  .map((v) => ({ id: v.id, name: v.name, language: v.language }));
          if (providerId === VOXCPM_TTS_PROVIDER_ID) {
            compatibleVoices.push(...userVoices);
          } else if (providerId !== 'qwen-tts' || isQwenVoiceCloneModel(model.id)) {
            compatibleVoices.push(...userVoices);
          }
          modelGroups.push({
            modelId: model.id,
            modelName: model.name,
            voices: compatibleVoices,
          });
        }
      } else {
        modelGroups.push({
          modelId: '',
          modelName: config.name,
          voices: allVoices,
        });
      }

      // A provider used with one model (the tts slot's) offers only the
      // voices that model can speak, under that model.
      const inUse = providerConfig?.modelId;
      if (inUse) {
        const speaks = (voice: { id: string }) => voiceServesModel(providerId, voice.id, inUse);
        const voices = allVoices.filter(speaks);
        const own = modelGroups.filter(
          (group) =>
            group.modelId === inUse ||
            // Qwen clones switch to the clone model whatever the slot's model.
            (providerId === 'qwen-tts' && isQwenVoiceCloneModel(group.modelId)),
        );
        result.push({
          providerId,
          providerName: config.name,
          voices,
          modelGroups: own.length
            ? own.map((group) => ({ ...group, voices: group.voices.filter(speaks) }))
            : [{ modelId: inUse, modelName: inUse, voices }],
        });
        continue;
      }

      result.push({
        providerId,
        providerName: config.name,
        voices: allVoices,
        modelGroups,
      });
    }
  }

  // Custom providers
  for (const [id, providerConfig] of Object.entries(ttsProvidersConfig)) {
    if (!isCustomTTSProvider(id)) continue;
    const customVoices = providerConfig.customVoices || [];
    if (customVoices.length === 0) continue;
    if (!isTTSProviderEnabled(id as TTSProviderId, providerConfig)) continue;

    const providerId = id as TTSProviderId;
    const providerName = providerConfig.customName || id;
    const voices = customVoices.map((v) => ({ id: v.id, name: v.name }));

    result.push({
      providerId,
      providerName,
      voices,
      modelGroups: [{ modelId: '', modelName: providerName, voices }],
    });
  }

  return result;
}

/** A browser SpeechSynthesisVoice, narrowed to what the picker needs. */
export interface BrowserVoiceLike {
  voiceURI: string;
  name: string;
}

/**
 * The single source of truth for "which provider+voice options are selectable
 * on the client" — used by BOTH the voice picker (AgentBar) and discussion TTS
 * resolution, so the teacher and student agents never diverge (#665).
 *
 * = enabled server/custom providers (getEnabledProvidersWithVoices) PLUS
 * browser-native when the user has enabled it and the browser exposes voices
 * (browser-native voices are dynamic, so they can only be supplied at the
 * client layer; server-side generation uses getEnabledProvidersWithVoices).
 */
export function getSelectableProvidersWithVoices(
  ttsProvidersConfig: Record<
    string,
    TTSEnablementConfig & {
      modelId?: string;
      providerOptions?: Record<string, unknown>;
      customName?: string;
    }
  >,
  voiceProfiles: UserVoiceProfile[] = [],
  browserVoices: BrowserVoiceLike[] = [],
): ProviderWithVoices[] {
  const providers = getEnabledProvidersWithVoices(ttsProvidersConfig, voiceProfiles);
  if (
    isTTSProviderEnabled(
      BROWSER_NATIVE_TTS_PROVIDER_ID,
      ttsProvidersConfig[BROWSER_NATIVE_TTS_PROVIDER_ID],
    ) &&
    browserVoices.length > 0
  ) {
    const voices = browserVoices.map((v) => ({ id: v.voiceURI, name: v.name }));
    providers.push({
      providerId: BROWSER_NATIVE_TTS_PROVIDER_ID,
      providerName: 'Browser Native',
      voices,
      modelGroups: [{ modelId: '', modelName: 'Browser Native', voices }],
    });
  }
  return providers;
}

/**
 * Find a voice display name across all providers.
 */
export function findVoiceDisplayName(
  providerId: TTSProviderId,
  voiceId: string,
  ttsProvidersConfig?: Record<string, Record<string, unknown>>,
): string {
  if (isCustomTTSProvider(providerId) && ttsProvidersConfig) {
    const customVoices = ttsProvidersConfig[providerId]?.customVoices as
      | Array<{ id: string; name: string }>
      | undefined;
    const voice = customVoices?.find((v) => v.id === voiceId);
    return voice?.name ?? voiceId;
  }
  // Object.hasOwn, not a bare index: a prototype-chain key ('toString', …)
  // would resolve to a function and crash the `.voices` access below.
  const provider = Object.hasOwn(TTS_PROVIDERS, providerId)
    ? TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS]
    : undefined;
  if (!provider) return voiceId;
  const voice = provider.voices.find((v) => v.id === voiceId);
  return voice?.name ?? voiceId;
}

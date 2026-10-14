import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

const mocks = vi.hoisted(() => ({
  accessDocument: vi.fn(),
  prepareScenes: vi.fn(),
  buildAssetManifest: vi.fn(),
  collectAudioFiles: vi.fn(),
  collectMediaFiles: vi.fn(),
  collectLegacyAudioForExport: vi.fn(),
}));

vi.mock('@/lib/document-store', () => ({ accessDocument: mocks.accessDocument }));
vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: mocks.prepareScenes,
}));
vi.mock('@/lib/media/asset-manifest', () => ({
  buildStageAssetManifest: mocks.buildAssetManifest,
}));
vi.mock('@/lib/export/classroom-zip-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/export/classroom-zip-utils')>();
  return {
    ...actual,
    collectAudioFiles: mocks.collectAudioFiles,
    collectMediaFiles: mocks.collectMediaFiles,
    collectLegacyAudioForExport: mocks.collectLegacyAudioForExport,
  };
});

import { buildClassroomExportZip } from '@/lib/export/use-export-classroom';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';
import type { Scene, Stage } from '@/lib/types/stage';

/** Characters rejected by `classroomExportBaseName` and common filename rules. */
const UNSAFE_FILENAME = /[\\/:*?"<>|]/;

function scenesFor(stageId: string): Scene[] {
  return [
    {
      id: 'scene-1',
      stageId,
      title: 'Scene',
      order: 0,
      type: 'slide',
      content: { type: 'slide', canvas: { elements: [] } },
    } as unknown as Scene,
  ];
}

async function exportClassroom(id: string, name: string) {
  const stage = { id, name, generatedAgentConfigs: [] } as unknown as Stage;
  const scenes = scenesFor(id);
  mocks.accessDocument.mockResolvedValue({ document: { stage } });
  mocks.prepareScenes.mockResolvedValue(scenes);
  mocks.buildAssetManifest.mockResolvedValue({ version: 1, entries: [] });
  mocks.collectAudioFiles.mockResolvedValue([]);
  mocks.collectMediaFiles.mockResolvedValue([]);
  mocks.collectLegacyAudioForExport.mockResolvedValue({
    audioUrlToPath: new Map(),
    blobs: [],
    fullyRescuedAudioIds: new Set(),
  });
  return buildClassroomExportZip(stage, scenes);
}

async function manifestOf(zip: Blob): Promise<ClassroomManifest> {
  const archive = await JSZip.loadAsync(await zip.arrayBuffer());
  const raw = await archive.file('manifest.json')!.async('string');
  return JSON.parse(raw) as ClassroomManifest;
}

describe('classroom ZIP download filenames', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('uses different names for same-title classrooms with different ids', async () => {
    const first = await exportClassroom('stage-course-a', '网络入门');
    const second = await exportClassroom('stage-course-b', '网络入门');

    expect(first.fileName).not.toBe(second.fileName);
    expect(first.fileName).toContain('stage-course-a');
    expect(second.fileName).toContain('stage-course-b');
    expect(first.fileName.endsWith('.maic.zip')).toBe(true);
    expect(second.fileName.endsWith('.maic.zip')).toBe(true);
  });

  it('uses a different name for a later export of the same classroom', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-16T02:34:56.789Z'));
    const first = await exportClassroom('stage-course-a', '网络入门');
    vi.setSystemTime(new Date('2026-09-16T02:34:56.790Z'));
    const second = await exportClassroom('stage-course-a', '网络入门');

    expect(first.fileName).not.toBe(second.fileName);

    const firstManifest = await manifestOf(first.zip);
    const secondManifest = await manifestOf(second.zip);
    expect(first.fileName).toContain(firstManifest.exportedAt.replace(/[-:.]/g, ''));
    expect(second.fileName).toContain(secondManifest.exportedAt.replace(/[-:.]/g, ''));
    expect(firstManifest.exportedAt).toBe('2026-09-16T02:34:56.789Z');
    expect(secondManifest.exportedAt).toBe('2026-09-16T02:34:56.790Z');
  });

  it('strips unsafe characters and keeps the .maic.zip suffix', async () => {
    const result = await exportClassroom('bad/id:1', ' A/B\\C:D*E?F"G<H>I|J ');

    expect(result.fileName).not.toMatch(UNSAFE_FILENAME);
    expect(result.fileName.endsWith('.maic.zip')).toBe(true);
    expect(result.fileName).toContain('A_B_C_D_E_F_G_H_I_J');
    expect(result.fileName).toContain('bad_id_1');
  });

  it('keeps a long Unicode title inside a 255-byte filename', async () => {
    const result = await exportClassroom('stage-course-a', '😀'.repeat(80));

    expect(new TextEncoder().encode(result.fileName).length).toBeLessThanOrEqual(255);
    expect(result.fileName.endsWith('.maic.zip')).toBe(true);
    expect(result.fileName).toContain('stage-course-a');
    const title = result.fileName.split('-stage-course-a-')[0] ?? '';
    expect(title.length).toBeGreaterThan(0);
    expect([...title].every((char) => char === '😀')).toBe(true);
  });
  it('truncates a long ASCII title so the filename is at most 255 bytes', async () => {
    const result = await exportClassroom('stage-course-a', 'a'.repeat(400));

    const bytes = new TextEncoder().encode(result.fileName).length;
    expect(bytes).toBeLessThanOrEqual(255);
    expect(bytes).toBeGreaterThan(200);
    expect(result.fileName).toMatch(/^a+-stage-course-a-\d{8}T\d{9}Z\.maic\.zip$/);
  });
});

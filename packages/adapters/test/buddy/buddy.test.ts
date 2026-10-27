import { describe, expect, it } from 'vitest';
import { buddy } from '../../src/buddy/buddy.js';
import { storageAdapterTestSuite } from '../../src/test-suite.js';

const WORKSPACE = process.env.BUDDY_WORKSPACE;
const ARTIFACT = process.env.BUDDY_ARTIFACT;
const TOKEN = process.env.BUDDY_TOKEN ?? process.env.BUDDY_API_TOKEN;
const PROJECT = process.env.BUDDY_PROJECT;
const VERSION = process.env.BUDDY_VERSION;
const API_URL = process.env.BUDDY_API_URL;

// Live tests against a real Buddy artifact. Skip the whole suite when env
// vars are missing or empty (CI substitutes `${{ secrets.X }}` even when the
// secret is undefined → empty string; `Boolean(...)` catches both).
const configured = Boolean(WORKSPACE && ARTIFACT && TOKEN);

if (configured) {
  const buildAdapter = () =>
    buddy({
      workspace: WORKSPACE as string,
      artifact: ARTIFACT as string,
      token: TOKEN as string,
      ...(PROJECT !== undefined ? { project: PROJECT } : {}),
      ...(VERSION !== undefined ? { version: VERSION } : {}),
      ...(API_URL !== undefined ? { apiUrl: API_URL } : {}),
    });

  // Snapshots and forks are server-side version copies that Buddy finishes
  // asynchronously (~10 s each); merge/rebase chain several of them.
  storageAdapterTestSuite({
    name: 'buddy adapter',
    skip: false,
    testTimeoutMs: 180_000,
    adapter: buildAdapter,
    capabilities: {
      userMetadata: false,
      contentType: false,
      presignedUploads: false,
      fetchableSignedUrls: false,
    },
  });
} else {
  describe('buddy adapter (skipped)', () => {
    it('skipped: BUDDY_WORKSPACE / BUDDY_ARTIFACT / BUDDY_TOKEN not set', () => {
      expect(true).toBe(true);
    });
  });
}

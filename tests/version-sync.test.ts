import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionSyncTest } from '@chrischall/mcp-utils/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('version sync', () => {
  it('every release-please annotation matches package.json', () => {
    const mismatches = versionSyncTest({ srcDir: join(ROOT, 'src'), pkgPath: join(ROOT, 'package.json') });
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });
});

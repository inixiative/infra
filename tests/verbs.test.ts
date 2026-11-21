import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as api from '../src/index.ts';

const ROOT = join(import.meta.dir, '..');

const parseExportedSymbolsFromIndex = (source: string): string[] => {
  const names: string[] = [];
  const blockPattern = /export\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g;
  for (const match of source.matchAll(blockPattern)) {
    const body = match[1] ?? '';
    for (const rawEntry of body.split(',')) {
      const cleaned = rawEntry
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .trim();
      if (!cleaned) continue;
      const withoutType = cleaned.replace(/^type\s+/, '').trim();
      const parts = withoutType.split(/\s+as\s+/);
      const exportedName = (parts[1] ?? parts[0] ?? '').trim();
      if (exportedName) names.push(exportedName);
    }
  }
  return names;
};

describe('verbs and vocabulary', () => {
  const verbsDoc = readFileSync(join(ROOT, 'docs/VERBS.md'), 'utf8');
  const indexSource = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');

  test('every exported runtime symbol from src/index.ts is documented in docs/VERBS.md', () => {
    const missing = Object.keys(api).filter((name) => !verbsDoc.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  test('every statically exported symbol (including types) from src/index.ts is documented in docs/VERBS.md', () => {
    const exported = parseExportedSymbolsFromIndex(indexSource);
    expect(exported.length).toBeGreaterThan(40);
    const missing = exported.filter((name) => !verbsDoc.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  test('no public export starts with the banned get* prefix (R-2026-11-17-07)', () => {
    const exported = [
      ...new Set([...Object.keys(api), ...parseExportedSymbolsFromIndex(indexSource)]),
    ];
    const offenders = exported.filter((name) => /^get[A-Z]/.test(name));
    expect(offenders).toEqual([]);
  });

  test('provider registry matches implemented workload and archive drivers', () => {
    for (const provider of api.IMPLEMENTED_INFRA_PROVIDERS) {
      expect(api.INFRA_PROVIDERS[provider].implemented).toBe(true);
      expect(api.workloadDriverForProvider(provider).provider).toBe(provider);
    }
    for (const provider of api.PLANNED_INFRA_PROVIDERS) {
      expect(api.INFRA_PROVIDERS[provider].implemented).toBe(false);
    }
    for (const provider of api.ARCHIVE_HOSTING_PROVIDERS) {
      expect(api.INFRA_PROVIDERS[provider].supportsArchiveHosting).toBe(true);
      expect(api.archiveHostingDriverForProvider(provider).provider).toBe(provider);
    }
  });
});

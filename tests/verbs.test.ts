import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as firecrackerApi from '../src/firecracker/index.ts';
import * as flyApi from '../src/fly/index.ts';
import * as rootApi from '../src/index.ts';
import * as lifecycleApi from '../src/lifecycle/index.ts';
import * as railwayApi from '../src/railway/index.ts';
import * as renderApi from '../src/render/index.ts';

const ROOT = join(import.meta.dir, '..');

const ENTRYPOINTS = [
  { file: 'src/index.ts', mod: rootApi },
  { file: 'src/railway/index.ts', mod: railwayApi },
  { file: 'src/render/index.ts', mod: renderApi },
  { file: 'src/fly/index.ts', mod: flyApi },
  { file: 'src/firecracker/index.ts', mod: firecrackerApi },
  { file: 'src/lifecycle/index.ts', mod: lifecycleApi },
] as const;

const parseExportedSymbols = (source: string): string[] => {
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

const walkFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const fullPath = join(dir, name);
    if (statSync(fullPath).isDirectory()) return walkFiles(fullPath);
    return [relative(ROOT, fullPath)];
  });

describe('verbs and vocabulary', () => {
  const verbsDoc = readFileSync(join(ROOT, 'docs/VERBS.md'), 'utf8');

  test('every exported symbol (runtime + types) across all six entry points is documented in docs/VERBS.md', () => {
    const allExported = new Set<string>();
    for (const entry of ENTRYPOINTS) {
      for (const name of Object.keys(entry.mod)) allExported.add(name);
      const source = readFileSync(join(ROOT, entry.file), 'utf8');
      for (const name of parseExportedSymbols(source)) allExported.add(name);
    }
    const missing = [...allExported].filter((name) => !verbsDoc.includes(`\`${name}\``)).sort();
    expect(missing).toEqual([]);
  });

  test('no stale or removed symbol names remain in docs/VERBS.md tables/lists', () => {
    const allExported = new Set<string>();
    for (const entry of ENTRYPOINTS) {
      for (const name of Object.keys(entry.mod)) allExported.add(name);
      const source = readFileSync(join(ROOT, entry.file), 'utf8');
      for (const name of parseExportedSymbols(source)) allExported.add(name);
    }

    // Collect backticked identifiers from table Name columns, Constants/Drivers lists, and Exported Types
    const documentedSymbols = new Set<string>();
    const lines = verbsDoc.split('\n');
    let inConstantsList = false;
    for (const line of lines) {
      const tableMatch = line.match(/^\|\s*[^|]+\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|/);
      if (tableMatch?.[1]) {
        documentedSymbols.add(tableMatch[1]);
        continue;
      }
      if (/^(Constants and registries|Drivers and constants|Constants):/.test(line)) {
        inConstantsList = true;
      } else if (line.trim() === '') {
        inConstantsList = false;
      }
      if (inConstantsList) {
        for (const match of line.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) {
          if (match[1]) documentedSymbols.add(match[1]);
        }
      }
    }
    const typesSection = verbsDoc.split('## Exported Types')[1] ?? '';
    for (const match of typesSection.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) {
      if (match[1]) documentedSymbols.add(match[1]);
    }

    const stale = [...documentedSymbols].filter((name) => !allExported.has(name)).sort();
    expect(stale).toEqual([]);
  });

  test('no public export starts with the banned get* prefix (R-2026-11-17-07)', () => {
    const exported = new Set<string>();
    for (const entry of ENTRYPOINTS) {
      for (const name of Object.keys(entry.mod)) exported.add(name);
      const source = readFileSync(join(ROOT, entry.file), 'utf8');
      for (const name of parseExportedSymbols(source)) exported.add(name);
    }
    const offenders = [...exported].filter((name) => /^get[A-Z]/.test(name));
    expect(offenders).toEqual([]);
  });

  test('no internal closed-product names leak into public MIT src/, README.md, or docs/VERBS.md', () => {
    const forbidden = /\b(chorus|oracle-worker|adhoc-foundry)\b/i;
    const filesToCheck = [...walkFiles(join(ROOT, 'src')), 'README.md', 'docs/VERBS.md'];
    const hits = filesToCheck.filter((relPath) =>
      forbidden.test(readFileSync(join(ROOT, relPath), 'utf8')),
    );
    expect(hits).toEqual([]);
  });

  test('provider registry matches implemented workload and archive drivers', () => {
    for (const provider of rootApi.IMPLEMENTED_INFRA_PROVIDERS) {
      expect(rootApi.INFRA_PROVIDERS[provider].implemented).toBe(true);
      expect(rootApi.workloadDriverForProvider(provider).provider).toBe(provider);
    }
    for (const provider of rootApi.PLANNED_INFRA_PROVIDERS) {
      expect(rootApi.INFRA_PROVIDERS[provider].implemented).toBe(false);
    }
    for (const provider of rootApi.ARCHIVE_HOSTING_PROVIDERS) {
      expect(rootApi.INFRA_PROVIDERS[provider].supportsArchiveHosting).toBe(true);
      expect(rootApi.archiveHostingDriverForProvider(provider).provider).toBe(provider);
    }
  });
});

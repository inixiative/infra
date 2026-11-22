import { beforeAll, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { InfraErrorCode, WorkloadDriver, WorkloadSpec } from '../src/index.ts';
import type { planStaggeredWakes as PlanStaggeredWakes } from '../src/lifecycle/index.ts';

const ROOT = join(import.meta.dir, '..');
const DIST_DIR = join(ROOT, 'dist');
const requireFromRoot = createRequire(import.meta.url);

type RootModule = {
  readonly InfraError: new (code: InfraErrorCode, message?: string) => Error;
  readonly isInfraError: (error: unknown, code?: InfraErrorCode) => boolean;
};

type DriverSubpathModule = {
  readonly railwayWorkloadDriver?: WorkloadDriver;
  readonly renderWorkloadDriver?: WorkloadDriver;
  readonly flyWorkloadDriver?: WorkloadDriver;
  readonly firecrackerWorkloadDriver?: WorkloadDriver;
};

type LifecycleSubpathModule = {
  readonly planStaggeredWakes: typeof PlanStaggeredWakes;
};

const importDistEsm = async <T>(relPath: string): Promise<T> =>
  (await import(pathToFileURL(join(DIST_DIR, relPath)).href)) as T;

const requireDistCjs = <T>(relPath: string): T => requireFromRoot(join(DIST_DIR, relPath)) as T;

const catchRejected = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected promise to reject');
};

const catchThrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected function to throw');
};

const requireDriver = (driver: WorkloadDriver | undefined, name: string): WorkloadDriver => {
  if (!driver) throw new Error(`Missing expected export: ${name}`);
  return driver;
};

const collectSubpathErrors = async (
  load: <T>(relPath: string) => Promise<T> | T,
  ext: 'js' | 'cjs',
): Promise<
  readonly { readonly subpath: string; readonly code: InfraErrorCode; readonly error: unknown }[]
> => {
  const railway = await load<DriverSubpathModule>(`railway/index.${ext}`);
  const render = await load<DriverSubpathModule>(`render/index.${ext}`);
  const fly = await load<DriverSubpathModule>(`fly/index.${ext}`);
  const firecracker = await load<DriverSubpathModule>(`firecracker/index.${ext}`);
  const lifecycle = await load<LifecycleSubpathModule>(`lifecycle/index.${ext}`);

  const spec: WorkloadSpec = {
    name: 'interop-test',
    image: 'alpine:latest',
    memoryMb: 512,
    vcpus: 1,
  };

  return [
    {
      subpath: `railway/index.${ext}`,
      code: 'authentication_failed',
      error: await catchRejected(() =>
        requireDriver(railway.railwayWorkloadDriver, 'railwayWorkloadDriver').provisionWorkload(
          {},
          spec,
        ),
      ),
    },
    {
      subpath: `render/index.${ext}`,
      code: 'authentication_failed',
      error: await catchRejected(() =>
        requireDriver(render.renderWorkloadDriver, 'renderWorkloadDriver').provisionWorkload(
          {},
          spec,
        ),
      ),
    },
    {
      subpath: `fly/index.${ext}`,
      code: 'authentication_failed',
      error: await catchRejected(() =>
        requireDriver(fly.flyWorkloadDriver, 'flyWorkloadDriver').provisionWorkload({}, spec),
      ),
    },
    {
      subpath: `firecracker/index.${ext}`,
      code: 'invalid_request',
      error: await catchRejected(() =>
        requireDriver(
          firecracker.firecrackerWorkloadDriver,
          'firecrackerWorkloadDriver',
        ).provisionWorkload({}, { ...spec, name: '../traversal' }),
      ),
    },
    {
      subpath: `lifecycle/index.${ext}`,
      code: 'invalid_request',
      error: catchThrown(() =>
        lifecycle.planStaggeredWakes([{ workloadId: '', requestedAtMs: 0 }], 0, {
          maxConcurrentWakes: 1,
          minSpacingMs: 0,
        }),
      ),
    },
  ];
};

const REQUIRED_DIST_ENTRIES = [
  'index.js',
  'index.cjs',
  'railway/index.js',
  'railway/index.cjs',
  'render/index.js',
  'render/index.cjs',
  'fly/index.js',
  'fly/index.cjs',
  'firecracker/index.js',
  'firecracker/index.cjs',
  'lifecycle/index.js',
  'lifecycle/index.cjs',
] as const;

describe('dist cross-subpath isInfraError interop', () => {
  beforeAll(() => {
    const missing = REQUIRED_DIST_ENTRIES.some((entry) => !existsSync(join(DIST_DIR, entry)));
    if (missing) {
      const result = Bun.spawnSync(['bun', 'run', 'build'], {
        cwd: ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `bun run build failed (exit ${result.exitCode}):\n${result.stderr.toString()}`,
        );
      }
    }
  }, 60_000);

  it('recognizes InfraError thrown from every built ESM subpath via dist/index.js', async () => {
    const rootEsm = await importDistEsm<RootModule>('index.js');
    const cases = await collectSubpathErrors(importDistEsm, 'js');

    for (const item of cases) {
      expect(rootEsm.isInfraError(item.error)).toBe(true);
      expect(rootEsm.isInfraError(item.error, item.code)).toBe(true);
      expect(rootEsm.isInfraError(item.error, 'conflict')).toBe(false);
      // Shared ESM chunk also preserves instanceof across subpaths
      expect(item.error instanceof rootEsm.InfraError).toBe(true);
    }
  });

  it('recognizes InfraError thrown from every built CJS subpath via dist/index.cjs', async () => {
    const rootCjs = requireDistCjs<RootModule>('index.cjs');
    const cases = await collectSubpathErrors(requireDistCjs, 'cjs');

    for (const item of cases) {
      expect(rootCjs.isInfraError(item.error)).toBe(true);
      expect(rootCjs.isInfraError(item.error, item.code)).toBe(true);
      expect(rootCjs.isInfraError(item.error, 'conflict')).toBe(false);
      // Shared CJS chunk also preserves instanceof across subpaths
      expect(item.error instanceof rootCjs.InfraError).toBe(true);
    }
  });

  it('recognizes InfraError across the ESM/CJS dual-package boundary via the symbol brand', async () => {
    const rootEsm = await importDistEsm<RootModule>('index.js');
    const rootCjs = requireDistCjs<RootModule>('index.cjs');

    const cjsCases = await collectSubpathErrors(requireDistCjs, 'cjs');
    for (const item of cjsCases) {
      expect(item.error instanceof rootEsm.InfraError).toBe(false);
      expect(rootEsm.isInfraError(item.error)).toBe(true);
      expect(rootEsm.isInfraError(item.error, item.code)).toBe(true);
      expect(rootEsm.isInfraError(item.error, 'conflict')).toBe(false);
    }

    const esmCases = await collectSubpathErrors(importDistEsm, 'js');
    for (const item of esmCases) {
      expect(item.error instanceof rootCjs.InfraError).toBe(false);
      expect(rootCjs.isInfraError(item.error)).toBe(true);
      expect(rootCjs.isInfraError(item.error, item.code)).toBe(true);
      expect(rootCjs.isInfraError(item.error, 'conflict')).toBe(false);
    }
  });
});

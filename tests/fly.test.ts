import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { FLY_SUSPEND_MAX_MEMORY_MB, flyWorkloadDriver, InfraError } from '../src/index.ts';

const FAKE_TOKEN = 'fly-test-token';

type MachineRecord = {
  id: string;
  name: string;
  appName: string;
  state: string;
  region: string;
  instance_id: string;
  updated_at: string;
  config: {
    image: string;
    env?: Record<string, string>;
    guest: { cpu_kind: string; cpus: number; memory_mb: number };
    mounts?: { volume: string; path: string }[];
    auto_destroy?: boolean;
    services?: unknown[];
    checks?: Record<string, unknown>;
    metadata?: Record<string, string>;
  };
  events: { type: string; status: string; timestamp: number }[];
};

const state = {
  machines: new Map<string, MachineRecord>(),
  requests: [] as { method: string; path: string; query: string; body?: unknown }[],
  nextErrorStatus: undefined as number | undefined,
};

let idCounter = 0;
const nextId = () => `mach${++idCounter}`;

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: async (request) => {
    if (request.headers.get('authorization') !== `Bearer ${FAKE_TOKEN}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    if (state.nextErrorStatus) {
      const status = state.nextErrorStatus;
      state.nextErrorStatus = undefined;
      return Response.json({ error: `forced ${status}` }, { status });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/v1/, '');
    const body =
      request.method === 'POST' || request.method === 'PUT'
        ? await request.json().catch(() => undefined)
        : undefined;
    state.requests.push({ method: request.method, path, query: url.search, body });

    const [, apps, appName, machinesSegment, machineId, action] = path.split('/');
    if (apps !== 'apps' || machinesSegment !== 'machines') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }

    if (request.method === 'POST' && !machineId) {
      const input = body as {
        name: string;
        region?: string;
        config: MachineRecord['config'];
      };
      const now = Date.now();
      const record: MachineRecord = {
        id: nextId(),
        name: input.name,
        appName,
        state: 'started',
        region: input.region ?? 'iad',
        instance_id: `inst-${idCounter}`,
        updated_at: new Date(now).toISOString(),
        config: input.config,
        events: [{ type: 'start', status: 'started', timestamp: now - 120_000 }],
      };
      state.machines.set(record.id, record);
      return Response.json(record, { status: 200 });
    }

    const machine = machineId ? state.machines.get(machineId) : undefined;
    if (!machine || machine.appName !== appName) {
      return Response.json({ error: 'machine not found' }, { status: 404 });
    }

    if (action === 'suspend' && request.method === 'POST') {
      machine.state = 'suspended';
      machine.events.push({ type: 'suspend', status: 'suspended', timestamp: Date.now() });
      return Response.json({ ok: true });
    }
    if (action === 'start' && request.method === 'POST') {
      machine.state = 'started';
      machine.instance_id = `inst-woken-${++idCounter}`;
      machine.events.push({ type: 'start', status: 'started', timestamp: Date.now() });
      return Response.json({ ok: true });
    }
    if (action === 'wait' && request.method === 'GET') {
      return Response.json({ ok: true });
    }
    if (request.method === 'GET' && !action) {
      return Response.json(machine);
    }
    if (request.method === 'DELETE' && !action) {
      state.machines.delete(machine.id);
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  },
});

const apiUrl = `http://127.0.0.1:${server.port}/v1/`;
const credentials = { token: FAKE_TOKEN, appName: 'inixiative-workers', apiUrl };

afterAll(() => server.stop(true));

describe('flyWorkloadDriver', () => {
  beforeEach(() => {
    state.machines.clear();
    state.requests.length = 0;
    state.nextErrorStatus = undefined;
  });

  it('provisions a Firecracker Machine with checks, suspends+waits, wakes without stale instance_id, reconciles usage, and destroys', async () => {
    const handle = await flyWorkloadDriver.provisionWorkload(credentials, {
      name: 'worker-proj-1',
      image: 'ghcr.io/example/worker:1.0.0',
      memoryMb: 2048,
      cpuKind: 'shared',
      vcpus: 2,
      region: 'iad',
      env: { WORKER_MODE: 'interactive' },
      volume: { name: 'cache', volumeId: 'vol_123', mountPath: '/var/cache/worker' },
      labels: { project: 'example' },
      port: { internalPort: 4500, publicHttps: true },
      healthcheckPath: '/health',
    });

    expect(handle).toMatchObject({
      provider: 'fly',
      region: 'iad',
      memoryMb: 2048,
      vcpus: 2,
      url: 'https://inixiative-workers.fly.dev',
    });

    const createdMachine = state.machines.get(handle.workloadId);
    expect(createdMachine?.config.guest).toEqual({
      cpu_kind: 'shared',
      cpus: 2,
      memory_mb: 2048,
    });
    expect(createdMachine?.config.mounts).toEqual([
      { volume: 'vol_123', path: '/var/cache/worker' },
    ]);
    expect(createdMachine?.config.checks).toMatchObject({
      httpget: { path: '/health', port: 4500 },
    });

    await flyWorkloadDriver.suspendWorkload(credentials, handle);
    expect(
      state.requests.some(
        (req) =>
          req.path === `/apps/inixiative-workers/machines/${handle.workloadId}/wait` &&
          req.query.includes('state=suspended'),
      ),
    ).toBe(true);

    await flyWorkloadDriver.wakeWorkload(credentials, handle);
    const wakeWait = state.requests.find(
      (req) =>
        req.path === `/apps/inixiative-workers/machines/${handle.workloadId}/wait` &&
        req.query.includes('state=started'),
    );
    expect(wakeWait).toBeDefined();
    expect(wakeWait?.query).not.toContain('instance_id');

    const machine = state.machines.get(handle.workloadId);
    if (machine) {
      const base = Date.now() - 300_000;
      machine.state = 'started';
      machine.events = [
        { type: 'start', status: 'started', timestamp: base },
        { type: 'suspend', status: 'suspended', timestamp: base + 100_000 },
        { type: 'start', status: 'started', timestamp: base + 220_000 },
      ];
    }
    const usage = await flyWorkloadDriver.fetchWorkloadUsage(credentials, {
      ...handle,
      metadata: { rootfsGb: 'not-a-number' },
    });
    expect(usage.metered).toBe(true);
    expect(usage.activeSeconds).toBeGreaterThanOrEqual(170);
    expect(usage.suspendedSeconds).toBe(120);
    expect(usage.rootfsGb).toBe(0);

    // Reconciles trailing open interval when machine.state disagrees with last event
    if (machine) {
      const base = Date.now() - 300_000;
      machine.state = 'stopped';
      machine.events = [{ type: 'start', status: 'started', timestamp: base }];
    }
    const reconciled = await flyWorkloadDriver.fetchWorkloadUsage(credentials, handle);
    expect(reconciled.activeSeconds).toBe(0);
    expect(reconciled.metered).toBe(true);

    // Empty events returns metered=false, 0 seconds
    if (machine) machine.events = [];
    const emptyUsage = await flyWorkloadDriver.fetchWorkloadUsage(credentials, handle);
    expect(emptyUsage).toMatchObject({ activeSeconds: 0, suspendedSeconds: 0, metered: false });

    await flyWorkloadDriver.destroyWorkload(credentials, handle);
    expect(state.machines.size).toBe(0);
    await flyWorkloadDriver.destroyWorkload(credentials, handle);
  });

  it('rejects missing volumeId, non-empty egressAllowlist, and suspend > 2048 MB', async () => {
    await expect(
      flyWorkloadDriver.provisionWorkload(credentials, {
        name: 'egress-blocked',
        image: 'ghcr.io/example/worker:1.0.0',
        memoryMb: 1024,
        vcpus: 1,
        egressAllowlist: ['api.example.com'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', provider: 'fly' });

    await expect(
      flyWorkloadDriver.provisionWorkload(credentials, {
        name: 'missing-volume-id',
        image: 'ghcr.io/example/worker:1.0.0',
        memoryMb: 1024,
        vcpus: 1,
        volume: { name: 'cache', mountPath: '/cache' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', provider: 'fly' });

    const handle = await flyWorkloadDriver.provisionWorkload(credentials, {
      name: 'oversized-machine',
      image: 'ghcr.io/example/worker:1.0.0',
      memoryMb: FLY_SUSPEND_MAX_MEMORY_MB + 512,
      vcpus: 2,
    });

    state.requests.length = 0;
    await expect(flyWorkloadDriver.suspendWorkload(credentials, handle)).rejects.toMatchObject({
      code: 'invalid_request',
      provider: 'fly',
    });
    expect(state.requests.some((req) => req.path.endsWith('/suspend'))).toBe(false);

    const handleWithoutMemory = { ...handle, memoryMb: undefined };
    await expect(
      flyWorkloadDriver.suspendWorkload(credentials, handleWithoutMemory),
    ).rejects.toBeInstanceOf(InfraError);
    expect(state.requests.some((req) => req.path.endsWith('/suspend'))).toBe(false);
  });

  it('maps HTTP 401, 409, 429, and 503 responses to InfraError codes', async () => {
    await expect(
      flyWorkloadDriver.fetchWorkloadStatus(
        { ...credentials, token: 'bad-token' },
        { provider: 'fly', workloadId: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'authentication_failed' });

    state.nextErrorStatus = 409;
    await expect(
      flyWorkloadDriver.fetchWorkloadStatus(credentials, { provider: 'fly', workloadId: 'x' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    state.nextErrorStatus = 429;
    await expect(
      flyWorkloadDriver.fetchWorkloadStatus(credentials, { provider: 'fly', workloadId: 'x' }),
    ).rejects.toMatchObject({ code: 'rate_limited', retryable: true });

    state.nextErrorStatus = 503;
    await expect(
      flyWorkloadDriver.fetchWorkloadStatus(credentials, { provider: 'fly', workloadId: 'x' }),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
  });
});

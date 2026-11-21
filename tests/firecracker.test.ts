import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firecrackerWorkloadDriver } from '../src/index.ts';

type VmState = {
  id: string;
  state: 'Not started' | 'Running' | 'Paused';
  vmm_version: string;
  machineConfig?: Record<string, unknown>;
  bootSource?: Record<string, unknown>;
  drives: Record<string, Record<string, unknown>>;
  networkInterfaces: Record<string, Record<string, unknown>>;
  snapshots: Array<Record<string, unknown>>;
  snapshotLoads: Array<Record<string, unknown>>;
  actions: string[];
  calls: string[];
};

const createVmState = (): VmState => ({
  id: 'fc-vm-1',
  state: 'Not started',
  vmm_version: '1.10.0',
  drives: {},
  networkInterfaces: {},
  snapshots: [],
  snapshotLoads: [],
  actions: [],
  calls: [],
});

const handleFirecrackerRequest = async (vm: VmState, request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;
  const body =
    request.method === 'PUT' || request.method === 'PATCH'
      ? ((await request.json().catch(() => ({}))) as Record<string, unknown>)
      : undefined;
  vm.calls.push(`${request.method} ${path}`);

  if (request.method === 'GET' && path === '/') {
    return Response.json({
      id: vm.id,
      state: vm.state,
      vmm_version: vm.vmm_version,
      app_name: 'Firecracker',
    });
  }
  if (request.method === 'PUT' && path === '/machine-config') {
    vm.machineConfig = body;
    return new Response(null, { status: 204 });
  }
  if (request.method === 'PUT' && path === '/boot-source') {
    vm.bootSource = body;
    return new Response(null, { status: 204 });
  }
  if (request.method === 'PUT' && path.startsWith('/drives/')) {
    const driveId = path.slice('/drives/'.length);
    vm.drives[driveId] = body ?? {};
    return new Response(null, { status: 204 });
  }
  if (request.method === 'PUT' && path.startsWith('/network-interfaces/')) {
    const ifaceId = path.slice('/network-interfaces/'.length);
    vm.networkInterfaces[ifaceId] = body ?? {};
    return new Response(null, { status: 204 });
  }
  if (request.method === 'PUT' && path === '/actions') {
    const actionType = String(body?.action_type ?? '');
    vm.actions.push(actionType);
    if (actionType === 'InstanceStart') vm.state = 'Running';
    if (actionType === 'SendCtrlAltDel') vm.state = 'Not started';
    return new Response(null, { status: 204 });
  }
  if (request.method === 'PATCH' && path === '/vm') {
    if (body?.state === 'Paused') vm.state = 'Paused';
    if (body?.state === 'Resumed') vm.state = 'Running';
    return new Response(null, { status: 204 });
  }
  if (request.method === 'PUT' && path === '/snapshot/create') {
    vm.snapshots.push(body ?? {});
    return new Response(null, { status: 204 });
  }
  if (request.method === 'PUT' && path === '/snapshot/load') {
    vm.snapshotLoads.push(body ?? {});
    if (body?.resume_vm) vm.state = 'Running';
    return new Response(null, { status: 204 });
  }
  return Response.json({ fault_message: 'not found' }, { status: 404 });
};

let httpVm = createVmState();
const httpServer = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (request) => handleFirecrackerRequest(httpVm, request),
});

let unixVm = createVmState();
const unixSocketPath = join(tmpdir(), `inixiative-infra-fc-${process.pid}.sock`);
const unixServer = Bun.serve({
  unix: unixSocketPath,
  fetch: (request) => handleFirecrackerRequest(unixVm, request),
});

afterAll(() => {
  httpServer.stop(true);
  unixServer.stop(true);
});

describe('firecrackerWorkloadDriver', () => {
  beforeEach(() => {
    httpVm = createVmState();
    unixVm = createVmState();
  });

  it('configures microVM with track_dirty_pages, snapshots, loads snapshot, checks unmetered usage, and state-guards destroy', async () => {
    const credentials = { apiUrl: `http://127.0.0.1:${httpServer.port}/` };
    const handle = await firecrackerWorkloadDriver.provisionWorkload(credentials, {
      name: 'worker-fc-1',
      image: '/var/lib/firecracker/rootfs.ext4',
      memoryMb: 1536,
      vcpus: 2,
      trackDirtyPages: true,
      kernelImagePath: '/var/lib/firecracker/vmlinux-6.1',
      volume: {
        name: 'workspace',
        mountPath: '/workspace',
        hostPath: '/var/lib/firecracker/work.ext4',
      },
      networkInterface: {
        ifaceId: 'eth0',
        hostDevName: 'tap0',
        guestMac: 'AA:FC:00:00:00:01',
      },
      snapshotPath: '/snapshots/fc-vm-1.snap',
      memFilePath: '/snapshots/fc-vm-1.mem',
    });

    expect(handle.workloadId).toBe('fc-vm-1');
    expect(httpVm.machineConfig).toMatchObject({ track_dirty_pages: true });
    expect(httpVm.drives.workspace).toMatchObject({
      path_on_host: '/var/lib/firecracker/work.ext4',
    });
    expect(httpVm.calls).toEqual([
      'PUT /machine-config',
      'PUT /boot-source',
      'PUT /drives/rootfs',
      'PUT /drives/workspace',
      'PUT /network-interfaces/eth0',
      'PUT /actions',
      'GET /',
    ]);

    const suspendedHandle = await firecrackerWorkloadDriver.suspendWorkload(credentials, handle);
    expect(suspendedHandle.snapshotPath).toBe('/snapshots/fc-vm-1.snap');
    expect(httpVm.snapshots).toHaveLength(1);

    // destroyWorkload on Paused VM does NOT send SendCtrlAltDel
    await firecrackerWorkloadDriver.destroyWorkload(credentials, suspendedHandle);
    expect(httpVm.actions).not.toContain('SendCtrlAltDel');

    // Resume from Paused state uses PATCH /vm Resumed
    await firecrackerWorkloadDriver.wakeWorkload(credentials, suspendedHandle);
    expect((await firecrackerWorkloadDriver.fetchWorkloadStatus(credentials, handle)).state).toBe(
      'running',
    );

    // Cold restore from Not started uses PUT /snapshot/load with track_dirty_pages (never deprecated enable_diff_snapshots)
    httpVm.state = 'Not started';
    await firecrackerWorkloadDriver.wakeWorkload(credentials, suspendedHandle);
    expect(httpVm.snapshotLoads[0]).toMatchObject({
      track_dirty_pages: true,
      resume_vm: true,
    });
    expect(httpVm.snapshotLoads[0]).not.toHaveProperty('enable_diff_snapshots');

    const usage = await firecrackerWorkloadDriver.fetchWorkloadUsage(credentials, handle);
    expect(usage).toMatchObject({ activeSeconds: 0, suspendedSeconds: 0, metered: false });

    // destroyWorkload on Running VM sends SendCtrlAltDel
    await firecrackerWorkloadDriver.destroyWorkload(credentials, handle);
    expect(httpVm.actions).toContain('SendCtrlAltDel');
    expect((await firecrackerWorkloadDriver.fetchWorkloadStatus(credentials, handle)).state).toBe(
      'stopped',
    );
  });

  it('rejects path traversal IDs, rootfs volume clobbering, missing hostPath, and egressAllowlist', async () => {
    const credentials = { apiUrl: `http://127.0.0.1:${httpServer.port}` };

    await expect(
      firecrackerWorkloadDriver.provisionWorkload(credentials, {
        name: '../escape',
        image: '/images/rootfs.ext4',
        memoryMb: 1024,
        vcpus: 1,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', provider: 'firecracker' });

    await expect(
      firecrackerWorkloadDriver.suspendWorkload(credentials, {
        provider: 'firecracker',
        workloadId: 'bad/id',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', provider: 'firecracker' });

    await expect(
      firecrackerWorkloadDriver.provisionWorkload(credentials, {
        name: 'clobber-rootfs',
        image: '/images/rootfs.ext4',
        memoryMb: 1024,
        vcpus: 1,
        volume: { name: 'rootfs', mountPath: '/data', hostPath: '/images/extra.ext4' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', provider: 'firecracker' });

    await expect(
      firecrackerWorkloadDriver.provisionWorkload(credentials, {
        name: 'missing-hostpath',
        image: '/images/rootfs.ext4',
        memoryMb: 1024,
        vcpus: 1,
        volume: { name: 'data', mountPath: '/data' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', provider: 'firecracker' });

    await expect(
      firecrackerWorkloadDriver.provisionWorkload(credentials, {
        name: 'egress-blocked',
        image: '/images/rootfs.ext4',
        memoryMb: 1024,
        vcpus: 1,
        egressAllowlist: ['api.example.com'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', provider: 'firecracker' });
  });

  it('communicates directly over a Unix domain socket and validates transport', async () => {
    const credentials = { unixSocketPath };
    const handle = await firecrackerWorkloadDriver.provisionWorkload(credentials, {
      name: 'unix-fc-vm',
      image: '/images/rootfs.ext4',
      memoryMb: 1024,
      vcpus: 1,
    });
    expect(handle.provider).toBe('firecracker');
    expect(unixVm.state).toBe('Running');

    await firecrackerWorkloadDriver.suspendWorkload(credentials, handle);
    expect(unixVm.state).toBe('Paused');

    await expect(
      firecrackerWorkloadDriver.fetchWorkloadStatus(
        {},
        { provider: 'firecracker', workloadId: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_request', provider: 'firecracker' });
  });
});

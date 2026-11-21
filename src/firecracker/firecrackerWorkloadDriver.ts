import type {
  WorkloadCredentials,
  WorkloadDriver,
  WorkloadHandle,
  WorkloadRuntimeState,
  WorkloadSpec,
  WorkloadStatus,
  WorkloadUsage,
} from '../core/contracts.ts';
import { assertNoEgressAllowlist, InfraError, ignoreNotFound } from '../core/infraError.ts';
import { type FirecrackerTransport, sendFirecrackerRequest } from './firecrackerRequest.ts';

const DEFAULT_KERNEL_IMAGE_PATH = '/var/lib/firecracker/vmlinux';
const DEFAULT_BOOT_ARGS = 'console=ttyS0 reboot=k panic=1 pci=off';
const SAFE_FIRECRACKER_ID = /^[A-Za-z0-9._-]+$/;

type FirecrackerInstanceInfo = {
  readonly id: string;
  readonly state: 'Not started' | 'Running' | 'Paused' | string;
  readonly vmm_version: string;
  readonly app_name?: string;
};

const transportFromCredentials = (credentials: WorkloadCredentials): FirecrackerTransport => ({
  apiUrl: credentials.apiUrl,
  unixSocketPath: credentials.unixSocketPath,
  token: credentials.token,
});

const assertSafeFirecrackerId = (value: string, label: string): string => {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('..') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    !SAFE_FIRECRACKER_ID.test(value)
  ) {
    throw new InfraError(
      'invalid_request',
      `Invalid Firecracker ${label}: must match /^[A-Za-z0-9._-]+$/ without path traversal`,
      { provider: 'firecracker' },
    );
  }
  return value;
};

const parseRootfsGb = (raw: string | undefined): number => {
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const mapFirecrackerState = (state: string): WorkloadRuntimeState => {
  switch (state) {
    case 'Running':
      return 'running';
    case 'Paused':
      return 'suspended';
    case 'Not started':
      return 'stopped';
    default:
      return 'unknown';
  }
};

export const firecrackerWorkloadDriver: WorkloadDriver = {
  provider: 'firecracker',
  provisionWorkload: async (
    credentials: WorkloadCredentials,
    spec: WorkloadSpec,
  ): Promise<WorkloadHandle> => {
    const transport = transportFromCredentials(credentials);
    assertNoEgressAllowlist(spec.egressAllowlist, 'firecracker');
    assertSafeFirecrackerId(spec.name, 'workload name');

    if (spec.volume) {
      if (spec.volume.name === 'rootfs') {
        throw new InfraError(
          'invalid_request',
          'Firecracker secondary drive name cannot be "rootfs"',
          { provider: 'firecracker' },
        );
      }
      assertSafeFirecrackerId(spec.volume.name, 'volume name');
      if (!spec.volume.hostPath) {
        throw new InfraError(
          'invalid_request',
          'Firecracker secondary drives require an explicit volume.hostPath backing file',
          { provider: 'firecracker' },
        );
      }
    }

    const trackDirtyPages = spec.trackDirtyPages ?? false;

    await sendFirecrackerRequest(transport, '/machine-config', {
      method: 'PUT',
      body: {
        vcpu_count: spec.vcpus,
        mem_size_mib: spec.memoryMb,
        smt: false,
        track_dirty_pages: trackDirtyPages,
      },
    });

    await sendFirecrackerRequest(transport, '/boot-source', {
      method: 'PUT',
      body: {
        kernel_image_path: spec.kernelImagePath ?? DEFAULT_KERNEL_IMAGE_PATH,
        boot_args: spec.bootArgs ?? DEFAULT_BOOT_ARGS,
      },
    });

    await sendFirecrackerRequest(transport, '/drives/rootfs', {
      method: 'PUT',
      body: {
        drive_id: 'rootfs',
        path_on_host: spec.image,
        is_root_device: true,
        is_read_only: false,
      },
    });

    if (spec.volume?.hostPath) {
      const encodedDriveId = encodeURIComponent(spec.volume.name);
      await sendFirecrackerRequest(transport, `/drives/${encodedDriveId}`, {
        method: 'PUT',
        body: {
          drive_id: spec.volume.name,
          path_on_host: spec.volume.hostPath,
          is_root_device: false,
          is_read_only: false,
        },
      });
    }

    if (spec.networkInterface) {
      assertSafeFirecrackerId(spec.networkInterface.ifaceId, 'network interface id');
      const encodedIfaceId = encodeURIComponent(spec.networkInterface.ifaceId);
      await sendFirecrackerRequest(transport, `/network-interfaces/${encodedIfaceId}`, {
        method: 'PUT',
        body: {
          iface_id: spec.networkInterface.ifaceId,
          host_dev_name: spec.networkInterface.hostDevName,
          ...(spec.networkInterface.guestMac ? { guest_mac: spec.networkInterface.guestMac } : {}),
        },
      });
    }

    await sendFirecrackerRequest(transport, '/actions', {
      method: 'PUT',
      body: { action_type: 'InstanceStart' },
    });

    const info = await sendFirecrackerRequest<FirecrackerInstanceInfo>(transport, '/');
    const workloadId = assertSafeFirecrackerId(info.id || spec.name, 'workloadId');

    return {
      provider: 'firecracker',
      workloadId,
      name: spec.name,
      region: spec.region,
      memoryMb: spec.memoryMb,
      vcpus: spec.vcpus,
      snapshotPath: spec.snapshotPath,
      memFilePath: spec.memFilePath,
      metadata: {
        vmmVersion: info.vmm_version,
        trackDirtyPages: String(trackDirtyPages),
      },
    };
  },
  suspendWorkload: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadHandle> => {
    const transport = transportFromCredentials(credentials);
    const safeWorkloadId = assertSafeFirecrackerId(handle.workloadId, 'workloadId');
    const snapshotPath =
      handle.snapshotPath ?? `/var/lib/firecracker/snapshots/${safeWorkloadId}.snap`;
    const memFilePath =
      handle.memFilePath ?? `/var/lib/firecracker/snapshots/${safeWorkloadId}.mem`;

    await sendFirecrackerRequest(transport, '/vm', {
      method: 'PATCH',
      body: { state: 'Paused' },
    });

    await sendFirecrackerRequest(transport, '/snapshot/create', {
      method: 'PUT',
      body: {
        snapshot_type: 'Full',
        snapshot_path: snapshotPath,
        mem_file_path: memFilePath,
      },
    });

    return {
      ...handle,
      snapshotPath,
      memFilePath,
    };
  },
  wakeWorkload: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadHandle> => {
    const transport = transportFromCredentials(credentials);
    const info = await sendFirecrackerRequest<FirecrackerInstanceInfo>(transport, '/');

    if (info.state === 'Not started' && handle.snapshotPath && handle.memFilePath) {
      const trackDirtyPages = handle.metadata?.trackDirtyPages === 'true';
      await sendFirecrackerRequest(transport, '/snapshot/load', {
        method: 'PUT',
        body: {
          snapshot_path: handle.snapshotPath,
          mem_backend: {
            backend_path: handle.memFilePath,
            backend_type: 'File',
          },
          track_dirty_pages: trackDirtyPages,
          resume_vm: true,
        },
      });
    } else if (info.state === 'Paused') {
      await sendFirecrackerRequest(transport, '/vm', {
        method: 'PATCH',
        body: { state: 'Resumed' },
      });
    } else if (info.state === 'Not started') {
      await sendFirecrackerRequest(transport, '/actions', {
        method: 'PUT',
        body: { action_type: 'InstanceStart' },
      });
    }

    return handle;
  },
  fetchWorkloadStatus: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadStatus> => {
    const transport = transportFromCredentials(credentials);
    const info = await sendFirecrackerRequest<FirecrackerInstanceInfo>(transport, '/');

    return {
      provider: 'firecracker',
      workloadId: info.id || handle.workloadId,
      state: mapFirecrackerState(info.state),
      providerState: info.state,
      region: handle.region,
      memoryMb: handle.memoryMb,
      vcpus: handle.vcpus,
      updatedAt: new Date().toISOString(),
    };
  },
  fetchWorkloadUsage: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadUsage> => {
    const status = await firecrackerWorkloadDriver.fetchWorkloadStatus(credentials, handle);
    const nowIso = new Date().toISOString();
    return {
      provider: 'firecracker',
      workloadId: status.workloadId,
      memoryMb: handle.memoryMb ?? 0,
      vcpus: handle.vcpus ?? 0,
      activeSeconds: 0,
      suspendedSeconds: 0,
      rootfsGb: parseRootfsGb(handle.metadata?.rootfsGb),
      metered: false,
      windowStartIso: nowIso,
      windowEndIso: nowIso,
    };
  },
  destroyWorkload: async (
    credentials: WorkloadCredentials,
    _handle: WorkloadHandle,
  ): Promise<void> => {
    const transport = transportFromCredentials(credentials);
    const info = await sendFirecrackerRequest<FirecrackerInstanceInfo>(transport, '/').catch(
      (error) => {
        ignoreNotFound(error);
        return undefined;
      },
    );
    // Firecracker only accepts SendCtrlAltDel while Running; paused/not-started VMs are reaped by host VMM teardown.
    if (info?.state !== 'Running') return;
    await sendFirecrackerRequest(transport, '/actions', {
      method: 'PUT',
      body: { action_type: 'SendCtrlAltDel' },
    }).catch(ignoreNotFound);
  },
};

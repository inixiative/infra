import type {
  WorkloadCredentials,
  WorkloadDriver,
  WorkloadHandle,
  WorkloadRuntimeState,
  WorkloadSpec,
  WorkloadStatus,
  WorkloadUsage,
} from '../core/contracts.ts';
import { InfraError, isInfraError } from '../core/infraError.ts';
import { sendFlyRequest } from './flyRequest.ts';

export const FLY_SUSPEND_MAX_MEMORY_MB = 2048;

type FlyMachineEvent = {
  readonly type: string;
  readonly status: string;
  readonly timestamp: number;
};

type FlyMachine = {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly region: string;
  readonly instance_id?: string;
  readonly updated_at?: string;
  readonly created_at?: string;
  readonly config?: {
    readonly image?: string;
    readonly guest?: {
      readonly cpu_kind?: string;
      readonly cpus?: number;
      readonly memory_mb?: number;
    };
    readonly metadata?: Record<string, string>;
  };
  readonly events?: readonly FlyMachineEvent[];
};

const requireFlyAuth = (
  credentials: WorkloadCredentials,
  appFallback?: string,
): { readonly token: string; readonly appName: string } => {
  if (!credentials.token) {
    throw new InfraError('authentication_failed', 'Fly.io API token is required', {
      provider: 'fly',
    });
  }
  const appName = credentials.appName ?? appFallback;
  if (!appName) {
    throw new InfraError('invalid_request', 'Fly.io appName is required', {
      provider: 'fly',
    });
  }
  return { token: credentials.token, appName };
};

const mapFlyMachineState = (state: string): WorkloadRuntimeState => {
  switch (state) {
    case 'created':
      return 'provisioning';
    case 'starting':
      return 'starting';
    case 'started':
      return 'running';
    case 'suspending':
      return 'suspending';
    case 'suspended':
      return 'suspended';
    case 'stopping':
      return 'stopping';
    case 'stopped':
      return 'stopped';
    case 'destroying':
      return 'destroying';
    case 'destroyed':
      return 'destroyed';
    default:
      return 'unknown';
  }
};

const accumulateFlyEventDurations = (
  events: readonly FlyMachineEvent[],
  currentState: string,
  nowMs: number,
): {
  readonly activeSeconds: number;
  readonly suspendedSeconds: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
} => {
  if (events.length === 0) {
    return {
      activeSeconds: currentState === 'started' ? 60 : 0,
      suspendedSeconds: currentState === 'suspended' ? 60 : 0,
      windowStartMs: nowMs,
      windowEndMs: nowMs,
    };
  }

  const ordered = [...events].sort((left, right) => left.timestamp - right.timestamp);
  let activeMs = 0;
  let suspendedMs = 0;

  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    const nextTimestamp = ordered[index + 1]?.timestamp ?? nowMs;
    const durationMs = Math.max(0, nextTimestamp - current.timestamp);
    if (current.status === 'started') {
      activeMs += durationMs;
    } else if (current.status === 'suspended') {
      suspendedMs += durationMs;
    }
  }

  return {
    activeSeconds: Math.round(activeMs / 1000),
    suspendedSeconds: Math.round(suspendedMs / 1000),
    windowStartMs: ordered[0].timestamp,
    windowEndMs: Math.max(nowMs, ordered[ordered.length - 1].timestamp),
  };
};

export const flyWorkloadDriver: WorkloadDriver = {
  provider: 'fly',
  provisionWorkload: async (
    credentials: WorkloadCredentials,
    spec: WorkloadSpec,
  ): Promise<WorkloadHandle> => {
    const { token, appName } = requireFlyAuth(credentials, spec.labels?.['fly.app']);
    const encodedApp = encodeURIComponent(appName);

    const services = spec.port
      ? [
          {
            protocol: spec.port.protocol ?? 'tcp',
            internal_port: spec.port.internalPort,
            autostart: false,
            autostop: 'off',
            ...(spec.port.publicHttps
              ? {
                  ports: [{ port: 443, handlers: ['tls', 'http'] }],
                }
              : {}),
          },
        ]
      : undefined;

    const machine = await sendFlyRequest<FlyMachine>(
      token,
      `/apps/${encodedApp}/machines`,
      {
        method: 'POST',
        body: {
          name: spec.name,
          ...(spec.region ? { region: spec.region } : {}),
          config: {
            image: spec.image,
            ...(spec.env ? { env: spec.env } : {}),
            guest: {
              cpu_kind: spec.cpuKind ?? 'shared',
              cpus: spec.vcpus,
              memory_mb: spec.memoryMb,
            },
            ...(spec.volume
              ? {
                  mounts: [
                    {
                      volume: spec.volume.volumeId ?? spec.volume.name,
                      path: spec.volume.mountPath,
                    },
                  ],
                }
              : {}),
            auto_destroy: spec.autoDestroy ?? false,
            ...(services ? { services } : {}),
            ...(spec.labels ? { metadata: spec.labels } : {}),
          },
        },
      },
      credentials.apiUrl,
    );

    const memoryMb = machine.config?.guest?.memory_mb ?? spec.memoryMb;
    const vcpus = machine.config?.guest?.cpus ?? spec.vcpus;

    return {
      provider: 'fly',
      workloadId: machine.id,
      name: machine.name,
      region: machine.region,
      appName,
      url: spec.port?.publicHttps ? `https://${appName}.fly.dev` : undefined,
      memoryMb,
      vcpus,
      metadata: machine.instance_id ? { instanceId: machine.instance_id } : undefined,
    };
  },
  suspendWorkload: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadHandle> => {
    const { token, appName } = requireFlyAuth(credentials, handle.appName);
    const encodedApp = encodeURIComponent(appName);
    const encodedId = encodeURIComponent(handle.workloadId);

    let memoryMb = handle.memoryMb;
    if (memoryMb === undefined) {
      const machine = await sendFlyRequest<FlyMachine>(
        token,
        `/apps/${encodedApp}/machines/${encodedId}`,
        {},
        credentials.apiUrl,
      );
      memoryMb = machine.config?.guest?.memory_mb;
    }

    if (memoryMb !== undefined && memoryMb > FLY_SUSPEND_MAX_MEMORY_MB) {
      throw new InfraError(
        'invalid_request',
        `Fly.io Machines suspend requires memoryMb <= ${FLY_SUSPEND_MAX_MEMORY_MB} (got ${memoryMb} MB)`,
        { provider: 'fly' },
      );
    }

    await sendFlyRequest(
      token,
      `/apps/${encodedApp}/machines/${encodedId}/suspend`,
      { method: 'POST' },
      credentials.apiUrl,
    );

    return {
      ...handle,
      appName,
      memoryMb,
    };
  },
  wakeWorkload: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadHandle> => {
    const { token, appName } = requireFlyAuth(credentials, handle.appName);
    const encodedApp = encodeURIComponent(appName);
    const encodedId = encodeURIComponent(handle.workloadId);

    await sendFlyRequest(
      token,
      `/apps/${encodedApp}/machines/${encodedId}/start`,
      { method: 'POST' },
      credentials.apiUrl,
    );

    const waitQuery = new URLSearchParams({ state: 'started', timeout: '30' });
    if (handle.metadata?.instanceId) {
      waitQuery.set('instance_id', handle.metadata.instanceId);
    }
    await sendFlyRequest(
      token,
      `/apps/${encodedApp}/machines/${encodedId}/wait?${waitQuery}`,
      {},
      credentials.apiUrl,
    );

    return { ...handle, appName };
  },
  fetchWorkloadStatus: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadStatus> => {
    const { token, appName } = requireFlyAuth(credentials, handle.appName);
    const encodedApp = encodeURIComponent(appName);
    const encodedId = encodeURIComponent(handle.workloadId);

    const machine = await sendFlyRequest<FlyMachine>(
      token,
      `/apps/${encodedApp}/machines/${encodedId}`,
      {},
      credentials.apiUrl,
    );

    return {
      provider: 'fly',
      workloadId: machine.id,
      state: mapFlyMachineState(machine.state),
      providerState: machine.state,
      region: machine.region,
      url: handle.url,
      memoryMb: machine.config?.guest?.memory_mb ?? handle.memoryMb,
      vcpus: machine.config?.guest?.cpus ?? handle.vcpus,
      updatedAt: machine.updated_at,
    };
  },
  fetchWorkloadUsage: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadUsage> => {
    const { token, appName } = requireFlyAuth(credentials, handle.appName);
    const encodedApp = encodeURIComponent(appName);
    const encodedId = encodeURIComponent(handle.workloadId);

    const machine = await sendFlyRequest<FlyMachine>(
      token,
      `/apps/${encodedApp}/machines/${encodedId}`,
      {},
      credentials.apiUrl,
    );
    const nowMs = Date.now();
    const durations = accumulateFlyEventDurations(machine.events ?? [], machine.state, nowMs);

    return {
      provider: 'fly',
      workloadId: machine.id,
      memoryMb: machine.config?.guest?.memory_mb ?? handle.memoryMb ?? 0,
      vcpus: machine.config?.guest?.cpus ?? handle.vcpus ?? 0,
      activeSeconds: durations.activeSeconds,
      suspendedSeconds: durations.suspendedSeconds,
      rootfsGb: Number(handle.metadata?.rootfsGb ?? 2),
      windowStartIso: new Date(durations.windowStartMs).toISOString(),
      windowEndIso: new Date(durations.windowEndMs).toISOString(),
    };
  },
  destroyWorkload: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<void> => {
    const { token, appName } = requireFlyAuth(credentials, handle.appName);
    const encodedApp = encodeURIComponent(appName);
    const encodedId = encodeURIComponent(handle.workloadId);

    await sendFlyRequest(
      token,
      `/apps/${encodedApp}/machines/${encodedId}?force=true`,
      { method: 'DELETE' },
      credentials.apiUrl,
    ).catch((error) => {
      if (!isInfraError(error, 'not_found')) throw error;
    });
  },
};

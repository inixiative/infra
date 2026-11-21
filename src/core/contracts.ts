import { InfraError } from './infraError.ts';
import type { ArchiveHostingProvider, ImplementedInfraProvider } from './providers.ts';

export const ARCHIVE_IMAGE = 'ghcr.io/inixiative/archive';
export const ARCHIVE_PORT = 4700;
export const ARCHIVE_DATABASE = 'archive';

export type WorkloadCpuKind = 'shared' | 'performance';

export type WorkloadVolumeSpec = {
  readonly name: string;
  readonly mountPath: string;
  readonly sizeGb?: number;
  readonly volumeId?: string;
  readonly hostPath?: string;
};

export type WorkloadPortSpec = {
  readonly internalPort: number;
  readonly protocol?: 'tcp' | 'udp';
  readonly publicHttps?: boolean;
};

export type WorkloadNetworkInterfaceSpec = {
  readonly ifaceId: string;
  readonly hostDevName: string;
  readonly guestMac?: string;
};

export type WorkloadCredentials = {
  readonly token?: string;
  readonly apiUrl?: string;
  readonly unixSocketPath?: string;
  readonly workspaceId?: string;
  readonly appName?: string;
  readonly projectId?: string;
  readonly environmentId?: string;
};

export type WorkloadSpec = {
  readonly name: string;
  readonly image: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly memoryMb: number;
  readonly cpuKind?: WorkloadCpuKind;
  readonly vcpus: number;
  readonly region?: string;
  readonly volume?: WorkloadVolumeSpec;
  readonly egressAllowlist?: readonly string[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly port?: WorkloadPortSpec;
  readonly healthcheckPath?: string;
  readonly autoDestroy?: boolean;
  readonly kernelImagePath?: string;
  readonly bootArgs?: string;
  readonly snapshotPath?: string;
  readonly memFilePath?: string;
  readonly trackDirtyPages?: boolean;
  readonly networkInterface?: WorkloadNetworkInterfaceSpec;
};

export type WorkloadHandle = {
  readonly provider: ImplementedInfraProvider;
  readonly workloadId: string;
  readonly name?: string;
  readonly region?: string;
  readonly url?: string;
  readonly memoryMb?: number;
  readonly vcpus?: number;
  readonly projectId?: string;
  readonly environmentId?: string;
  readonly appName?: string;
  readonly snapshotPath?: string;
  readonly memFilePath?: string;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type WorkloadRuntimeState =
  | 'provisioning'
  | 'starting'
  | 'running'
  | 'suspending'
  | 'suspended'
  | 'stopping'
  | 'stopped'
  | 'destroying'
  | 'destroyed'
  | 'failed'
  | 'unknown';

export type WorkloadStatus = {
  readonly provider: ImplementedInfraProvider;
  readonly workloadId: string;
  readonly state: WorkloadRuntimeState;
  readonly providerState: string;
  readonly region?: string;
  readonly url?: string;
  readonly memoryMb?: number;
  readonly vcpus?: number;
  readonly updatedAt?: string;
};

export type WorkloadUsage = {
  readonly provider: ImplementedInfraProvider;
  readonly workloadId: string;
  readonly memoryMb: number;
  readonly vcpus: number;
  readonly activeSeconds: number;
  readonly suspendedSeconds: number;
  readonly rootfsGb: number;
  readonly metered: boolean;
  readonly windowStartIso: string;
  readonly windowEndIso: string;
};

export type WorkloadDriver = {
  readonly provider: ImplementedInfraProvider;
  readonly provisionWorkload: (
    credentials: WorkloadCredentials,
    spec: WorkloadSpec,
  ) => Promise<WorkloadHandle>;
  readonly suspendWorkload: (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ) => Promise<WorkloadHandle>;
  readonly wakeWorkload: (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ) => Promise<WorkloadHandle>;
  readonly fetchWorkloadStatus: (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ) => Promise<WorkloadStatus>;
  readonly fetchWorkloadUsage: (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ) => Promise<WorkloadUsage>;
  readonly destroyWorkload: (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ) => Promise<void>;
};

export type ArchiveDeploymentIds = {
  readonly projectId?: string;
  readonly environmentId?: string;
  readonly databaseServiceId?: string;
  readonly serviceId?: string;
  readonly databaseId?: string;
  readonly deploymentId?: string;
};

export type ArchiveDeployment = {
  readonly apiUrl?: string;
  readonly token: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly imageVersion: string;
  readonly archiveToken?: string;
  readonly ids: ArchiveDeploymentIds;
};

export type HostingWorkspace = {
  readonly id: string;
  readonly name: string;
};

export type ImageDeployStatus = 'deploying' | 'live' | 'failed';

export const archiveTokenOrThrow = (deployment: ArchiveDeployment): string => {
  if (!deployment.archiveToken) {
    throw new InfraError('authentication_failed', 'Archive server token is required');
  }
  return deployment.archiveToken;
};

export type ArchiveHostingDriver = {
  readonly provider: ArchiveHostingProvider;
  readonly fetchWorkspaces: (token: string, apiUrl?: string) => Promise<HostingWorkspace[]>;
  readonly provisionDatabase: (deployment: ArchiveDeployment) => Promise<ArchiveDeploymentIds>;
  readonly fetchDatabaseReadiness: (deployment: ArchiveDeployment) => Promise<boolean>;
  readonly provisionService: (
    deployment: ArchiveDeployment,
  ) => Promise<{ readonly ids: ArchiveDeploymentIds; readonly url: string }>;
  readonly fetchServiceReadiness: (deployment: ArchiveDeployment) => Promise<boolean>;
  readonly fetchServiceFailureStatus: (deployment: ArchiveDeployment) => Promise<boolean>;
  readonly deployImage: (deployment: ArchiveDeployment) => Promise<ArchiveDeploymentIds>;
  readonly restoreImage: (deployment: ArchiveDeployment) => Promise<void>;
  readonly fetchImageDeployStatus: (deployment: ArchiveDeployment) => Promise<ImageDeployStatus>;
  readonly destroyService: (deployment: ArchiveDeployment) => Promise<void>;
};

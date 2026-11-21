import type {
  WorkloadCredentials,
  WorkloadDriver,
  WorkloadHandle,
  WorkloadRuntimeState,
  WorkloadSpec,
  WorkloadStatus,
  WorkloadUsage,
} from '../core/contracts.ts';
import { assertNoEgressAllowlist, InfraError, requireNonEmpty } from '../core/infraError.ts';
import {
  deleteRailwayService,
  deployRailwayServiceInstance,
  ensureRailwayProject,
  ensureRailwayService,
  ensureRailwayServiceDomain,
  ensureRailwayVolume,
  fetchRailwayServiceInstance,
  stopRailwayDeployment,
  updateRailwayServiceInstance,
  upsertRailwayServiceVariables,
} from './railwayResources.ts';

const requireRailwayToken = (credentials: WorkloadCredentials): string => {
  if (!credentials.token) {
    throw new InfraError('authentication_failed', 'Railway API token is required', {
      provider: 'railway',
    });
  }
  return credentials.token;
};

const requireEnvironmentId = (credentials: WorkloadCredentials, handle: WorkloadHandle): string =>
  requireNonEmpty(
    handle.environmentId ?? credentials.environmentId,
    'Railway environmentId',
    'railway',
  );

const mapRailwayDeploymentState = (status: string | undefined): WorkloadRuntimeState => {
  switch (status) {
    case 'SUCCESS':
      return 'running';
    case 'SLEEPING':
      return 'suspended';
    case 'BUILDING':
    case 'DEPLOYING':
    case 'INITIALIZING':
    case 'WAITING':
      return 'starting';
    case 'REMOVING':
      return 'stopping';
    case 'REMOVED':
    case 'STOPPED':
    case undefined:
      return 'stopped';
    case 'FAILED':
    case 'CRASHED':
      return 'failed';
    default:
      return 'unknown';
  }
};

export const railwayWorkloadDriver: WorkloadDriver = {
  provider: 'railway',
  provisionWorkload: async (
    credentials: WorkloadCredentials,
    spec: WorkloadSpec,
  ): Promise<WorkloadHandle> => {
    const token = requireRailwayToken(credentials);
    assertNoEgressAllowlist(spec.egressAllowlist, 'railway');

    let projectId = credentials.projectId;
    let environmentId = credentials.environmentId;
    if (!projectId || !environmentId) {
      if (!projectId && !credentials.workspaceId) {
        throw new InfraError(
          'invalid_request',
          'Railway workload provisioning requires either (projectId + environmentId), projectId, or workspaceId',
          { provider: 'railway' },
        );
      }
      const ensured = await ensureRailwayProject(
        token,
        credentials.workspaceId ?? '',
        spec.name,
        { projectId, environmentId },
        credentials.apiUrl,
      );
      projectId = ensured.projectId;
      environmentId = ensured.environmentId;
    }

    const serviceId = await ensureRailwayService(
      token,
      projectId,
      environmentId,
      spec.name,
      credentials.apiUrl,
    );

    if (spec.volume) {
      await ensureRailwayVolume(
        token,
        projectId,
        environmentId,
        serviceId,
        spec.volume.mountPath,
        credentials.apiUrl,
      );
    }

    const variables: Record<string, string> = {
      ...(spec.env ?? {}),
      ...(spec.port ? { PORT: String(spec.port.internalPort) } : {}),
    };
    if (Object.keys(variables).length > 0) {
      await upsertRailwayServiceVariables(
        token,
        projectId,
        environmentId,
        serviceId,
        variables,
        { skipDeploys: true },
        credentials.apiUrl,
      );
    }

    await updateRailwayServiceInstance(
      token,
      serviceId,
      environmentId,
      {
        source: { image: spec.image },
        ...(spec.healthcheckPath ? { healthcheckPath: spec.healthcheckPath } : {}),
      },
      credentials.apiUrl,
    );

    const deploymentId = await deployRailwayServiceInstance(
      token,
      serviceId,
      environmentId,
      {},
      credentials.apiUrl,
    );

    let url: string | undefined;
    if (spec.port?.publicHttps) {
      const domain = await ensureRailwayServiceDomain(
        token,
        serviceId,
        environmentId,
        spec.port.internalPort,
        credentials.apiUrl,
      );
      url = `https://${domain}`;
    }

    return {
      provider: 'railway',
      workloadId: serviceId,
      name: spec.name,
      url,
      memoryMb: spec.memoryMb,
      vcpus: spec.vcpus,
      projectId,
      environmentId,
      metadata: { deploymentId },
    };
  },
  suspendWorkload: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadHandle> => {
    const token = requireRailwayToken(credentials);
    const environmentId = requireEnvironmentId(credentials, handle);
    const instance = await fetchRailwayServiceInstance(
      token,
      handle.workloadId,
      environmentId,
      credentials.apiUrl,
    );
    const deploymentId = instance.latestDeployment?.id ?? handle.metadata?.deploymentId;
    if (deploymentId) {
      await stopRailwayDeployment(token, deploymentId, credentials.apiUrl);
    }
    return {
      ...handle,
      environmentId,
      metadata: deploymentId ? { ...handle.metadata, deploymentId } : handle.metadata,
    };
  },
  wakeWorkload: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadHandle> => {
    const token = requireRailwayToken(credentials);
    const environmentId = requireEnvironmentId(credentials, handle);
    const deploymentId = await deployRailwayServiceInstance(
      token,
      handle.workloadId,
      environmentId,
      {},
      credentials.apiUrl,
    );
    return {
      ...handle,
      environmentId,
      metadata: { ...handle.metadata, deploymentId },
    };
  },
  fetchWorkloadStatus: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadStatus> => {
    const token = requireRailwayToken(credentials);
    const environmentId = requireEnvironmentId(credentials, handle);
    const instance = await fetchRailwayServiceInstance(
      token,
      handle.workloadId,
      environmentId,
      credentials.apiUrl,
    );
    const providerState = instance.latestDeployment?.status ?? 'STOPPED';
    const domain = instance.domains[0];
    return {
      provider: 'railway',
      workloadId: handle.workloadId,
      state: mapRailwayDeploymentState(instance.latestDeployment?.status),
      providerState,
      region: handle.region,
      url: domain ? `https://${domain}` : handle.url,
      memoryMb: handle.memoryMb,
      vcpus: handle.vcpus,
      updatedAt: new Date().toISOString(),
    };
  },
  fetchWorkloadUsage: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadUsage> => {
    await railwayWorkloadDriver.fetchWorkloadStatus(credentials, handle);
    const nowIso = new Date().toISOString();
    return {
      provider: 'railway',
      workloadId: handle.workloadId,
      memoryMb: handle.memoryMb ?? 0,
      vcpus: handle.vcpus ?? 0,
      activeSeconds: 0,
      suspendedSeconds: 0,
      rootfsGb: 0,
      metered: false,
      windowStartIso: nowIso,
      windowEndIso: nowIso,
    };
  },
  destroyWorkload: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<void> => {
    const token = requireRailwayToken(credentials);
    await deleteRailwayService(token, handle.workloadId, credentials.apiUrl);
  },
};

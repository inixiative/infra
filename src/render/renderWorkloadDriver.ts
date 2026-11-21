import type {
  WorkloadCredentials,
  WorkloadDriver,
  WorkloadHandle,
  WorkloadRuntimeState,
  WorkloadSpec,
  WorkloadStatus,
  WorkloadUsage,
} from '../core/contracts.ts';
import { InfraError } from '../core/infraError.ts';
import { RENDER_REGION } from './renderArchiveDriver.ts';
import { deleteRenderResource, sendRenderRequest } from './renderRequest.ts';

type RenderWorkloadService = {
  id: string;
  name: string;
  suspended?: 'suspended' | 'not_suspended';
  serviceDetails?: {
    url?: string;
    region?: string;
    plan?: string;
  };
};

const FAILED_DEPLOY_STATUSES = new Set([
  'build_failed',
  'update_failed',
  'pre_deploy_failed',
  'canceled',
]);

const requireRenderToken = (credentials: WorkloadCredentials): string => {
  if (!credentials.token) {
    throw new InfraError('authentication_failed', 'Render API token is required', {
      provider: 'render',
    });
  }
  return credentials.token;
};

const renderPlanForMemoryMb = (memoryMb: number): string => {
  if (memoryMb <= 512) return 'starter';
  if (memoryMb <= 2048) return 'standard';
  if (memoryMb <= 4096) return 'pro';
  return 'pro_plus';
};

const mapRenderRuntimeState = (
  service: RenderWorkloadService,
  latestDeployStatus?: string,
): WorkloadRuntimeState => {
  if (service.suspended === 'suspended') return 'suspended';
  if (!latestDeployStatus) return 'running';
  if (latestDeployStatus === 'live') return 'running';
  if (FAILED_DEPLOY_STATUSES.has(latestDeployStatus)) return 'failed';
  if (latestDeployStatus === 'deactivated') return 'stopped';
  return 'starting';
};

export const renderWorkloadDriver: WorkloadDriver = {
  provider: 'render',
  provisionWorkload: async (
    credentials: WorkloadCredentials,
    spec: WorkloadSpec,
  ): Promise<WorkloadHandle> => {
    const token = requireRenderToken(credentials);
    if (!credentials.workspaceId) {
      throw new InfraError('invalid_request', 'Render workload provisioning requires workspaceId', {
        provider: 'render',
      });
    }

    const envVars = Object.entries({
      ...(spec.env ?? {}),
      ...(spec.port ? { PORT: String(spec.port.internalPort) } : {}),
    }).map(([key, value]) => ({ key, value }));

    const serviceType = spec.port?.publicHttps ? 'web_service' : 'background_worker';
    const region = spec.region ?? RENDER_REGION;
    const created = await sendRenderRequest<{ service: RenderWorkloadService; deployId?: string }>(
      token,
      '/services',
      {
        method: 'POST',
        body: {
          type: serviceType,
          name: spec.name,
          ownerId: credentials.workspaceId,
          image: {
            ownerId: credentials.workspaceId,
            imagePath: spec.image,
          },
          envVars,
          serviceDetails: {
            runtime: 'image',
            plan: renderPlanForMemoryMb(spec.memoryMb),
            region,
            ...(spec.healthcheckPath ? { healthCheckPath: spec.healthcheckPath } : {}),
            ...(spec.volume
              ? {
                  disk: {
                    name: spec.volume.name,
                    mountPath: spec.volume.mountPath,
                    sizeGB: spec.volume.sizeGb ?? 10,
                  },
                }
              : {}),
          },
        },
      },
      credentials.apiUrl,
    );

    return {
      provider: 'render',
      workloadId: created.service.id,
      name: created.service.name,
      region: created.service.serviceDetails?.region ?? region,
      url: created.service.serviceDetails?.url,
      memoryMb: spec.memoryMb,
      vcpus: spec.vcpus,
      metadata: created.deployId ? { deployId: created.deployId } : undefined,
    };
  },
  suspendWorkload: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadHandle> => {
    const token = requireRenderToken(credentials);
    await sendRenderRequest(
      token,
      `/services/${handle.workloadId}/suspend`,
      { method: 'POST' },
      credentials.apiUrl,
    );
    return handle;
  },
  wakeWorkload: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadHandle> => {
    const token = requireRenderToken(credentials);
    await sendRenderRequest(
      token,
      `/services/${handle.workloadId}/resume`,
      { method: 'POST' },
      credentials.apiUrl,
    );
    return handle;
  },
  fetchWorkloadStatus: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadStatus> => {
    const token = requireRenderToken(credentials);
    const service = await sendRenderRequest<RenderWorkloadService>(
      token,
      `/services/${handle.workloadId}`,
      {},
      credentials.apiUrl,
    );
    const deploys = await sendRenderRequest<{ deploy: { status: string } }[]>(
      token,
      `/services/${handle.workloadId}/deploys?limit=1`,
      {},
      credentials.apiUrl,
    );
    const latestDeployStatus = deploys[0]?.deploy.status;
    return {
      provider: 'render',
      workloadId: service.id,
      state: mapRenderRuntimeState(service, latestDeployStatus),
      providerState:
        service.suspended === 'suspended' ? 'suspended' : (latestDeployStatus ?? 'active'),
      region: service.serviceDetails?.region ?? handle.region,
      url: service.serviceDetails?.url ?? handle.url,
      memoryMb: handle.memoryMb,
      vcpus: handle.vcpus,
      updatedAt: new Date().toISOString(),
    };
  },
  fetchWorkloadUsage: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<WorkloadUsage> => {
    const status = await renderWorkloadDriver.fetchWorkloadStatus(credentials, handle);
    const nowIso = new Date().toISOString();
    return {
      provider: 'render',
      workloadId: handle.workloadId,
      memoryMb: handle.memoryMb ?? 0,
      vcpus: handle.vcpus ?? 0,
      activeSeconds: status.state === 'running' ? 60 : 0,
      suspendedSeconds: status.state === 'suspended' ? 60 : 0,
      rootfsGb: 0,
      windowStartIso: nowIso,
      windowEndIso: nowIso,
    };
  },
  destroyWorkload: async (
    credentials: WorkloadCredentials,
    handle: WorkloadHandle,
  ): Promise<void> => {
    const token = requireRenderToken(credentials);
    await deleteRenderResource(token, `/services/${handle.workloadId}`, credentials.apiUrl);
  },
};

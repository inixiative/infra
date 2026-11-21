import type { HostingWorkspace } from '../core/contracts.ts';
import { InfraError, isInfraError } from '../core/infraError.ts';
import { sendRailwayGraphql } from './railwayRequest.ts';

type RailwayEdges<T> = { readonly edges: ReadonlyArray<{ readonly node: T }> };
type RailwayPageInfo = { readonly hasNextPage: boolean; readonly endCursor: string | null };

export type RailwayNamedResource = { readonly id: string; readonly name: string };

export type RailwayProjectSummary = RailwayNamedResource & {
  readonly environments: readonly RailwayNamedResource[];
};

export type RailwayServiceInstanceInfo = {
  readonly latestDeployment: { readonly id?: string; readonly status: string } | null;
  readonly domains: readonly string[];
  readonly sourceRepo?: string | null;
};

export type RailwayServiceInstanceUpdateInput = {
  readonly source?: { readonly image?: string; readonly repo?: string };
  readonly healthcheckPath?: string;
  readonly rootDirectory?: string;
  readonly buildCommand?: string;
  readonly startCommand?: string;
  readonly sleepApplication?: boolean;
};

export type RailwayBucketCredentials = {
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly endpoint: string;
  readonly urlStyle: string;
};

const edgeNodes = <T>(connection: RailwayEdges<T> | null | undefined): T[] =>
  connection?.edges.map((edge) => edge.node) ?? [];

const requireRailwayValue = (value: string | undefined, label: string): string => {
  if (!value) {
    throw new InfraError('invalid_request', `Missing required Railway ${label}`, {
      provider: 'railway',
    });
  }
  return value;
};

export const fetchRailwayWorkspaces = async (
  token: string,
  apiUrl?: string,
): Promise<HostingWorkspace[]> => {
  const { apiToken } = await sendRailwayGraphql<{
    apiToken?: { workspaces?: HostingWorkspace[] | null } | null;
  }>(token, 'query { apiToken { workspaces { id name } } }', {}, apiUrl);
  if (!Array.isArray(apiToken?.workspaces)) {
    throw new InfraError('provider_unavailable', 'Railway apiToken response omitted workspaces', {
      provider: 'railway',
    });
  }
  return apiToken.workspaces.map(({ id, name }) => ({ id, name }));
};

type RailwayProjectNode = RailwayNamedResource & {
  readonly environments: RailwayEdges<RailwayNamedResource>;
};

export const fetchRailwayProjectByName = async (
  token: string,
  workspaceId: string,
  name: string,
  apiUrl?: string,
): Promise<RailwayProjectSummary | undefined> => {
  let after: string | null = null;
  do {
    const response: {
      projects: RailwayEdges<RailwayProjectNode> & { pageInfo: RailwayPageInfo };
    } = await sendRailwayGraphql<{
      projects: RailwayEdges<RailwayProjectNode> & { pageInfo: RailwayPageInfo };
    }>(
      token,
      'query($workspaceId: String, $after: String) { projects(workspaceId: $workspaceId, first: 100, after: $after) { edges { node { id name environments { edges { node { id name } } } } } pageInfo { hasNextPage endCursor } } }',
      { workspaceId, after },
      apiUrl,
    );
    const { projects } = response;
    const match = edgeNodes(projects).find((candidate) => candidate.name === name);
    if (match) {
      return {
        id: match.id,
        name: match.name,
        environments: edgeNodes(match.environments),
      };
    }
    after = projects.pageInfo.hasNextPage ? projects.pageInfo.endCursor : null;
  } while (after);
  return undefined;
};

export const createRailwayProject = async (
  token: string,
  workspaceId: string,
  name: string,
  defaultEnvironmentName = 'production',
  apiUrl?: string,
): Promise<RailwayProjectSummary> => {
  const { projectCreate } = await sendRailwayGraphql<{ projectCreate: RailwayProjectNode }>(
    token,
    'mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { id name environments { edges { node { id name } } } } }',
    { input: { name, workspaceId, defaultEnvironmentName } },
    apiUrl,
  );
  return {
    id: projectCreate.id,
    name: projectCreate.name,
    environments: edgeNodes(projectCreate.environments),
  };
};

export const ensureRailwayProject = async (
  token: string,
  workspaceId: string,
  name: string,
  existingIds?: { readonly projectId?: string; readonly environmentId?: string },
  apiUrl?: string,
): Promise<{ readonly projectId: string; readonly environmentId: string }> => {
  if (existingIds?.projectId && existingIds?.environmentId) {
    return { projectId: existingIds.projectId, environmentId: existingIds.environmentId };
  }
  const project =
    (await fetchRailwayProjectByName(token, workspaceId, name, apiUrl)) ??
    (await createRailwayProject(token, workspaceId, name, 'production', apiUrl));
  const environment =
    project.environments.find((candidate) => candidate.name === 'production') ??
    project.environments[0];
  return {
    projectId: project.id,
    environmentId: requireRailwayValue(environment?.id, 'environmentId'),
  };
};

export const fetchRailwayProjectEnvironments = async (
  token: string,
  projectId: string,
  apiUrl?: string,
): Promise<RailwayNamedResource[]> => {
  const { project } = await sendRailwayGraphql<{
    project: { environments: RailwayEdges<RailwayNamedResource> };
  }>(
    token,
    'query($id: String!) { project(id: $id) { environments { edges { node { id name } } } } }',
    { id: projectId },
    apiUrl,
  );
  return edgeNodes(project.environments);
};

export const renameRailwayEnvironment = async (
  token: string,
  environmentId: string,
  name: string,
  apiUrl?: string,
): Promise<boolean> => {
  const { environmentRename } = await sendRailwayGraphql<{ environmentRename: boolean }>(
    token,
    'mutation($id: String!, $name: String!) { environmentRename(id: $id, input: { name: $name }) }',
    { id: environmentId, name },
    apiUrl,
  );
  return environmentRename;
};

export const ensureRailwayService = async (
  token: string,
  projectId: string,
  environmentId: string,
  name: string,
  apiUrl?: string,
): Promise<string> => {
  const { project } = await sendRailwayGraphql<{
    project: { services: RailwayEdges<RailwayNamedResource> };
  }>(
    token,
    'query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }',
    { id: projectId },
    apiUrl,
  );
  const existing = edgeNodes(project.services).find((service) => service.name === name);
  if (existing) return existing.id;
  const { serviceCreate } = await sendRailwayGraphql<{ serviceCreate: { id: string } }>(
    token,
    'mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }',
    { input: { projectId, environmentId, name } },
    apiUrl,
  );
  return serviceCreate.id;
};

export const renameRailwayService = async (
  token: string,
  serviceId: string,
  name: string,
  apiUrl?: string,
): Promise<RailwayNamedResource> => {
  const { serviceUpdate } = await sendRailwayGraphql<{ serviceUpdate: RailwayNamedResource }>(
    token,
    'mutation($id: String!, $input: ServiceUpdateInput!) { serviceUpdate(id: $id, input: $input) { id name } }',
    { id: serviceId, input: { name } },
    apiUrl,
  );
  return serviceUpdate;
};

export const updateRailwayServiceInstance = async (
  token: string,
  serviceId: string,
  environmentId: string,
  input: RailwayServiceInstanceUpdateInput,
  apiUrl?: string,
): Promise<void> => {
  const { serviceInstanceUpdate } = await sendRailwayGraphql<{ serviceInstanceUpdate: boolean }>(
    token,
    'mutation($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }',
    { serviceId, environmentId, input },
    apiUrl,
  );
  if (serviceInstanceUpdate === false) {
    throw new InfraError(
      'provider_unavailable',
      `Failed to update Railway service instance ${serviceId}`,
      { provider: 'railway' },
    );
  }
};

export const fetchRailwayServiceConnectedToGitHub = async (
  token: string,
  serviceId: string,
  environmentId: string,
  apiUrl?: string,
): Promise<boolean> => {
  const { serviceInstance } = await sendRailwayGraphql<{
    serviceInstance: { id: string; source: { repo?: string | null } | null } | null;
  }>(
    token,
    'query($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { id source { repo } } }',
    { serviceId, environmentId },
    apiUrl,
  );
  return Boolean(serviceInstance?.source?.repo);
};

export const connectRailwayServiceToGitHub = async (
  token: string,
  serviceId: string,
  environmentId: string,
  repo: string,
  branch = 'main',
  apiUrl?: string,
): Promise<void> => {
  await updateRailwayServiceInstance(token, serviceId, environmentId, { source: { repo } }, apiUrl);

  const { service } = await sendRailwayGraphql<{ service: { projectId: string } }>(
    token,
    'query($id: String!) { service(id: $id) { projectId } }',
    { id: serviceId },
    apiUrl,
  );
  const projectId = service.projectId;

  const { deploymentTriggers } = await sendRailwayGraphql<{
    deploymentTriggers: RailwayEdges<{ id: string; branch: string; repository: string }>;
  }>(
    token,
    'query($projectId: String!, $serviceId: String!, $environmentId: String!) { deploymentTriggers(projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId) { edges { node { id branch repository } } } }',
    { projectId, serviceId, environmentId },
    apiUrl,
  );

  const hasTrigger = edgeNodes(deploymentTriggers).some(
    (trigger) => trigger.repository === repo && trigger.branch === branch,
  );
  if (!hasTrigger) {
    await sendRailwayGraphql<{ deploymentTriggerCreate: { id: string } }>(
      token,
      'mutation($input: DeploymentTriggerCreateInput!) { deploymentTriggerCreate(input: $input) { id } }',
      {
        input: {
          projectId,
          environmentId,
          serviceId,
          provider: 'github',
          repository: repo,
          branch,
          checkSuites: false,
        },
      },
      apiUrl,
    );
  }
};

export const fetchRailwayProjectVolumes = async (
  token: string,
  projectId: string,
  apiUrl?: string,
): Promise<RailwayNamedResource[]> => {
  const { project } = await sendRailwayGraphql<{
    project: { volumes: RailwayEdges<RailwayNamedResource> };
  }>(
    token,
    'query($id: String!) { project(id: $id) { volumes { edges { node { id name } } } } }',
    { id: projectId },
    apiUrl,
  );
  return edgeNodes(project.volumes);
};

export const ensureRailwayVolume = async (
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
  mountPath: string,
  apiUrl?: string,
): Promise<void> => {
  const { environment } = await sendRailwayGraphql<{
    environment: { volumeInstances: RailwayEdges<{ serviceId: string | null; mountPath: string }> };
  }>(
    token,
    'query($id: String!, $projectId: String) { environment(id: $id, projectId: $projectId) { volumeInstances { edges { node { serviceId mountPath } } } } }',
    { id: environmentId, projectId },
    apiUrl,
  );
  if (edgeNodes(environment.volumeInstances).some((volume) => volume.serviceId === serviceId)) {
    return;
  }
  await sendRailwayGraphql(
    token,
    'mutation($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }',
    { input: { projectId, environmentId, serviceId, mountPath } },
    apiUrl,
  );
};

export const renameRailwayVolume = async (
  token: string,
  volumeId: string,
  name: string,
  apiUrl?: string,
): Promise<RailwayNamedResource> => {
  const { volumeUpdate } = await sendRailwayGraphql<{ volumeUpdate: RailwayNamedResource }>(
    token,
    'mutation($volumeId: String!, $input: VolumeUpdateInput!) { volumeUpdate(volumeId: $volumeId, input: $input) { id name } }',
    { volumeId, input: { name } },
    apiUrl,
  );
  return volumeUpdate;
};

export const fetchRailwayServiceVariables = async (
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
  apiUrl?: string,
): Promise<Record<string, string>> => {
  const { variables } = await sendRailwayGraphql<{ variables: Record<string, string> }>(
    token,
    'query($projectId: String!, $environmentId: String!, $serviceId: String) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true) }',
    { projectId, environmentId, serviceId },
    apiUrl,
  );
  return variables;
};

export const upsertRailwayServiceVariables = async (
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
  variables: Readonly<Record<string, string>>,
  options: { readonly skipDeploys?: boolean } = {},
  apiUrl?: string,
): Promise<void> => {
  await sendRailwayGraphql(
    token,
    'mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }',
    {
      input: {
        projectId,
        environmentId,
        serviceId,
        variables,
        skipDeploys: options.skipDeploys ?? true,
      },
    },
    apiUrl,
  );
};

export const fetchRailwayServiceInstance = async (
  token: string,
  serviceId: string,
  environmentId: string,
  apiUrl?: string,
): Promise<RailwayServiceInstanceInfo> => {
  const { serviceInstance } = await sendRailwayGraphql<{
    serviceInstance: {
      latestDeployment: { id?: string; status: string } | null;
      domains: { serviceDomains: { domain: string }[] };
      source?: { repo?: string | null } | null;
    };
  }>(
    token,
    'query($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { latestDeployment { id status } domains { serviceDomains { domain } } source { repo } } }',
    { serviceId, environmentId },
    apiUrl,
  );
  return {
    latestDeployment: serviceInstance.latestDeployment,
    domains: serviceInstance.domains.serviceDomains.map((entry) => entry.domain),
    sourceRepo: serviceInstance.source?.repo,
  };
};

export const deployRailwayServiceInstance = async (
  token: string,
  serviceId: string,
  environmentId: string,
  apiUrl?: string,
): Promise<string> => {
  const { serviceInstanceDeployV2 } = await sendRailwayGraphql<{ serviceInstanceDeployV2: string }>(
    token,
    'mutation($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }',
    { serviceId, environmentId },
    apiUrl,
  );
  return requireRailwayValue(serviceInstanceDeployV2, 'deploymentId');
};

export const fetchRailwayDeploymentStatus = async (
  token: string,
  deploymentId: string,
  apiUrl?: string,
): Promise<string> => {
  const { deployment } = await sendRailwayGraphql<{ deployment: { status: string } }>(
    token,
    'query($id: String!) { deployment(id: $id) { status } }',
    { id: deploymentId },
    apiUrl,
  );
  return deployment.status;
};

export const stopRailwayDeployment = async (
  token: string,
  deploymentId: string,
  apiUrl?: string,
): Promise<boolean> => {
  const { deploymentStop } = await sendRailwayGraphql<{ deploymentStop: boolean }>(
    token,
    'mutation($id: String!) { deploymentStop(id: $id) }',
    { id: deploymentId },
    apiUrl,
  );
  return deploymentStop;
};

export const ensureRailwayServiceDomain = async (
  token: string,
  serviceId: string,
  environmentId: string,
  targetPort?: number,
  apiUrl?: string,
): Promise<string> => {
  const instance = await fetchRailwayServiceInstance(token, serviceId, environmentId, apiUrl);
  const existing = instance.domains[0];
  if (existing) return existing;

  const { serviceDomainCreate } = await sendRailwayGraphql<{
    serviceDomainCreate: { domain: string };
  }>(
    token,
    'mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }',
    {
      input: {
        serviceId,
        environmentId,
        ...(targetPort !== undefined ? { targetPort } : {}),
      },
    },
    apiUrl,
  );
  return serviceDomainCreate.domain;
};

export const fetchRailwayProjectBuckets = async (
  token: string,
  projectId: string,
  apiUrl?: string,
): Promise<RailwayNamedResource[]> => {
  const { project } = await sendRailwayGraphql<{
    project: { buckets?: RailwayNamedResource[] | null };
  }>(
    token,
    'query($id: String!) { project(id: $id) { buckets { id name } } }',
    { id: projectId },
    apiUrl,
  );
  return project.buckets ?? [];
};

export const createRailwayBucket = async (
  token: string,
  projectId: string,
  name: string,
  apiUrl?: string,
): Promise<RailwayNamedResource> => {
  const { bucketCreate } = await sendRailwayGraphql<{
    bucketCreate: { id: string; name: string };
  }>(
    token,
    'mutation($input: BucketCreateInput!) { bucketCreate(input: $input) { id name } }',
    { input: { projectId, name } },
    apiUrl,
  );
  return { id: bucketCreate.id, name: bucketCreate.name };
};

export const ensureRailwayBucket = async (
  token: string,
  projectId: string,
  name: string,
  apiUrl?: string,
): Promise<RailwayNamedResource> => {
  const existing = (await fetchRailwayProjectBuckets(token, projectId, apiUrl)).find(
    (bucket) => bucket.name === name,
  );
  if (existing) return existing;
  return createRailwayBucket(token, projectId, name, apiUrl);
};

export const fetchRailwayBucketCredentials = async (
  token: string,
  bucketId: string,
  environmentId: string,
  projectId: string,
  apiUrl?: string,
): Promise<RailwayBucketCredentials> => {
  const { bucketS3Credentials } = await sendRailwayGraphql<{
    bucketS3Credentials: {
      accessKeyId?: string;
      bucketName?: string;
      endpoint: string;
      region: string;
      secretAccessKey: string;
      urlStyle: string;
    } | null;
  }>(
    token,
    'query($bucketId: String!, $environmentId: String!, $projectId: String!) { bucketS3Credentials(bucketId: $bucketId, environmentId: $environmentId, projectId: $projectId) { accessKeyId bucketName endpoint region secretAccessKey urlStyle } }',
    { bucketId, environmentId, projectId },
    apiUrl,
  );
  if (!bucketS3Credentials?.bucketName || !bucketS3Credentials?.accessKeyId) {
    throw new InfraError('provider_unavailable', 'Railway bucket credentials are not ready yet', {
      provider: 'railway',
    });
  }
  return {
    bucket: bucketS3Credentials.bucketName,
    accessKeyId: bucketS3Credentials.accessKeyId,
    secretAccessKey: bucketS3Credentials.secretAccessKey,
    region: bucketS3Credentials.region,
    endpoint: bucketS3Credentials.endpoint,
    urlStyle: bucketS3Credentials.urlStyle,
  };
};

export const deleteRailwayService = async (
  token: string,
  serviceId: string,
  apiUrl?: string,
): Promise<void> => {
  await sendRailwayGraphql(
    token,
    'mutation($id: String!) { serviceDelete(id: $id) }',
    { id: serviceId },
    apiUrl,
  ).catch((error) => {
    if (!isInfraError(error, 'not_found')) throw error;
  });
};

export const scheduleRailwayProjectDelete = async (
  token: string,
  projectId: string,
  apiUrl?: string,
): Promise<void> => {
  await sendRailwayGraphql(
    token,
    'mutation($id: String!) { projectScheduleDelete(id: $id) }',
    { id: projectId },
    apiUrl,
  ).catch((error) => {
    if (!isInfraError(error, 'not_found')) throw error;
  });
};

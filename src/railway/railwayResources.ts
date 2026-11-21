import type { HostingWorkspace } from '../core/contracts.ts';
import { InfraError, ignoreNotFound, requireNonEmpty } from '../core/infraError.ts';
import { sendRailwayGraphql } from './railwayRequest.ts';

type RailwayEdges<T> = { readonly edges: ReadonlyArray<{ readonly node: T }> };
type RailwayPageInfo = { readonly hasNextPage?: boolean; readonly endCursor?: string | null };
type RailwayConnection<T> = RailwayEdges<T> & { readonly pageInfo?: RailwayPageInfo };

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

const requireEntity = <T>(entity: T | null | undefined, label: string): T => {
  if (entity === null || entity === undefined) {
    throw new InfraError('not_found', `Railway ${label} not found`, { provider: 'railway' });
  }
  return entity;
};

const paginateConnection = async <T>(
  fetchPage: (after: string | null) => Promise<RailwayConnection<T>>,
): Promise<T[]> => {
  const results: T[] = [];
  const seenCursors = new Set<string>();
  let after: string | null = null;
  do {
    const connection = await fetchPage(after);
    results.push(...edgeNodes(connection));
    const nextCursor = connection.pageInfo?.hasNextPage
      ? (connection.pageInfo.endCursor ?? null)
      : null;
    if (nextCursor !== null) {
      if (seenCursors.has(nextCursor)) {
        throw new InfraError('provider_unavailable', 'Railway pagination cursor repeated', {
          provider: 'railway',
        });
      }
      seenCursors.add(nextCursor);
    }
    after = nextCursor;
  } while (after !== null);
  return results;
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
  const seenCursors = new Set<string>();
  let after: string | null = null;
  do {
    const response: {
      projects: RailwayConnection<RailwayProjectNode>;
    } = await sendRailwayGraphql<{
      projects: RailwayConnection<RailwayProjectNode>;
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
    const nextCursor = projects.pageInfo?.hasNextPage
      ? (projects.pageInfo.endCursor ?? null)
      : null;
    if (nextCursor !== null) {
      if (seenCursors.has(nextCursor)) {
        throw new InfraError(
          'provider_unavailable',
          'Railway projects pagination cursor repeated',
          {
            provider: 'railway',
          },
        );
      }
      seenCursors.add(nextCursor);
    }
    after = nextCursor;
  } while (after !== null);
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

export const fetchRailwayProjectEnvironments = async (
  token: string,
  projectId: string,
  apiUrl?: string,
): Promise<RailwayNamedResource[]> =>
  paginateConnection(async (after) => {
    const { project } = await sendRailwayGraphql<{
      project: { environments: RailwayConnection<RailwayNamedResource> } | null;
    }>(
      token,
      'query($id: String!, $after: String) { project(id: $id) { environments(first: 100, after: $after) { edges { node { id name } } pageInfo { hasNextPage endCursor } } } }',
      { id: projectId, after },
      apiUrl,
    );
    return requireEntity(project, `project ${projectId}`).environments;
  });

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
  if (existingIds?.projectId) {
    const environments = await fetchRailwayProjectEnvironments(
      token,
      existingIds.projectId,
      apiUrl,
    );
    const environment =
      environments.find((candidate) => candidate.name === 'production') ?? environments[0];
    return {
      projectId: existingIds.projectId,
      environmentId: requireNonEmpty(environment?.id, 'Railway environmentId', 'railway'),
    };
  }
  const project =
    (await fetchRailwayProjectByName(token, workspaceId, name, apiUrl)) ??
    (await createRailwayProject(token, workspaceId, name, 'production', apiUrl));
  const environment =
    project.environments.find((candidate) => candidate.name === 'production') ??
    project.environments[0];
  return {
    projectId: project.id,
    environmentId: requireNonEmpty(environment?.id, 'Railway environmentId', 'railway'),
  };
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
  const services = await paginateConnection(async (after) => {
    const { project } = await sendRailwayGraphql<{
      project: { services: RailwayConnection<RailwayNamedResource> } | null;
    }>(
      token,
      'query($id: String!, $after: String) { project(id: $id) { services(first: 100, after: $after) { edges { node { id name } } pageInfo { hasNextPage endCursor } } } }',
      { id: projectId, after },
      apiUrl,
    );
    return requireEntity(project, `project ${projectId}`).services;
  });
  const existing = services.find((service) => service.name === name);
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

export const fetchRailwayServiceGitHubConnectionStatus = async (
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
  return Boolean(requireEntity(serviceInstance, `serviceInstance ${serviceId}`).source?.repo);
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

  const { service } = await sendRailwayGraphql<{ service: { projectId: string } | null }>(
    token,
    'query($id: String!) { service(id: $id) { projectId } }',
    { id: serviceId },
    apiUrl,
  );
  const projectId = requireEntity(service, `service ${serviceId}`).projectId;

  const triggers = await paginateConnection(async (after) => {
    const { deploymentTriggers } = await sendRailwayGraphql<{
      deploymentTriggers: RailwayConnection<{ id: string; branch: string; repository: string }>;
    }>(
      token,
      'query($projectId: String!, $serviceId: String!, $environmentId: String!, $after: String) { deploymentTriggers(projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId, first: 100, after: $after) { edges { node { id branch repository } } pageInfo { hasNextPage endCursor } } }',
      { projectId, serviceId, environmentId, after },
      apiUrl,
    );
    return deploymentTriggers;
  });

  const hasTrigger = triggers.some(
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
): Promise<RailwayNamedResource[]> =>
  paginateConnection(async (after) => {
    const { project } = await sendRailwayGraphql<{
      project: { volumes: RailwayConnection<RailwayNamedResource> } | null;
    }>(
      token,
      'query($id: String!, $after: String) { project(id: $id) { volumes(first: 100, after: $after) { edges { node { id name } } pageInfo { hasNextPage endCursor } } } }',
      { id: projectId, after },
      apiUrl,
    );
    return requireEntity(project, `project ${projectId}`).volumes;
  });

export const ensureRailwayVolume = async (
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
  mountPath: string,
  apiUrl?: string,
): Promise<void> => {
  const volumes = await paginateConnection(async (after) => {
    const { environment } = await sendRailwayGraphql<{
      environment: {
        volumeInstances: RailwayConnection<{ serviceId: string | null; mountPath: string }>;
      } | null;
    }>(
      token,
      'query($id: String!, $projectId: String, $after: String) { environment(id: $id, projectId: $projectId) { volumeInstances(first: 100, after: $after) { edges { node { serviceId mountPath } } pageInfo { hasNextPage endCursor } } } }',
      { id: environmentId, projectId, after },
      apiUrl,
    );
    return requireEntity(environment, `environment ${environmentId}`).volumeInstances;
  });
  if (volumes.some((volume) => volume.serviceId === serviceId && volume.mountPath === mountPath)) {
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
    } | null;
  }>(
    token,
    'query($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { latestDeployment { id status } domains { serviceDomains { domain } } source { repo } } }',
    { serviceId, environmentId },
    apiUrl,
  );
  const instance = requireEntity(serviceInstance, `serviceInstance ${serviceId}`);
  return {
    latestDeployment: instance.latestDeployment,
    domains: instance.domains.serviceDomains.map((entry) => entry.domain),
    sourceRepo: instance.source?.repo,
  };
};

export const deployRailwayServiceInstance = async (
  token: string,
  serviceId: string,
  environmentId: string,
  options: { readonly commitSha?: string } = {},
  apiUrl?: string,
): Promise<string> => {
  const query = options.commitSha
    ? 'mutation($serviceId: String!, $environmentId: String!, $commitSha: String) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }'
    : 'mutation($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }';
  const variables = options.commitSha
    ? { serviceId, environmentId, commitSha: options.commitSha }
    : { serviceId, environmentId };
  const { serviceInstanceDeployV2 } = await sendRailwayGraphql<{ serviceInstanceDeployV2: string }>(
    token,
    query,
    variables,
    apiUrl,
  );
  return requireNonEmpty(serviceInstanceDeployV2, 'Railway deploymentId', 'railway');
};

export const deployRailwayServiceLatestCommit = async (
  token: string,
  serviceId: string,
  environmentId: string,
  options: { readonly latestCommit?: boolean } = {},
  apiUrl?: string,
): Promise<void> => {
  const { serviceInstanceDeploy } = await sendRailwayGraphql<{ serviceInstanceDeploy: boolean }>(
    token,
    'mutation($serviceId: String!, $environmentId: String!, $latestCommit: Boolean!) { serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId, latestCommit: $latestCommit) }',
    { serviceId, environmentId, latestCommit: options.latestCommit ?? true },
    apiUrl,
  );
  if (!serviceInstanceDeploy) {
    throw new InfraError(
      'provider_unavailable',
      `Failed to deploy latest commit for Railway service ${serviceId}`,
      { provider: 'railway' },
    );
  }
};

export const fetchRailwayDeploymentStatus = async (
  token: string,
  deploymentId: string,
  apiUrl?: string,
): Promise<string> => {
  const { deployment } = await sendRailwayGraphql<{ deployment: { status: string } | null }>(
    token,
    'query($id: String!) { deployment(id: $id) { status } }',
    { id: deploymentId },
    apiUrl,
  );
  return requireEntity(deployment, `deployment ${deploymentId}`).status;
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
    project: { buckets?: RailwayNamedResource[] | null } | null;
  }>(
    token,
    'query($id: String!) { project(id: $id) { buckets { id name } } }',
    { id: projectId },
    apiUrl,
  );
  return requireEntity(project, `project ${projectId}`).buckets ?? [];
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
  ).catch(ignoreNotFound);
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
  ).catch(ignoreNotFound);
};

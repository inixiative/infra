# Verbs

Every operation `@inixiative/infra` performs has one verb, one public name per resource it acts on,
and one implementation. `tests/verbs.test.ts` enforces that every exported symbol across all six
entry points (`src/index.ts`, `src/railway/index.ts`, `src/render/index.ts`, `src/fly/index.ts`,
`src/firecracker/index.ts`, `src/lifecycle/index.ts`) is documented here, no stale symbols remain
in this file, and no public export uses the banned `get*` prefix (`R-2026-11-17-07`).

## Core transport, errors, and registries (`src/core/`, `src/drivers.ts`)

| Verb | Name | What it does |
| --- | --- | --- |
| send | `sendInfraRequest` | Sends a JSON HTTP (or Unix-socket) request with bearer auth, `redirect: 'error'`, redacted error excerpts, and timeout mapped to `InfraError`. |
| send | `sendUnixSocketHttpRequest` | Sends a JSON HTTP request over a local Unix domain socket using `node:http` for Node.js runtime compatibility. |
| normalize | `stripTrailingSlash` | Strips trailing slashes from a provider base API URL. |
| construct | `InfraError` | Typed infrastructure error carrying a snake_case `InfraErrorCode`, `retryable` flag, optional HTTP status, and provider id. |
| map | `infraErrorForStatus` | Maps an HTTP status code to the matching `InfraError` code and message. |
| narrow | `isInfraError` | Type guard checking whether an unknown error is an `InfraError` (optionally with a specific code). |
| assert | `requireNonEmpty` | Returns a non-empty string or throws `InfraError('invalid_request')`. |
| filter | `ignoreNotFound` | Swallows `InfraError('not_found')` and rethrows any other error. |
| assert | `assertNoEgressAllowlist` | Fails closed with `InfraError('invalid_request')` when a caller supplies an egress allowlist to a driver that does not enforce one. |
| narrow | `isInfraProvider` | Type guard checking whether a string is a known `InfraProviderId`. |
| narrow | `isImplementedInfraProvider` | Type guard checking whether a string is a provider with an implemented `WorkloadDriver`. |
| narrow | `isArchiveHostingProvider` | Type guard checking whether a string is a provider with an implemented `ArchiveHostingDriver`. |
| look up | `infraProviderDescriptor` | Returns the capability descriptor for an `InfraProviderId` from `INFRA_PROVIDERS`. |
| look up | `workloadDriverForProvider` | Returns the stateless `WorkloadDriver` for an `ImplementedInfraProvider`. |
| look up | `archiveHostingDriverForProvider` | Returns the stateless `ArchiveHostingDriver` for an `ArchiveHostingProvider`. |
| resolve | `archiveTokenOrThrow` | Returns the Archive server token from an `ArchiveDeployment`, throwing `InfraError('authentication_failed')` when absent. |

Constants and registries: `INFRA_REQUEST_TIMEOUT_MS`, `IMPLEMENTED_INFRA_PROVIDERS`,
`PLANNED_INFRA_PROVIDERS`, `ARCHIVE_HOSTING_PROVIDERS`, `INFRA_PROVIDERS`, `WORKLOAD_DRIVERS`,
`ARCHIVE_HOSTING_DRIVERS`, `ARCHIVE_IMAGE`, `ARCHIVE_PORT`, `ARCHIVE_DATABASE`.

## Railway (`src/railway/`)

| Verb | Name | What it does |
| --- | --- | --- |
| send | `sendRailwayGraphql` | Executes a Railway GraphQL query or mutation and translates GraphQL errors and extension codes into `InfraError`. |
| fetch | `fetchRailwayWorkspaces` | Lists the workspaces accessible to a Railway API token. |
| fetch | `fetchRailwayProjectByName` | Paginates a workspace's Railway projects to find one matching a name. |
| create | `createRailwayProject` | Creates a new Railway project in a workspace with a default environment. |
| ensure | `ensureRailwayProject` | Reuses existing IDs, looks up environments when only `projectId` is known, or adopts/creates a Railway project and its primary environment. |
| fetch | `fetchRailwayProjectEnvironments` | Paginates all environments belonging to a Railway project. |
| rename | `renameRailwayEnvironment` | Renames a Railway environment by ID. |
| ensure | `ensureRailwayService` | Paginates a project's services to find a named service or creates it in the target environment. |
| rename | `renameRailwayService` | Renames a Railway service by ID. |
| update | `updateRailwayServiceInstance` | Updates a Railway service instance's source, healthcheck, root directory, or commands. |
| fetch | `fetchRailwayServiceGitHubConnectionStatus` | Checks whether a Railway service instance has a connected GitHub repository source. |
| connect | `connectRailwayServiceToGitHub` | Links a Railway service instance to a GitHub repo and ensures an auto-deploy trigger for the branch. |
| fetch | `fetchRailwayProjectVolumes` | Paginates all volumes belonging to a Railway project. |
| ensure | `ensureRailwayVolume` | Ensures a Railway service has a volume mounted at a specific `mountPath` in the target environment. |
| rename | `renameRailwayVolume` | Renames a Railway volume by ID. |
| fetch | `fetchRailwayServiceVariables` | Fetches unrendered environment variables for a Railway service instance. |
| upsert | `upsertRailwayServiceVariables` | Upserts environment variables on a Railway service instance. |
| fetch | `fetchRailwayServiceInstance` | Fetches latest deployment status, domains, and source repo for a Railway service instance. |
| deploy | `deployRailwayServiceInstance` | Triggers a `serviceInstanceDeployV2` deployment (optionally pinned to a `commitSha`) and returns the new deployment ID. |
| deploy | `deployRailwayServiceLatestCommit` | Triggers a `serviceInstanceDeploy` mutation to deploy the latest commit of a connected repository. |
| fetch | `fetchRailwayDeploymentStatus` | Fetches the current status string of a Railway deployment by ID. |
| stop | `stopRailwayDeployment` | Stops a running Railway deployment by ID. |
| ensure | `ensureRailwayServiceDomain` | Reuses an existing Railway service domain or creates one targeting the optional port. |
| fetch | `fetchRailwayProjectBuckets` | Lists S3-compatible buckets attached to a Railway project. |
| create | `createRailwayBucket` | Creates an S3-compatible bucket in a Railway project. |
| ensure | `ensureRailwayBucket` | Finds an existing named Railway bucket in a project or creates one. |
| fetch | `fetchRailwayBucketCredentials` | Fetches S3 access credentials and endpoint for a Railway bucket in an environment. |
| delete | `deleteRailwayService` | Deletes a Railway service by ID, ignoring `not_found`. |
| schedule | `scheduleRailwayProjectDelete` | Schedules a Railway project for deletion by ID, ignoring `not_found`. |

Drivers and constants: `RAILWAY_API_URL`, `RAILWAY_DATABASE_SERVICE`, `RAILWAY_ARCHIVE_SERVICE`,
`railwayArchiveDriver`, `railwayWorkloadDriver`.

## Render (`src/render/`)

| Verb | Name | What it does |
| --- | --- | --- |
| send | `sendRenderRequest` | Sends a Render REST API request with bearer authentication. |
| delete | `deleteRenderResource` | Deletes a Render REST resource, ignoring `not_found`. |
| fetch | `fetchRenderOwners` | Paginates all Render owners (workspaces) accessible to an API token with repeated-cursor loop protection. |
| look up | `renderPlanForMemoryMb` | Maps a requested memory size in MB to the smallest Render service plan tier (`starter` through `pro_ultra`). |

Drivers and constants: `RENDER_API_URL`, `RENDER_REGION`, `RENDER_DATABASE_PLAN`,
`RENDER_SERVICE_PLAN`, `RENDER_PLAN_TIERS`, `RENDER_FAILED_DEPLOY_STATUSES`,
`RENDER_ENDED_DEPLOY_STATUSES`, `renderArchiveDriver`, `renderWorkloadDriver`.

## Fly.io Machines (`src/fly/`)

| Verb | Name | What it does |
| --- | --- | --- |
| send | `sendFlyRequest` | Sends a Fly.io Machines REST API request with bearer authentication. |

Drivers and constants: `FLY_MACHINES_API_URL`, `FLY_SUSPEND_MAX_MEMORY_MB`, `flyWorkloadDriver`.

## Firecracker (`src/firecracker/`)

| Verb | Name | What it does |
| --- | --- | --- |
| send | `sendFirecrackerRequest` | Sends a Firecracker VMM control-plane request over Unix domain socket or HTTP URL. |

Drivers and constants: `FIRECRACKER_DEFAULT_BASE_URL`, `firecrackerWorkloadDriver`.

## Workload lifecycle, staggered wakes, and cost projection (`src/lifecycle/`)

| Verb | Name | What it does |
| --- | --- | --- |
| look up | `defaultWorkloadLifecyclePolicy` | Returns the default lifecycle and wind-down policy for a generic `WorkloadClass` (`warm-interactive`, `warm-pool`, `batch-worker`, `ephemeral-session`, `always-on`). |
| evaluate | `evaluateWorkloadLifecycle` | Deterministically decides the next lifecycle action (`none`, `prewarm`, `drain`, `suspend`, `terminate`, `recycle`) from a workload snapshot, timestamp, and policy. |
| plan | `planStaggeredWakes` | Deduplicates and partitions concurrent wake requests into immediate launches and monotonically spaced/deferred launches to prevent thundering herds. |
| project | `projectHostingMonthlyCost` | Projects raw provider COGS and marked-up monthly hosting price from active/suspended hours, memory, vCPUs, and rootfs size. |

Constants: `WORKLOAD_LIFECYCLE_STATES`, `WORKLOAD_CLASSES`, `HOSTING_PRICING_RATES`.

## Exported Types

`InfraErrorCode`, `InfraErrorDetails`, `InfraFetchOptions`, `ImplementedInfraProvider`,
`PlannedInfraProvider`, `ArchiveHostingProvider`, `InfraProviderId`, `InfraIsolationKind`,
`InfraBillingUnit`, `InfraProviderDescriptor`, `WorkloadCpuKind`, `WorkloadVolumeSpec`,
`WorkloadPortSpec`, `WorkloadNetworkInterfaceSpec`, `WorkloadCredentials`, `WorkloadSpec`,
`WorkloadHandle`, `WorkloadRuntimeState`, `WorkloadStatus`, `WorkloadUsage`, `WorkloadDriver`,
`ArchiveDeploymentIds`, `ArchiveDeployment`, `HostingWorkspace`, `ImageDeployStatus`,
`ArchiveHostingDriver`, `RailwayNamedResource`, `RailwayProjectSummary`,
`RailwayServiceInstanceInfo`, `RailwayServiceInstanceUpdateInput`, `RailwayBucketCredentials`,
`RenderPlanId`, `RenderPlanTier`, `RenderRequestInit`, `FlyRequestInit`, `FirecrackerTransport`,
`FirecrackerRequestInit`, `WorkloadLifecycleState`, `WorkloadClass`, `WarmRetentionMode`,
`WorkingHoursSchedule`, `WorkloadIdleAction`, `WorkloadLifecyclePolicy`,
`WorkloadLifecyclePolicyOptions`, `WorkloadLifecycleSnapshot`, `WorkloadLifecycleAction`,
`WorkloadLifecycleDecision`, `StaggeredWakeRequest`, `StaggeredWakeOptions`, `DeferredWakeReason`,
`DeferredWake`, `StaggeredWakePlan`, `HostingCostProjectionInput`, `HostingCostProjection`.

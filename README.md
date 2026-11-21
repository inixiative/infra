# `@inixiative/infra`

Standalone MIT infrastructure and hosting drivers plus workload lifecycle, wind-down, staggered wake, and monthly cost projection — zero runtime dependencies, pure TypeScript over standard Web `fetch` APIs.

## What lives here

- **Core contracts (`src/core/`)**: `sendInfraRequest`, `InfraError` / `infraErrorForStatus`, `INFRA_PROVIDERS` capability registry (`railway`, `render`, `fly`, `firecracker`, plus planned descriptors for `aws`, `gcp`, `azure`), `WorkloadDriver`, and `ArchiveHostingDriver`.
- **Railway (`src/railway/`)**: `sendRailwayGraphql`, shared project/service/volume/domain/GitHub/bucket GraphQL helpers (used by both Kingdom and `template/init`), `railwayArchiveDriver`, and `railwayWorkloadDriver`.
- **Render (`src/render/`)**: `sendRenderRequest`, `fetchRenderOwners`, `renderArchiveDriver`, and `renderWorkloadDriver`.
- **Fly.io Machines (`src/fly/`)**: `sendFlyRequest` and `flyWorkloadDriver` (Firecracker microVMs with explicit `<= 2048 MB` suspend cap enforcement, start+wait wake, and event-timeline usage calculation).
- **Firecracker (`src/firecracker/`)**: `sendFirecrackerRequest` and `firecrackerWorkloadDriver` over Unix domain socket or HTTP control plane (boot config, full snapshot create/load, pause/resume, Ctrl+Alt+Del destroy).
- **Lifecycle engine (`src/lifecycle/`)**: deterministic zero-I/O state evaluation (`defaultWorkloadLifecyclePolicy`, `evaluateWorkloadLifecycle`), thundering-herd prevention (`planStaggeredWakes`), and raw COGS + managed-markup projection (`projectHostingMonthlyCost`).

## Naming & vocabulary

Every exported symbol is cataloged in [docs/VERBS.md](docs/VERBS.md) and enforced by `tests/verbs.test.ts`.
- `fetch*` for I/O reads; noun phrases for pure in-memory lookups (no `get*`).
- `send*` for low-level HTTP/GraphQL/socket calls.
- Error codes are `snake_case`; functions and methods are `camelCase`.

## Development

```bash
bun run typecheck
bun run lint
bun test
```

# `@inixiative/infra`

Standalone MIT infrastructure and hosting drivers plus workload lifecycle, wind-down, staggered wake, and monthly cost projection — zero runtime dependencies, pure TypeScript over standard Web `fetch` and `node:http` APIs.

## What lives here

- **Core contracts (`src/core/`)**: `sendInfraRequest` (with `redirect: 'error'`, redacted error excerpts, and `node:http` Unix-socket fallback), `InfraError` (`retryable` + `unreachable`), `INFRA_PROVIDERS` capability registry (`railway`, `render`, `fly`, `firecracker`, plus planned descriptors for `aws`, `gcp`, `azure`), `WorkloadDriver`, and `ArchiveHostingDriver`.
- **Railway (`src/railway/`)**: `sendRailwayGraphql`, paginated project/service/volume/domain/GitHub/bucket/deploy GraphQL helpers, `railwayArchiveDriver`, and `railwayWorkloadDriver`.
- **Render (`src/render/`)**: `sendRenderRequest`, `fetchRenderOwners`, shared plan-tier table (`starter` through `pro_ultra`), `renderArchiveDriver`, and `renderWorkloadDriver`.
- **Fly.io Machines (`src/fly/`)**: `sendFlyRequest` and `flyWorkloadDriver` (Firecracker microVMs with explicit `<= 2048 MB` suspend cap enforcement, suspend/wake wait polling, HTTP health checks, and reconciled event-timeline usage).
- **Firecracker (`src/firecracker/`)**: `sendFirecrackerRequest` and `firecrackerWorkloadDriver` over Unix domain socket or HTTP control plane (boot config, `track_dirty_pages` snapshot create/load, pause/resume, state-checked destroy).
- **Lifecycle engine (`src/lifecycle/`)**: deterministic zero-I/O state evaluation for generic profiles (`warm-interactive`, `warm-pool`, `batch-worker`, `ephemeral-session`, `always-on`), thundering-herd prevention (`planStaggeredWakes`), and raw COGS + managed-markup projection (`projectHostingMonthlyCost`).

## Naming & vocabulary

Every exported symbol across all six entry points is cataloged in [docs/VERBS.md](docs/VERBS.md) and enforced by `tests/verbs.test.ts`.
- `fetch*` for I/O reads; noun phrases for pure in-memory lookups (no `get*`).
- `send*` for low-level HTTP/GraphQL/socket calls.
- Error codes are `snake_case`; functions and methods are `camelCase`.

## Development

```bash
bun run typecheck
bun run lint
bun test
bun run build
```

export type RenderPlanId = 'starter' | 'standard' | 'pro' | 'pro_plus' | 'pro_max' | 'pro_ultra';

export type RenderPlanTier = {
  readonly id: RenderPlanId;
  readonly maxMemoryMb: number;
  readonly monthlyUsd: number;
};

export const RENDER_PLAN_TIERS: readonly RenderPlanTier[] = [
  { id: 'starter', maxMemoryMb: 512, monthlyUsd: 7 },
  { id: 'standard', maxMemoryMb: 2048, monthlyUsd: 25 },
  { id: 'pro', maxMemoryMb: 4096, monthlyUsd: 85 },
  { id: 'pro_plus', maxMemoryMb: 8192, monthlyUsd: 175 },
  { id: 'pro_max', maxMemoryMb: 16_384, monthlyUsd: 225 },
  { id: 'pro_ultra', maxMemoryMb: 32_768, monthlyUsd: 450 },
];

export const renderPlanForMemoryMb = (memoryMb: number): RenderPlanTier => {
  for (const tier of RENDER_PLAN_TIERS) {
    if (memoryMb <= tier.maxMemoryMb) return tier;
  }
  return RENDER_PLAN_TIERS[RENDER_PLAN_TIERS.length - 1];
};

export const RENDER_FAILED_DEPLOY_STATUSES: ReadonlySet<string> = new Set([
  'build_failed',
  'update_failed',
  'pre_deploy_failed',
  'canceled',
]);

export const RENDER_ENDED_DEPLOY_STATUSES: ReadonlySet<string> = new Set([
  ...RENDER_FAILED_DEPLOY_STATUSES,
  'deactivated',
]);

export type InfraErrorCode =
  | 'authentication_failed'
  | 'rate_limited'
  | 'not_found'
  | 'conflict'
  | 'provider_unavailable'
  | 'unreachable'
  | 'invalid_request'
  | 'deploy_failed';

export type InfraErrorDetails = {
  readonly status?: number;
  readonly provider?: string;
  readonly cause?: unknown;
  readonly retryable?: boolean;
};

const RETRYABLE_INFRA_ERROR_CODES: ReadonlySet<InfraErrorCode> = new Set([
  'unreachable',
  'rate_limited',
  'provider_unavailable',
]);

export class InfraError extends Error {
  readonly code: InfraErrorCode;
  readonly status?: number;
  readonly provider?: string;
  readonly retryable: boolean;

  constructor(code: InfraErrorCode, message?: string, details?: InfraErrorDetails) {
    const prefix = details?.provider ? `[${details.provider}] ` : '';
    super(message ? `${prefix}${message}` : `${prefix}Infrastructure request failed (${code})`, {
      cause: details?.cause,
    });
    this.name = 'InfraError';
    this.code = code;
    this.status = details?.status;
    this.provider = details?.provider;
    this.retryable = details?.retryable ?? RETRYABLE_INFRA_ERROR_CODES.has(code);
  }
}

export const infraErrorForStatus = (
  status: number,
  details?: { readonly provider?: string; readonly message?: string },
): InfraError => {
  const code: InfraErrorCode =
    status === 401 || status === 403
      ? 'authentication_failed'
      : status === 404
        ? 'not_found'
        : status === 409
          ? 'conflict'
          : status === 429
            ? 'rate_limited'
            : status === 400 || status === 422
              ? 'invalid_request'
              : 'provider_unavailable';
  const message = details?.message
    ? `HTTP ${status}: ${details.message}`
    : `HTTP ${status} (${code})`;
  return new InfraError(code, message, { status, provider: details?.provider });
};

export const isInfraError = (error: unknown, code?: InfraErrorCode): error is InfraError =>
  error instanceof InfraError && (code === undefined || error.code === code);

export const requireNonEmpty = (
  value: string | undefined,
  label: string,
  provider?: string,
): string => {
  if (!value?.trim()) {
    throw new InfraError('invalid_request', `Missing required ${label}`, { provider });
  }
  return value;
};

export const ignoreNotFound = (error: unknown): void => {
  if (!isInfraError(error, 'not_found')) throw error;
};

export const assertNoEgressAllowlist = (
  egressAllowlist: readonly string[] | undefined,
  provider: string,
): void => {
  if (egressAllowlist && egressAllowlist.length > 0) {
    throw new InfraError('invalid_request', 'Egress allowlist is not enforced by this driver', {
      provider,
    });
  }
};

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

const INFRA_ERROR_BRAND = Symbol.for('@inixiative/infra/InfraError');

const INFRA_ERROR_CODE_MAP: Record<InfraErrorCode, true> = {
  authentication_failed: true,
  rate_limited: true,
  not_found: true,
  conflict: true,
  provider_unavailable: true,
  unreachable: true,
  invalid_request: true,
  deploy_failed: true,
};

const INFRA_ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(INFRA_ERROR_CODE_MAP));

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
    // Non-enumerable global symbol brand so isInfraError works across subpath bundles and realms.
    Object.defineProperty(this, INFRA_ERROR_BRAND, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
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

const hasInfraErrorBrand = (error: unknown): error is InfraError => {
  if (!(error instanceof Error)) return false;
  const record = error as unknown as Record<PropertyKey, unknown>;
  return (
    record[INFRA_ERROR_BRAND] === true &&
    typeof record.code === 'string' &&
    INFRA_ERROR_CODES.has(record.code) &&
    typeof record.retryable === 'boolean' &&
    (record.status === undefined || typeof record.status === 'number') &&
    (record.provider === undefined || typeof record.provider === 'string')
  );
};

export const isInfraError = (error: unknown, code?: InfraErrorCode): error is InfraError => {
  if (!(error instanceof InfraError || hasInfraErrorBrand(error))) return false;
  return code === undefined || error.code === code;
};

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

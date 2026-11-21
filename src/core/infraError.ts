export type InfraErrorCode =
  | 'authentication_failed'
  | 'rate_limited'
  | 'not_found'
  | 'conflict'
  | 'provider_unavailable'
  | 'invalid_request'
  | 'deploy_failed';

export type InfraErrorDetails = {
  readonly status?: number;
  readonly provider?: string;
  readonly cause?: unknown;
};

export class InfraError extends Error {
  readonly code: InfraErrorCode;
  readonly status?: number;
  readonly provider?: string;

  constructor(code: InfraErrorCode, message?: string, details?: InfraErrorDetails) {
    const prefix = details?.provider ? `[${details.provider}] ` : '';
    super(message ? `${prefix}${message}` : `${prefix}Infrastructure request failed (${code})`, {
      cause: details?.cause,
    });
    this.name = 'InfraError';
    this.code = code;
    this.status = details?.status;
    this.provider = details?.provider;
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

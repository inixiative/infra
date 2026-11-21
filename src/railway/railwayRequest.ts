import { InfraError, type InfraErrorCode } from '../core/infraError.ts';
import { sendInfraRequest, stripTrailingSlash } from '../core/infraFetch.ts';

export const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';

type RailwayGraphqlErrorEntry = {
  readonly message?: unknown;
  readonly extensions?: { readonly code?: unknown };
};

const railwayErrorCodeForExtensions = (code: unknown): InfraErrorCode | undefined => {
  if (typeof code !== 'string') return undefined;
  switch (code.toUpperCase()) {
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
    case 'UNAUTHORIZED':
      return 'authentication_failed';
    case 'NOT_FOUND':
      return 'not_found';
    case 'CONFLICT':
      return 'conflict';
    case 'TOO_MANY_REQUESTS':
    case 'RATE_LIMITED':
      return 'rate_limited';
    case 'BAD_USER_INPUT':
    case 'GRAPHQL_VALIDATION_FAILED':
      return 'invalid_request';
    default:
      return undefined;
  }
};

const railwayErrorCodeForMessage = (message: string): InfraErrorCode => {
  const lower = message.toLowerCase();
  if (lower.includes('not authorized') || lower.includes('unauthorized')) {
    return 'authentication_failed';
  }
  if (lower.includes('rate limit') || lower.includes('too quickly')) {
    return 'rate_limited';
  }
  if (lower.includes('not found')) {
    return 'not_found';
  }
  if (lower.includes('already exists') || lower.includes('conflict')) {
    return 'conflict';
  }
  if (lower.includes('bad user input') || lower.includes('invalid')) {
    return 'invalid_request';
  }
  return 'provider_unavailable';
};

export const sendRailwayGraphql = async <T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
  apiUrl = RAILWAY_API_URL,
): Promise<T> => {
  const result = (await sendInfraRequest<{
    data?: unknown;
    errors?: RailwayGraphqlErrorEntry[];
  }>(stripTrailingSlash(apiUrl), {
    method: 'POST',
    token,
    body: { query, variables },
    provider: 'railway',
  })) as { data?: unknown; errors?: RailwayGraphqlErrorEntry[] } | undefined;

  if (Array.isArray(result?.errors) && result.errors.length > 0) {
    const messages = result.errors
      .map((entry) => (typeof entry?.message === 'string' ? entry.message.trim() : ''))
      .filter((message) => message.length > 0);
    const joinedMessage = messages.length > 0 ? messages.join('; ') : 'Railway GraphQL error';
    const codeFromExtensions = result.errors
      .map((entry) => railwayErrorCodeForExtensions(entry?.extensions?.code))
      .find((code): code is InfraErrorCode => code !== undefined);
    // Prioritize message match for auth/throttle when Railway uses generic BAD_USER_INPUT on throttles.
    const messageCode = railwayErrorCodeForMessage(joinedMessage);
    const code =
      messageCode === 'rate_limited' || messageCode === 'authentication_failed'
        ? messageCode
        : (codeFromExtensions ?? messageCode);

    throw new InfraError(code, joinedMessage, {
      provider: 'railway',
    });
  }

  if (!result?.data || typeof result.data !== 'object') {
    throw new InfraError('provider_unavailable', 'Railway GraphQL response omitted data', {
      provider: 'railway',
    });
  }

  return result.data as T;
};

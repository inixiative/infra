import { InfraError, type InfraErrorCode } from '../core/infraError.ts';
import { sendInfraRequest } from '../core/infraFetch.ts';

export const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';

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
    errors?: Array<{ message?: unknown }>;
  }>(apiUrl, {
    method: 'POST',
    token,
    body: { query, variables },
    provider: 'railway',
  })) as { data?: unknown; errors?: Array<{ message?: unknown }> } | undefined;

  if (Array.isArray(result?.errors) && result.errors.length > 0) {
    const firstMessage =
      typeof result.errors[0]?.message === 'string'
        ? result.errors[0].message
        : 'Railway GraphQL error';
    throw new InfraError(railwayErrorCodeForMessage(firstMessage), firstMessage, {
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

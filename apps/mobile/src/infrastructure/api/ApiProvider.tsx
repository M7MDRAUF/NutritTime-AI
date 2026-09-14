/**
 * The API client, injected (T-13-01).
 *
 * **A screen cannot be handed a client as a prop.** `screenFor` passes exactly `route` and
 * `navigation` — that is the registry's contract with the navigator — so a context is the only
 * route in. Made explicit here rather than by having each screen call `createApiClient()` itself,
 * which would give every screen its own client, its own `baseUrl` decision, and no way for a test
 * to supply a `fetch` without touching a global.
 *
 * Same shape and same reasoning as `ThemeProvider`: the value is a PROP of the provider, so a test
 * renders a screen against a stub client by wrapping it, and production passes nothing and gets the
 * default. No module-level singleton, because a singleton is a global read wearing a different hat.
 *
 * There is deliberately no default context value. `undefined` plus a guard, rather than a
 * lazily-created real client: a screen rendered outside the provider would otherwise start making
 * requests to `DEFAULT_API_BASE_URL` and fail in a way that looks like a network problem, when the
 * actual fault is a missing provider three levels up.
 */

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createApiClient } from './client.js';
import type { ApiClient, ApiClientConfig } from './client.js';

const ApiContext = createContext<ApiClient | undefined>(undefined);

export interface ApiProviderProps {
  /** Injected for tests. Production passes nothing and gets a client built from `config`. */
  readonly client?: ApiClient;
  /** Ignored when `client` is given. */
  readonly config?: ApiClientConfig;
  readonly children: ReactNode;
}

export function ApiProvider({ client, config, children }: ApiProviderProps): ReactNode {
  // Memoised on the two inputs, because a fresh client every render would give every screen's
  // effect a new dependency and re-request on each paint.
  const value = useMemo<ApiClient>(() => client ?? createApiClient(config ?? {}), [client, config]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiContext);
  if (client === undefined) {
    throw new Error('useApiClient was called outside an ApiProvider');
  }
  return client;
}

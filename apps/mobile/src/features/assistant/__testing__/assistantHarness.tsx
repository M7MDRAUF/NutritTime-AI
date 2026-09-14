/**
 * The render harness and the doubles both Assistant dom suites share.
 *
 * Extracted because there are two of them — `Assistant.dom.test.tsx` for what the user sees and
 * `AssistantRequest.dom.test.tsx` for what leaves the device — and SQG-09's 350 lines would not
 * hold one file with both. One harness rather than two copies, for the reason `__fixtures__/`
 * exists elsewhere in this app: two copies drift, and the copy that drifts is the one making a
 * failure-injection test pass.
 *
 * **The client is a stub whose promises the caller settles by hand.** Most of what matters on this
 * screen is a transition — the pending state has to be observable *before* the answer arrives, and
 * a rejection has to be delivered on demand — and real timing produces neither reliably.
 *
 * **This file is test-only.** It pulls in `react-dom`, which has no business in a React Native
 * bundle, and it lives under `__testing__/` rather than `__tests__/` so the Vitest include globs
 * never collect it as a suite (TSD §8.1 mandates co-located tests, not a test directory).
 */

import { act } from 'react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { API_ERROR_STATUS } from '@nutritime/contracts';
import type { ApiErrorCode, ChatResponse, Citation } from '@nutritime/contracts';
import { ThemeProvider } from '../../../shared/theme/ThemeProvider.js';
import { ApiProvider } from '../../../infrastructure/api/ApiProvider.js';
import { StorageProvider } from '../../../state/StorageProvider.js';
import { preferencesActions, preferencesStore } from '../../../state/preferences/index.js';
import type { PreferencesAction } from '../../../state/preferences/index.js';
import { memoryDriver } from '../../../infrastructure/storage/__fixtures__/memoryDriver.js';
import type { MemoryDriver } from '../../../infrastructure/storage/__fixtures__/memoryDriver.js';
import { ApiClientError } from '../../../infrastructure/api/errors.js';
import type { ApiClient } from '../../../infrastructure/api/client.js';
import type { ChatRequest } from '../../../infrastructure/api/routes.js';
import { AssistantScreen } from '../AssistantScreen.js';

export const QUESTION = 'Which of these is quickest?';

/** The answer text, used as a needle by both suites. */
export const ANSWER_TEXT = 'The yogurt bowl takes the least time.';

/** PRD §7.3's sentence, as `chatCopy.ts` sends it on the `answered: false` path. */
export const NO_INFORMATION_TEXT = 'I do not have that information.';

export function answer(citations: readonly Citation[] = []): ChatResponse {
  return { answered: true, answer: ANSWER_TEXT, citations, source: 'gemma' };
}

/** What the route returns for `answered: false`: 200, `source: 'local'`, and no citations. */
export function noInformation(): ChatResponse {
  return { answered: false, answer: NO_INFORMATION_TEXT, citations: [], source: 'local' };
}

/**
 * A server error as the API client delivers it — with a wire message written for whoever operates
 * the network. **Nothing may render it** (PRD §12), which is what one suite below asserts.
 */
export function serverError(code: ApiErrorCode): ApiClientError {
  return new ApiClientError({
    kind: 'server',
    status: API_ERROR_STATUS[code],
    code,
    retryable: true,
    wire: { code, message: 'ECONNREFUSED /var/run/private.sock', retryable: true },
    route: 'ask',
  });
}

export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

export interface DeferredClient {
  readonly client: ApiClient;
  readonly requests: ChatRequest[];
  settle(index: number, response: ChatResponse): Promise<void>;
  fail(index: number, error: unknown): Promise<void>;
}

/** A client whose every `ask` is a promise the caller completes when it chooses. */
export function deferredClient(): DeferredClient {
  const requests: ChatRequest[] = [];
  const resolvers: {
    resolve: (value: ChatResponse) => void;
    reject: (error: unknown) => void;
  }[] = [];

  const client: ApiClient = {
    listMeals: () => Promise.reject(new Error('not used')),
    getMeal: () => Promise.reject(new Error('not used')),
    recommend: () => Promise.reject(new Error('not used')),
    ask: (request) => {
      requests.push(request);
      return new Promise<ChatResponse>((resolve, reject) => {
        resolvers.push({ resolve, reject });
      });
    },
  };

  return {
    client,
    requests,
    settle: async (index, response) => {
      resolvers[index]?.resolve(response);
      await flush();
    },
    fail: async (index, error) => {
      resolvers[index]?.reject(error);
      await flush();
    },
  };
}

export interface Harness {
  readonly host: HTMLElement;
  readonly navigate: ReturnType<typeof vi.fn>;
  readonly driver: MemoryDriver;
  find(testID: string): HTMLElement | null;
  must(testID: string): HTMLElement;
  text(): string;
  input(): HTMLElement;
  type(value: string): Promise<void>;
  press(target: HTMLElement): Promise<void>;
  ask(): Promise<void>;
  /**
   * Flip the user's own AI switch through the **real** reducer, after mount.
   *
   * A dispatch rather than a seeded storage envelope, and after mount rather than before, because
   * that is the stronger claim: the screen has to read the *current* preference. A gate that
   * captured `aiEnabled` at mount would still see `true` here and make the request, which is
   * exactly what the zero-call assertion catches.
   */
  setAiEnabled(next: boolean): Promise<void>;
}

export async function renderAssistant(
  client: ApiClient,
  seedQuestion?: string,
  driver: MemoryDriver = memoryDriver({}),
): Promise<Harness> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const navigate = vi.fn();
  const runtime = { driver, now: () => '2026-09-14T12:00:00.000Z' };
  const params = seedQuestion === undefined ? undefined : { seedQuestion };

  // Captured rather than cast: `useDispatch()` already returns exactly this signature, so no `as`
  // is needed to hold on to it.
  let dispatch: ((action: PreferencesAction) => void) | null = null;
  function Capture(): ReactNode {
    dispatch = preferencesStore.useDispatch();
    return null;
  }

  await act(async () => {
    createRoot(host).render(
      <ThemeProvider mode="light" deviceScheme={null} fontScale={1}>
        <ApiProvider client={client}>
          <StorageProvider runtime={runtime}>
            <preferencesStore.Provider>
              <Capture />
              <AssistantScreen
                route={{ key: 'assistant-1', name: 'Assistant', params } as never}
                navigation={{ navigate } as never}
              />
            </preferencesStore.Provider>
          </StorageProvider>
        </ApiProvider>
      </ThemeProvider>,
    );
  });
  // `StorageProvider` renders no children until its snapshot resolves, so the screen is not on
  // screen until this has run.
  await flush();

  const find = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };
  const must = (testID: string): HTMLElement => {
    const found = find(testID);
    if (found === null) {
      throw new Error(`no element rendered for testID ${testID}`);
    }
    return found;
  };
  const input = (): HTMLElement => {
    const found = host.querySelector('textarea, input');
    if (!(found instanceof HTMLElement)) {
      throw new Error('no question field rendered');
    }
    return found;
  };
  const press = async (target: HTMLElement): Promise<void> => {
    await act(async () => {
      fireEvent.click(target);
    });
  };

  return {
    host,
    navigate,
    driver,
    find,
    must,
    text: () => host.textContent ?? '',
    input,
    type: async (value) => {
      await act(async () => {
        fireEvent.change(input(), { target: { value } });
      });
    },
    press,
    ask: () => press(must('assistant-ask')),
    setAiEnabled: async (next) => {
      await act(async () => {
        dispatch?.(preferencesActions.changeAiEnabled(next));
      });
      await flush();
    },
  };
}

/** Every vendor icon the tree asked for — the only provable half of a glyph in jsdom. */
export function iconsIn(node: HTMLElement): string[] {
  return [...node.querySelectorAll('[data-icon-name]')].map(
    (found) => found.getAttribute('data-icon-name') ?? '',
  );
}

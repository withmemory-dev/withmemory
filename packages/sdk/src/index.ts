export { WithMemoryClient, createClient } from "./client";
export { CacheInstance } from "./cache";
export {
  WithMemoryError,
  UnauthorizedError,
  KeyExpiredError,
  InvalidRequestError,
  NotFoundError,
  QuotaExceededError,
  PlanRequiredError,
  ExtractionFailedError,
  ContainerLimitExceededError,
  ContainerNameExistsError,
  InsufficientScopeError,
  RateLimitedError,
  CacheEntryLimitError,
  CacheExpiredError,
  AlreadyClaimedError,
  TimeoutError,
  NetworkError,
} from "./errors";
export type {
  WithMemoryConfig,
  Memory,
  AddParams,
  AddResponse,
  GetParams,
  GetResponse,
  RemoveParams,
  RecallResponse,
  RemoveResponse,
  HealthResponse,
  WhoamiResponse,
  UsageResponse,
  RecallOptions,
  RequestOptions,
  RegisterDefaults,
  ExtractionPromptResponse,
  ResetExtractionPromptResponse,
  ListOptions,
  ListResponse,
  Container,
  ContainerKey,
  CreateContainerOptions,
  CreateContainerResponse,
  CreateContainerKeyOptions,
  CreateContainerKeyResponse,
  ListContainersResponse,
  GetContainerOptions,
  GetContainerResponse,
  RevokeContainerKeyOptions,
  RevokeContainerKeyResponse,
  DeleteContainerOptions,
  DeleteContainerResponse,
  CacheCreateOptions,
  CacheCreateResponse,
  CacheEntry,
  CacheSetResponse,
  CacheGetResponse,
  CacheDeleteResponse,
  CacheListEntry,
  CacheListResponse,
  CacheClaimOptions,
  CacheClaimResponse,
  RequestCodeParams,
  RequestCodeResponse,
  VerifyCodeParams,
  VerifyCodeResponse,
} from "./types";

import { WithMemoryClient, createClient } from "./client";
import type {
  WithMemoryConfig,
  RegisterDefaults,
  RecallOptions,
  RequestOptions,
  AddParams,
  GetParams,
  RemoveParams,
  ListOptions,
  CacheCreateOptions,
  CacheClaimOptions,
  RequestCodeParams,
  VerifyCodeParams,
} from "./types";

// ─── Default singleton ──────────────────────────────────────────────────────
// Usage:
//   import { memory } from '@withmemory/sdk';
//   memory.configure({ apiKey: 'wm_...' });
//   await memory.add({ value: 'Alice', key: 'name', scope: 'user_1' });
//
// Authentication precedence for methods that require a key:
//   1. An explicit `memory.configure({ apiKey })` call (wins over env).
//   2. `process.env.WITHMEMORY_API_KEY` at first use (Node only; ignored
//      in browser-like environments where `process` is undefined).
//   3. Throw — the SDK can't dispatch authenticated calls without a key.
// Pre-auth methods (`cache.create`, `requestCode`, `verifyCode`) skip the
// third step and construct a temporary client with an empty key instead.

let instance: WithMemoryClient | null = null;

// Read WITHMEMORY_API_KEY via globalThis rather than `process` directly so
// the SDK stays browser-safe without a Node types dependency. Returns
// undefined in any environment that doesn't expose a Node-style process.env.
function envApiKey(): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.WITHMEMORY_API_KEY;
}

function getInstance(): WithMemoryClient {
  if (instance) return instance;
  const envKey = envApiKey();
  if (envKey) {
    instance = new WithMemoryClient({ apiKey: envKey });
    return instance;
  }
  throw new Error(
    "WithMemory SDK not configured. Call memory.configure({ apiKey: '...' }) " +
      "or set the WITHMEMORY_API_KEY environment variable before use."
  );
}

/**
 * Build a client for a pre-auth request (cache.create, requestCode,
 * verifyCode). Prefers an existing configured instance so a custom
 * `baseUrl` set via `configure()` is honored, then falls back to a
 * temporary client with an empty API key against the default base URL.
 */
function preAuthClient(): WithMemoryClient {
  return instance ?? createClient({ apiKey: "" });
}

export const memory = {
  /**
   * Configure the singleton client. An explicit `configure()` call always
   * wins over `process.env.WITHMEMORY_API_KEY`, so if both are present the
   * call site is authoritative. Calling `configure()` again replaces the
   * existing instance.
   */
  configure(config: WithMemoryConfig): void {
    instance = new WithMemoryClient(config);
  },

  register(defaults: RegisterDefaults): void {
    getInstance().register(defaults);
  },

  add(params: AddParams, options?: RequestOptions) {
    return getInstance().add(params, options);
  },

  get(params: GetParams, options?: RequestOptions) {
    return getInstance().get(params, options);
  },

  recall(options: RecallOptions, requestOptions?: RequestOptions) {
    return getInstance().recall(options, requestOptions);
  },

  remove(params: RemoveParams, options?: RequestOptions) {
    return getInstance().remove(params, options);
  },

  list(options?: ListOptions, requestOptions?: RequestOptions) {
    return getInstance().list(options, requestOptions);
  },

  delete(memoryId: string, options?: RequestOptions) {
    return getInstance().delete(memoryId, options);
  },

  health(options?: RequestOptions) {
    return getInstance().health(options);
  },

  whoami(options?: RequestOptions) {
    return getInstance().whoami(options);
  },

  usage(options?: RequestOptions) {
    return getInstance().usage(options);
  },

  setExtractionPrompt(prompt: string, options?: RequestOptions) {
    return getInstance().setExtractionPrompt(prompt, options);
  },

  getExtractionPrompt(options?: RequestOptions) {
    return getInstance().getExtractionPrompt(options);
  },

  resetExtractionPrompt(options?: RequestOptions) {
    return getInstance().resetExtractionPrompt(options);
  },

  get containers() {
    return getInstance().containers;
  },

  cache: {
    create(options?: CacheCreateOptions, requestOptions?: RequestOptions) {
      // cache.create is unauthenticated — works without configure()
      return preAuthClient().cache.create(options, requestOptions);
    },
    claim(options: CacheClaimOptions, requestOptions?: RequestOptions) {
      // claim requires an API key with account:admin scope
      return getInstance().cache.claim(options, requestOptions);
    },
  },

  // Pre-auth: these work before configure() is called. The returned key
  // from verifyCode() is the one to pass to configure() (or to set as
  // WITHMEMORY_API_KEY) for subsequent authenticated calls.
  requestCode(params: RequestCodeParams, options?: RequestOptions) {
    return preAuthClient().requestCode(params, options);
  },

  verifyCode(params: VerifyCodeParams, options?: RequestOptions) {
    return preAuthClient().verifyCode(params, options);
  },
};

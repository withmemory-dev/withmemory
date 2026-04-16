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
  ConfirmationRequiredError,
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
} from "./types";

// ─── Default singleton ──────────────────────────────────────────────────────
// Usage:
//   import { memory } from '@withmemory/sdk';
//   memory.configure({ apiKey: 'wm_...' });
//   await memory.add({ value: 'Alice', key: 'name', scope: 'user_1' });

let instance: WithMemoryClient | null = null;

function getInstance(): WithMemoryClient {
  if (!instance) {
    throw new Error(
      "WithMemory SDK not configured. Call memory.configure({ apiKey: '...' }) before use."
    );
  }
  return instance;
}

export const memory = {
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
      const client =
        instance ?? createClient({ apiKey: "", baseUrl: "https://api.withmemory.dev" });
      return client.cache.create(options, requestOptions);
    },
    claim(options: CacheClaimOptions, requestOptions?: RequestOptions) {
      // claim requires an API key — must call configure() first
      return getInstance().cache.claim(options, requestOptions);
    },
  },
};

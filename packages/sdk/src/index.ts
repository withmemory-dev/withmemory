export { WithMemoryClient, createClient } from "./client";
export { WithMemoryError } from "./errors";
export type {
  WithMemoryConfig,
  Memory,
  SetResponse,
  GetResponse,
  RecallResponse,
  RemoveResponse,
  HealthResponse,
  RecallOptions,
  CommitOptions,
  RegisterDefaults,
  ExtractionPromptResponse,
  ResetExtractionPromptResponse,
  FetchMemoriesOptions,
  FetchMemoriesResponse,
} from "./types";

import { WithMemoryClient } from "./client";
import type { WithMemoryConfig, RegisterDefaults, RecallOptions, CommitOptions, FetchMemoriesOptions } from "./types";

// ─── Default singleton (UserDefaults pattern) ────────────────────────────────
// Usage:
//   import { memory } from '@withmemory/sdk';
//   memory.configure({ apiKey: 'wm_...' });
//   await memory.set('user-1', 'name', 'Alice');

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
    // NOTE: configure() replaces the instance wholesale. If future
    // versions add in-flight state (commit queues, batching, etc.),
    // revisit whether reconfiguration should drain or preserve it.
    instance = new WithMemoryClient(config);
  },

  register(defaults: RegisterDefaults): void {
    getInstance().register(defaults);
  },

  set(userId: string, key: string, value: string) {
    return getInstance().set(userId, key, value);
  },

  get(userId: string, key: string) {
    return getInstance().get(userId, key);
  },

  recall(options: RecallOptions) {
    return getInstance().recall(options);
  },

  remove(userId: string, key: string) {
    return getInstance().remove(userId, key);
  },

  commit(options: CommitOptions) {
    return getInstance().commit(options);
  },

  fetchMemories(options?: FetchMemoriesOptions) {
    return getInstance().fetchMemories(options);
  },

  deleteMemory(memoryId: string) {
    return getInstance().deleteMemory(memoryId);
  },

  health() {
    return getInstance().health();
  },

  setExtractionPrompt(prompt: string) {
    return getInstance().setExtractionPrompt(prompt);
  },

  getExtractionPrompt() {
    return getInstance().getExtractionPrompt();
  },

  resetExtractionPrompt() {
    return getInstance().resetExtractionPrompt();
  },
};

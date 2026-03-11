import * as crypto from "node:crypto";
import { LRUCache } from "lru-cache";

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_STATES = 10_000;

export class StateStore {
  private static states = new LRUCache<string, true>({
    max: MAX_STATES,
    ttl: STATE_TTL_MS,
  });

  private constructor() {}

  static createState(): string {
    const state = crypto.randomBytes(32).toString("hex");
    StateStore.states.set(state, true);
    return state;
  }

  static validateState(state: string): boolean {
    if (!StateStore.states.has(state)) {
      return false;
    }

    StateStore.states.delete(state);
    return true;
  }
}

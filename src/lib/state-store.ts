import * as crypto from "node:crypto";
import { LRUCache } from "lru-cache";

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_STATES = 10_000;

export class StateStore {
  readonly #states = new LRUCache<string, true>({
    max: MAX_STATES,
    ttl: STATE_TTL_MS,
  });

  createState(): string {
    const state = crypto.randomBytes(32).toString("hex");
    this.#states.set(state, true);
    return state;
  }

  validateState(state: string): boolean {
    if (!this.#states.has(state)) {
      return false;
    }

    this.#states.delete(state);
    return true;
  }
}

const stateStore = new StateStore();

export default stateStore;

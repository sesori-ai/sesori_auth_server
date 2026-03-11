import * as crypto from "node:crypto";
import { LRUCache } from "lru-cache";

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_STATES = 10_000;

const states = new LRUCache<string, true>({
  max: MAX_STATES,
  ttl: STATE_TTL_MS,
});

export function createState(): string {
  const state = crypto.randomBytes(32).toString("hex");
  states.set(state, true);
  return state;
}

export function validateState(state: string): boolean {
  if (!states.has(state)) {
    return false;
  }

  states.delete(state);
  return true;
}

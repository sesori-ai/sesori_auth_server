import * as crypto from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000;

const states = new Map<string, { createdAt: number }>();

function purgeExpiredStates(now: number): void {
  for (const [state, value] of states.entries()) {
    if (now - value.createdAt > STATE_TTL_MS) {
      states.delete(state);
    }
  }
}

export function createState(): string {
  const now = Date.now();
  purgeExpiredStates(now);

  const state = crypto.randomBytes(32).toString("hex");
  states.set(state, { createdAt: now });

  return state;
}

export function validateState(state: string): boolean {
  const now = Date.now();
  purgeExpiredStates(now);

  const existing = states.get(state);
  if (!existing) {
    return false;
  }

  states.delete(state);
  return now - existing.createdAt <= STATE_TTL_MS;
}

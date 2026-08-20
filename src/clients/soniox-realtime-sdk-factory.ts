import { SonioxNodeClient } from "@soniox/node";
import type { SonioxRealtimeSdk } from "./soniox-realtime-transcription-client.js";
import {
  SONIOX_REALTIME_WS_URL_BY_REGION,
  SONIOX_REST_URL_BY_REGION,
  type SonioxRegion,
} from "../types/transcription.js";

type SonioxRealtimeClientOptions = {
  readonly api_key: string;
  readonly region: SonioxRegion;
  readonly base_url: string;
  readonly realtime: {
    readonly ws_base_url: string;
  };
};

type SonioxRealtimeConstructor = new (options: SonioxRealtimeClientOptions) => SonioxRealtimeSdk;

const SonioxRealtimeNodeClient: SonioxRealtimeConstructor = SonioxNodeClient;

/**
 * Regional residency pinning. The three endpoint fields are NOT redundant, so do not
 * "simplify" this to `region` alone:
 *
 * - `region` only picks the base the SDK *derives* defaults from, and it loses
 *   to `SONIOX_BASE_DOMAIN`, which the SDK reads straight from the environment.
 * - `base_url` is the highest-precedence REST endpoint and outranks
 *   `SONIOX_API_BASE_URL`.
 * - `realtime.ws_base_url` is the highest-precedence realtime endpoint and
 *   outranks `SONIOX_WS_URL`.
 *
 * Without the two explicit URLs an environment variable could redirect audio
 * and the API key away from the selected project. `src/index.ts` carries the same
 * warning for the async client, and `SONIOX_BASE_DOMAIN` is rejected outright
 * in `src/config.ts`.
 */
export function createSonioxRealtimeSdkOptions(deps: {
  readonly apiKey: string;
  readonly region: SonioxRegion;
}): SonioxRealtimeClientOptions {
  return {
    api_key: deps.apiKey,
    region: deps.region,
    base_url: SONIOX_REST_URL_BY_REGION[deps.region],
    realtime: { ws_base_url: SONIOX_REALTIME_WS_URL_BY_REGION[deps.region] },
  };
}

export function createSonioxRealtimeSdk(options: SonioxRealtimeClientOptions): SonioxRealtimeSdk {
  return new SonioxRealtimeNodeClient(options);
}

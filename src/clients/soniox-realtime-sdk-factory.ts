import { SonioxNodeClient } from "@soniox/node";
import type { SonioxRealtimeSdk } from "./soniox-realtime-transcription-client.js";
import { SONIOX_REALTIME_WS_URL_BY_REGION, SONIOX_REST_URL_BY_REGION } from "../types/transcription.js";

type SonioxRealtimeClientOptions = {
  readonly api_key: string;
  readonly region: "eu";
  readonly base_url: string;
  readonly realtime: {
    readonly ws_base_url: string;
  };
};

type SonioxRealtimeConstructor = new (options: SonioxRealtimeClientOptions) => SonioxRealtimeSdk;

const SonioxRealtimeNodeClient: SonioxRealtimeConstructor = SonioxNodeClient;

export function createSonioxRealtimeSdkOptions(deps: {
  readonly apiKey: string;
  readonly region: "eu";
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

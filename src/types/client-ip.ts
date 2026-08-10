import { z } from "zod";

export enum ClientIpSource {
  Socket = "socket",
  Cloudflare = "cloudflare",
}

export const clientIpSourceSchema = z.enum(ClientIpSource);

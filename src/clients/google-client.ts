import { z } from "zod";

const googleTokenResponseSchema = z.object({
  access_token: z.string(),
  id_token: z.string(),
  refresh_token: z.string().optional(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const googleIdTokenPayloadSchema = z.object({
  iss: z.enum(["accounts.google.com", "https://accounts.google.com"]),
  aud: z.string().min(1),
  exp: z.number(),
  sub: z.string().min(1),
  name: z.string().optional(),
  given_name: z.string().optional(),
});

function decodeJwtPayload(idToken: string): unknown {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }

  const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const payloadJson = Buffer.from(padded, "base64").toString("utf8");

  return JSON.parse(payloadJson) as unknown;
}

export class GoogleClient {
  private constructor() {}

  static async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    clientId: string,
    clientSecret: string,
  ): Promise<{ accessToken: string; idToken: string; refreshToken?: string }> {
    const tokenParams = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    });

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenParams.toString(),
    });

    if (!tokenResponse.ok) {
      throw new Error("GOOGLE_TOKEN_EXCHANGE_FAILED");
    }

    const tokenJson = await tokenResponse.json();
    const tokenParse = googleTokenResponseSchema.safeParse(tokenJson);
    if (!tokenParse.success || tokenParse.data.error) {
      throw new Error("INVALID_GOOGLE_TOKEN_RESPONSE");
    }

    return {
      accessToken: tokenParse.data.access_token,
      idToken: tokenParse.data.id_token,
      refreshToken: tokenParse.data.refresh_token,
    };
  }

  static decodeIdToken(idToken: string, clientId: string): { sub: string; name?: string } {
    const payloadRaw = decodeJwtPayload(idToken);
    const payload = googleIdTokenPayloadSchema.safeParse(payloadRaw);
    if (!payload.success) {
      throw new Error("INVALID_GOOGLE_ID_TOKEN_PAYLOAD");
    }

    if (payload.data.aud !== clientId) {
      throw new Error("GOOGLE_ID_TOKEN_AUDIENCE_MISMATCH");
    }

    if (payload.data.exp <= Math.floor(Date.now() / 1000)) {
      throw new Error("GOOGLE_ID_TOKEN_EXPIRED");
    }

    return {
      sub: payload.data.sub,
      name: payload.data.name ?? payload.data.given_name,
    };
  }
}

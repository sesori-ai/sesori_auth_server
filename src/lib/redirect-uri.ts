export function isAllowedRedirectUri(redirectUri: string, allowedRedirectUris: string[]): boolean {
  if (allowedRedirectUris.includes(redirectUri)) {
    return true;
  }

  return isLocalhostRedirectUri(redirectUri);
}

export function isLocalhostRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== "http:") {
      return false;
    }
    const hostname = url.hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

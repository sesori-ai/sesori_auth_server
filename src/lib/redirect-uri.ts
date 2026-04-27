export function isAllowedRedirectUri(redirectUri: string, allowedRedirectUris: string[]): boolean {
  if (allowedRedirectUris.includes(redirectUri)) {
    return true;
  }

  try {
    const url = new URL(redirectUri);
    const hostname = url.hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function isLocalhostRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    const hostname = url.hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

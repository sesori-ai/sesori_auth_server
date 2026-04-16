import { z } from "zod";
import { BadGatewayError } from "../lib/errors.js";

const INSTALL_SCRIPT_REPO_OWNER = "sesori-ai";
const INSTALL_SCRIPT_REPO_NAME = "sesori_apps_monorepo";
const INSTALL_SCRIPT_TAG_PREFIX = "bridge-v";
const INSTALL_SCRIPT_PATH_SH = "install.sh";
const INSTALL_SCRIPT_PATH_PS1 = "install.ps1";
const INSTALL_SCRIPT_CACHE_TTL_MS = 5 * 60 * 1000;
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_API_BASE_URL = "https://api.github.com";

export const browserUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const githubReleaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string(),
});

const githubReleaseListSchema = z.array(githubReleaseSchema);

type GithubRelease = z.infer<typeof githubReleaseSchema>;
type EligibleGithubRelease = {
  tagName: string;
  publishedAt: Date;
};

type InstallScriptCacheEntry = {
  tag: string;
  installSh: string;
  installPs1: string;
  expiresAt: number;
};

type LoadedInstallScriptCacheEntry = Omit<InstallScriptCacheEntry, "expiresAt">;

export type InstallScriptRelease = {
  owner: string;
  repo: string;
  tagName: string;
  publishedAt: string;
  installScriptPath: string;
  installPowerShellPath: string;
};

/**
 * Resolves the newest published bridge installer release and caches both script bodies together.
 * GitHub transport details stay local to this service for now, while callers only consume install.sh/install.ps1 content.
 */
export class InstallScriptService {
  readonly repoOwner = INSTALL_SCRIPT_REPO_OWNER;
  readonly repoName = INSTALL_SCRIPT_REPO_NAME;
  readonly installScriptPath = INSTALL_SCRIPT_PATH_SH;
  readonly installPowerShellPath = INSTALL_SCRIPT_PATH_PS1;
  readonly cacheTtlMs = INSTALL_SCRIPT_CACHE_TTL_MS;

  #cacheEntry: InstallScriptCacheEntry | null = null;
  #refreshPromise: Promise<InstallScriptCacheEntry> | null = null;

  async getInstallSh(): Promise<string> {
    const cacheEntry = await this.#getCacheEntry();
    return cacheEntry.installSh;
  }

  async getInstallPs1(): Promise<string> {
    const cacheEntry = await this.#getCacheEntry();
    return cacheEntry.installPs1;
  }

  selectLatestRelease(releasesPayload: unknown): InstallScriptRelease {
    const releases = this.#parseReleasesPayload(releasesPayload);
    const latestRelease = releases
      .map((release) => this.#toEligibleRelease(release))
      .filter((release): release is EligibleGithubRelease => release !== null)
      .sort((left, right) => this.#compareEligibleReleases(left, right))[0];

    if (!latestRelease) {
      throw new BadGatewayError({ debugMessage: "NO_ELIGIBLE_INSTALL_SCRIPT_RELEASE" });
    }

    return {
      owner: this.repoOwner,
      repo: this.repoName,
      tagName: latestRelease.tagName,
      publishedAt: latestRelease.publishedAt.toISOString(),
      installScriptPath: this.installScriptPath,
      installPowerShellPath: this.installPowerShellPath,
    };
  }

  #parseReleasesPayload(releasesPayload: unknown): GithubRelease[] {
    const result = githubReleaseListSchema.safeParse(releasesPayload);
    if (!result.success) {
      throw new BadGatewayError({ debugMessage: "INVALID_GITHUB_RELEASES_RESPONSE" });
    }

    return result.data;
  }

  #toEligibleRelease(release: GithubRelease): EligibleGithubRelease | null {
    if (!release.tag_name.startsWith(INSTALL_SCRIPT_TAG_PREFIX) || release.draft || release.prerelease) {
      return null;
    }

    const publishedAt = new Date(release.published_at);
    if (Number.isNaN(publishedAt.getTime())) {
      return null;
    }

    return {
      tagName: release.tag_name,
      publishedAt,
    };
  }

  #compareEligibleReleases(left: EligibleGithubRelease, right: EligibleGithubRelease): number {
    const publishedAtDiff = right.publishedAt.getTime() - left.publishedAt.getTime();
    if (publishedAtDiff !== 0) {
      return publishedAtDiff;
    }

    return right.tagName.localeCompare(left.tagName, "en", { numeric: true });
  }

  /**
   * Reuses stale cache on refresh failures to protect installs during temporary GitHub outages.
   */
  async #loadInstallScripts(
    existingCacheEntry: InstallScriptCacheEntry | null,
  ): Promise<LoadedInstallScriptCacheEntry> {
    const release = await this.#fetchLatestRelease();

    if (existingCacheEntry?.tag === release.tagName) {
      return {
        tag: existingCacheEntry.tag,
        installSh: existingCacheEntry.installSh,
        installPs1: existingCacheEntry.installPs1,
      };
    }

    const [installSh, installPs1] = await Promise.all([
      this.#fetchScriptBody(release.tagName, this.installScriptPath),
      this.#fetchScriptBody(release.tagName, this.installPowerShellPath),
    ]);

    return {
      tag: release.tagName,
      installSh,
      installPs1,
    };
  }

  async #getCacheEntry(): Promise<InstallScriptCacheEntry> {
    const cacheEntry = this.#cacheEntry;
    if (cacheEntry && this.#isCacheFresh(cacheEntry)) {
      return cacheEntry;
    }

    return this.#refreshCacheEntry(cacheEntry);
  }

  #isCacheFresh(cacheEntry: InstallScriptCacheEntry): boolean {
    return Date.now() < cacheEntry.expiresAt;
  }

  #refreshCacheEntry(existingCacheEntry: InstallScriptCacheEntry | null): Promise<InstallScriptCacheEntry> {
    if (this.#refreshPromise) {
      return this.#refreshPromise;
    }

    const refreshPromise = this.#loadAndCacheScripts(existingCacheEntry).finally(() => {
      if (this.#refreshPromise === refreshPromise) {
        this.#refreshPromise = null;
      }
    });

    this.#refreshPromise = refreshPromise;
    return refreshPromise;
  }

  async #loadAndCacheScripts(existingCacheEntry: InstallScriptCacheEntry | null): Promise<InstallScriptCacheEntry> {
    try {
      const loadedScripts = await this.#loadInstallScripts(existingCacheEntry);
      const cacheEntry: InstallScriptCacheEntry = {
        ...loadedScripts,
        expiresAt: Date.now() + this.cacheTtlMs,
      };
      this.#cacheEntry = cacheEntry;
      return cacheEntry;
    } catch (error) {
      if (!existingCacheEntry) {
        throw this.#toRefreshError(error);
      }

      const staleCacheEntry: InstallScriptCacheEntry = {
        ...existingCacheEntry,
        expiresAt: Date.now() + this.cacheTtlMs,
      };
      this.#cacheEntry = staleCacheEntry;
      return staleCacheEntry;
    }
  }

  #toRefreshError(error: unknown): BadGatewayError {
    if (error instanceof BadGatewayError) {
      return error;
    }

    return new BadGatewayError({
      debugMessage: "INSTALL_SCRIPT_REFRESH_FAILED",
      nestedError: error,
    });
  }

  async #fetchLatestRelease(): Promise<InstallScriptRelease> {
    let latestEligibleRelease: EligibleGithubRelease | null = null;
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      // This endpoint is intentionally unauthenticated for now. That keeps setup simple,
      // but it also means we depend on GitHub's public rate limits during outages/load.
      const response = await fetch(this.#buildReleasesUrl(page), this.#buildGithubRequestOptions("application/json"));

      if (!response.ok) {
        throw new BadGatewayError({ debugMessage: "GITHUB_RELEASE_FETCH_FAILED" });
      }

      const json = await response.json();
      latestEligibleRelease = this.#selectMoreRecentRelease(
        latestEligibleRelease,
        this.#findLatestEligibleRelease(json),
      );

      hasNextPage = this.#hasNextPage(response.headers.get("link"));
      page += 1;
    }

    if (!latestEligibleRelease) {
      throw new BadGatewayError({ debugMessage: "NO_ELIGIBLE_INSTALL_SCRIPT_RELEASE" });
    }

    return this.#toInstallScriptRelease(latestEligibleRelease);
  }

  async #fetchScriptBody(tagName: string, scriptPath: string): Promise<string> {
    const response = await fetch(
      this.#buildContentsUrl(scriptPath, tagName),
      this.#buildGithubRequestOptions("application/vnd.github.raw+json"),
    );

    if (!response.ok) {
      throw new BadGatewayError({ debugMessage: "GITHUB_INSTALL_SCRIPT_FETCH_FAILED" });
    }

    const content = await response.text();
    if (!content) {
      throw new BadGatewayError({ debugMessage: "MISSING_GITHUB_INSTALL_SCRIPT_CONTENT" });
    }

    return content;
  }

  #buildReleasesUrl(page: number): string {
    const url = new URL(`/repos/${this.repoOwner}/${this.repoName}/releases`, GITHUB_API_BASE_URL);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    return url.toString();
  }

  #buildContentsUrl(scriptPath: string, tagName: string): string {
    const url = new URL(`/repos/${this.repoOwner}/${this.repoName}/contents/${scriptPath}`, GITHUB_API_BASE_URL);
    url.searchParams.set("ref", tagName);
    return url.toString();
  }

  #hasNextPage(linkHeader: string | null): boolean {
    if (!linkHeader) {
      return false;
    }

    return linkHeader.split(",").some((linkValue) => linkValue.includes('rel="next"'));
  }

  #findLatestEligibleRelease(releasesPayload: unknown): EligibleGithubRelease | null {
    const releases = this.#parseReleasesPayload(releasesPayload);
    const latestRelease = releases
      .map((release) => this.#toEligibleRelease(release))
      .filter((release): release is EligibleGithubRelease => release !== null)
      .sort((left, right) => this.#compareEligibleReleases(left, right))[0];

    if (!latestRelease) {
      return null;
    }

    return latestRelease;
  }

  #toInstallScriptRelease(release: EligibleGithubRelease): InstallScriptRelease {
    return {
      owner: this.repoOwner,
      repo: this.repoName,
      tagName: release.tagName,
      publishedAt: release.publishedAt.toISOString(),
      installScriptPath: this.installScriptPath,
      installPowerShellPath: this.installPowerShellPath,
    };
  }

  #selectMoreRecentRelease(
    currentRelease: EligibleGithubRelease | null,
    candidateRelease: EligibleGithubRelease | null,
  ): EligibleGithubRelease | null {
    if (!candidateRelease) {
      return currentRelease;
    }

    if (!currentRelease) {
      return candidateRelease;
    }

    return this.#compareEligibleReleases(currentRelease, candidateRelease) <= 0 ? currentRelease : candidateRelease;
  }

  #buildGithubRequestOptions(accept: string): RequestInit {
    return {
      headers: {
        Accept: accept,
        "User-Agent": browserUserAgent,
      },
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    };
  }
}

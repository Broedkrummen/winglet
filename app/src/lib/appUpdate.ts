import { compareVersions } from './version';

/** Newest first; ten covers a run of betas between two releases. Drafts never appear unauthenticated. */
export const RELEASES_URL = 'https://api.github.com/repos/VIKASRP24/winglet/releases?per_page=10';
/** GitHub allows 60 unauthenticated requests an hour per address; twice a day is plenty. */
export const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;

export type Release = {
  tag_name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name: string; browser_download_url: string }[];
};

/** A newer app: its version, its release page, and the APK to download when there is one. */
export type AppUpdate = { version: string; page: string; apk?: string };

/**
 * The newest release above `current`, or null. Betas are offered only to someone already on a beta,
 * so a full release never nags people towards a pre-release.
 */
export function newestUpdate(releases: Release[], current: string): AppUpdate | null {
  if (!current) return null;
  const onBeta = current.includes('-');
  let best: Release | null = null;
  let bestVersion = current;
  for (const r of releases) {
    if (r.draft || (r.prerelease && !onBeta)) continue;
    const version = r.tag_name.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) continue;
    if (compareVersions(version, bestVersion) > 0) { best = r; bestVersion = version; }
  }
  if (!best) return null;
  return { version: bestVersion, page: best.html_url, apk: pickApk(best.assets ?? []) };
}

/** The release APK, preferring a 64-bit ARM build if the release has one per CPU. Never a debug-key build. */
function pickApk(assets: { name: string; browser_download_url: string }[]): string | undefined {
  const apks = assets.filter((a) => a.name.endsWith('.apk') && !a.name.includes('debugkey'));
  return (apks.find((a) => a.name.includes('arm64')) ?? apks[0])?.browser_download_url;
}

/** Whether a stored check is still good: recent, and made by this same version of the app. */
export function checkIsFresh(saved: { checkedAt?: number; current?: string } | null, current: string, now: number): boolean {
  return !!saved?.checkedAt && saved.current === current && now - saved.checkedAt < CHECK_EVERY_MS && saved.checkedAt <= now;
}

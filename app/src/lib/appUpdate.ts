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
  body?: string | null;
  assets?: Asset[];
};

type Asset = { name: string; browser_download_url: string; size?: number };

/**
 * A newer app: its version, its release page, the start of its notes, and the APK for this phone
 * (with its size, to check the download) when the release has one.
 */
export type AppUpdate = { version: string; page: string; apk?: string; apkSize?: number; notes?: string };

/** The CPUs release APKs are built for, most capable first (see app/plugins/withApkSplits.js). */
const ABIS = ['arm64-v8a', 'armeabi-v7a'];

/**
 * The newest release above `current`, or null. Betas are offered only to someone already on a beta,
 * so a full release never nags people towards a pre-release.
 */
export function newestUpdate(releases: Release[], current: string, deviceAbis?: string[] | null): AppUpdate | null {
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
  const apk = pickApk(best.assets ?? [], deviceAbis);
  return { version: bestVersion, page: best.html_url, apk: apk?.browser_download_url, apkSize: apk?.size, notes: releaseNotes(best.body) };
}

/**
 * The release APK for this phone: the build for the first CPU it supports, else a universal build.
 * Without the phone's CPU list, the 64-bit ARM build (nearly every phone since 2017). Never a debug-key build.
 */
export function pickApk(assets: Asset[], deviceAbis?: string[] | null): Asset | undefined {
  const apks = assets.filter((a) => a.name.endsWith('.apk') && !a.name.includes('debugkey'));
  const abiOf = (a: Asset) => ABIS.find((abi) => a.name.endsWith(`-${abi}.apk`));
  const universal = apks.find((a) => !abiOf(a));
  if (deviceAbis?.length) {
    for (const abi of deviceAbis) {
      const match = apks.find((a) => abiOf(a) === abi);
      if (match) return match;
    }
    // The phone told us its CPUs and no split fits: only a universal build can install.
    return universal;
  }
  return apks.find((a) => abiOf(a) === 'arm64-v8a') ?? universal ?? apks[0];
}

/** The first paragraph of a release's notes (its summary), on one line: enough for a prompt. */
export function releaseNotes(body?: string | null, limit = 400): string | undefined {
  const first = (body ?? '').replace(/\r\n/g, '\n').trim().split(/\n\s*\n/)[0];
  const text = first.startsWith('#') ? '' : first.replace(/\s*\n\s*/g, ' ').trim();
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit).replace(/\s+\S*$/, '')}…` : text;
}

/** Whether a stored check is still good: recent, and made by this same version of the app. */
export function checkIsFresh(saved: { checkedAt?: number; current?: string } | null, current: string, now: number): boolean {
  return !!saved?.checkedAt && saved.current === current && now - saved.checkedAt < CHECK_EVERY_MS && saved.checkedAt <= now;
}

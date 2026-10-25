// app.json holds the static config; this layer stamps the release version from CI and adds the
// release-signing plugin. WINGLET_VERSION is the tag without the "v" (e.g. 0.1.2 or 0.2.0-beta.1).
module.exports = ({ config }) => {
  const version = process.env.WINGLET_VERSION || config.version;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(?:beta|rc)\.\d+)?$/.exec(version);
  if (!match) throw new Error(`WINGLET_VERSION must look like 1.2.3 or 1.2.3-beta.1, got "${version}"`);
  // A beta shares its release's versionCode, so the final release installs over it as an update.
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (minor > 99 || patch > 99) throw new Error('minor and patch must be below 100 to keep versionCode monotonic');
  const dev = process.env.WINGLET_DEV === '1';
  return {
    ...config,
    version,
    // A debug build for testing on a phone over USB: its own package, so it installs beside the real app
    // (whose release key it can't match) instead of replacing it and its pairings.
    ...(dev ? { name: 'Winglet Dev', scheme: 'winglet-dev' } : {}),
    android: {
      ...config.android,
      versionCode: major * 10000 + minor * 100 + patch,
      ...(dev ? { package: `${config.android.package}.dev` } : {}),
    },
    plugins: [...(config.plugins ?? []), './plugins/withReleaseSigning', './plugins/withApkSplits', './plugins/withInstallPackages', './plugins/withPhoneTools'],
  };
};

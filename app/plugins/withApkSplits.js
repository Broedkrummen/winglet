// Release builds made with WINGLET_SPLIT_APKS=1 produce one APK per CPU (arm64-v8a, armeabi-v7a)
// instead of one universal APK, roughly halving the download (see docs/RELEASING.md). Every split
// keeps the same versionCode: each phone installs only the one for its CPU, so updates still apply.
// Local builds without the variable are unchanged.
const { withAppBuildGradle } = require('expo/config-plugins');

const SPLITS = `
    splits {
        abi {
            enable System.getenv('WINGLET_SPLIT_APKS') == '1'
            reset()
            include 'arm64-v8a', 'armeabi-v7a'
            universalApk false
        }
    }
`;

module.exports = function withApkSplits(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;
    if (gradle.includes('WINGLET_SPLIT_APKS')) return cfg;
    const android = /\nandroid\s*\{\n/;
    if (!android.test(gradle)) throw new Error('withApkSplits: unexpected android/app/build.gradle layout');
    cfg.modResults.contents = gradle.replace(android, (m) => `${m}${SPLITS}`);
    return cfg;
  });
};

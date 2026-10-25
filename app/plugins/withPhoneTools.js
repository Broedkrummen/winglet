const { withAndroidManifest } = require('expo/config-plugins');
const permissions = ['ACCESS_COARSE_LOCATION','ACCESS_FINE_LOCATION','READ_CONTACTS','READ_CALENDAR','ACCESS_NETWORK_STATE'];
module.exports = config => withAndroidManifest(config, config => {
  const manifest = config.modResults.manifest;
  manifest['uses-permission'] = manifest['uses-permission'] || [];
  for (const name of permissions) {
    const full = `android.permission.${name}`;
    if (!manifest['uses-permission'].some(p => p.$?.['android:name'] === full)) manifest['uses-permission'].push({ $: { 'android:name': full } });
  }
  return config;
});

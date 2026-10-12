// Lets the app hand a downloaded update to Android's installer. Android still asks the person to
// allow installs from Winglet the first time, and only installs an APK signed with the same key.
const { AndroidConfig } = require('expo/config-plugins');

module.exports = function withInstallPackages(config) {
  return AndroidConfig.Permissions.withPermissions(config, ['android.permission.REQUEST_INSTALL_PACKAGES']);
};

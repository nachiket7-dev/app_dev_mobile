const { withAndroidManifest, withInfoPlist } = require('expo/config-plugins');

module.exports = function withDevelopmentNetworking(config) {
  // Local native HTTP is an explicit development opt-in, never a preview/release default.
  const profile = process.env.EAS_BUILD_PROFILE;
  const localHttp = profile === 'development' || !profile && process.env.CAMPUS_CHAT_LOCAL_DEV_NETWORK === '1';
  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) application.$['android:usesCleartextTraffic'] = localHttp ? 'true' : 'false';
    return mod;
  });
  return withInfoPlist(config, (mod) => {
    const transport = {
      ...mod.modResults.NSAppTransportSecurity,
      NSAllowsArbitraryLoads: localHttp,
    };
    // iOS ignores NSAllowsArbitraryLoads if a fine-grained ATS key is also present.
    if (localHttp) {
      delete transport.NSAllowsLocalNetworking;
      delete transport.NSAllowsArbitraryLoadsForMedia;
      delete transport.NSAllowsArbitraryLoadsInWebContent;
    } else transport.NSAllowsLocalNetworking = true;
    mod.modResults.NSAppTransportSecurity = transport;
    return mod;
  });
};

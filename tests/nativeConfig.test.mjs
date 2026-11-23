import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const pluginSource = await readFile(new URL('../src/plugins/withDevelopmentNetworking.js', import.meta.url), 'utf8');

function transportConfig(env) {
  const callbacks = {};
  const context = {
    module: { exports: {} }, process: { env },
    require: (name) => {
      assert.equal(name, 'expo/config-plugins');
      return {
        withAndroidManifest: (config, callback) => { callbacks.android = callback; return config; },
        withInfoPlist: (config, callback) => { callbacks.ios = callback; return config; },
      };
    },
  };
  vm.runInNewContext(pluginSource, context);
  context.module.exports({});
  const android = { modResults: { manifest: { application: [{ $: {} }] } } };
  const ios = { modResults: { NSAppTransportSecurity: { NSAllowsLocalNetworking: true, NSAllowsArbitraryLoadsInWebContent: false } } };
  return { android: callbacks.android(android).modResults.manifest.application[0].$,
    ios: callbacks.ios(ios).modResults.NSAppTransportSecurity };
}

test('native cleartext is disabled for defaults, preview, and release even with a local opt-in', () => {
  for (const env of [{}, { EAS_BUILD_PROFILE: 'preview', CAMPUS_CHAT_LOCAL_DEV_NETWORK: '1' },
    { EAS_BUILD_PROFILE: 'production', CAMPUS_CHAT_LOCAL_DEV_NETWORK: '1' }]) {
    const config = transportConfig(env);
    assert.equal(config.android['android:usesCleartextTraffic'], 'false');
    assert.equal(config.ios.NSAllowsArbitraryLoads, false);
  }
});

test('explicit native development allows local testing without a fine-grained ATS key nullifying the exception', () => {
  for (const env of [{ EAS_BUILD_PROFILE: 'development' }, { CAMPUS_CHAT_LOCAL_DEV_NETWORK: '1' }]) {
    const config = transportConfig(env);
    assert.equal(config.android['android:usesCleartextTraffic'], 'true');
    assert.equal(config.ios.NSAllowsArbitraryLoads, true);
    assert.equal('NSAllowsLocalNetworking' in config.ios, false);
    assert.equal('NSAllowsArbitraryLoadsInWebContent' in config.ios, false);
  }
});

test('submission app config is a Router SPA with demo identifiers and no audio recording permission', async () => {
  const { expo } = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
  assert.equal(expo.web.output, 'single');
  assert.ok(expo.plugins.includes('expo-router'));
  assert.match(expo.ios.bundleIdentifier, /\.demo$/);
  assert.match(expo.android.package, /\.demo$/);
  assert.equal(expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-image-picker')[1].microphonePermission, false);
});

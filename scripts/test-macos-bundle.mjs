import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tauriRoot = new URL("../src-tauri/", import.meta.url);
const config = JSON.parse(readFileSync(new URL("tauri.conf.json", tauriRoot), "utf8"));

test("macOS microphone entitlement is wired into the hardened-runtime bundle", () => {
  const mac = config.bundle.macOS;
  assert.notEqual(mac.hardenedRuntime, false, "Do not bypass hardened runtime to enable recording");
  assert.equal(mac.entitlements, "Entitlements.plist");
  const plist = readFileSync(new URL(mac.entitlements, tauriRoot), "utf8");
  assert.match(plist, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/);
  assert.doesNotMatch(plist, /<key>com\.apple\.security\.device\.camera<\/key>/);
});

test("macOS bundle declares a microphone usage description", () => {
  const plist = readFileSync(new URL(config.bundle.macOS.infoPlist, tauriRoot), "utf8");
  assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
});

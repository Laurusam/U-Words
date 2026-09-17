import { spawnSync } from "node:child_process";
import process from "node:process";
import { createRequire } from "node:module";

const command = process.argv[2] || "build";
const args = [command, ...process.argv.slice(3)];
const require = createRequire(import.meta.url);
// Run the CLI with Node directly: .cmd files cannot be spawned without a shell
// on Windows. This also preserves arguments without shell quoting/injection.
const cliEntry = require.resolve("@tauri-apps/cli/tauri.js");
const environment = { ...process.env };

if (process.platform === "darwin") {
  environment.MACOSX_DEPLOYMENT_TARGET = "10.15";
  environment.CMAKE_OSX_DEPLOYMENT_TARGET = "10.15";
}

const result = spawnSync(process.execPath, [cliEntry, ...args], {
  stdio: "inherit",
  env: environment,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

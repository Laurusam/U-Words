import { spawnSync } from "node:child_process";
import process from "node:process";

const command = process.argv[2] || "build";
const args = [command, ...process.argv.slice(3)];
const executable = process.platform === "win32" ? "tauri.cmd" : "tauri";
const environment = { ...process.env };

if (process.platform === "darwin") {
  environment.MACOSX_DEPLOYMENT_TARGET = "10.15";
  environment.CMAKE_OSX_DEPLOYMENT_TARGET = "10.15";
}

const result = spawnSync(executable, args, {
  stdio: "inherit",
  env: environment,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

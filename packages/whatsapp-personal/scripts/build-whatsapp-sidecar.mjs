import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarRoot = resolve(packageRoot, "../../sidecar");
const outputDir = join(packageRoot, "bin");
const args = process.argv.slice(2);
const target = parseTarget(args, process.env);
const goos = target.platform === "win32" ? "windows" : target.platform;
const goarch = target.architecture === "x64" ? "amd64" : target.architecture;
const nativePlatform = process.platform === "win32" ? "win32" : process.platform;
const nativeArch = process.arch;

if ((target.platform !== nativePlatform || target.architecture !== nativeArch) && !process.env.CC) {
  throw new Error("Cross-compiling the SQLCipher sidecar requires a target C compiler configured with CC");
}

mkdirSync(outputDir, { recursive: true });
const filename = `whatsapp-linked-device-${target.platform}-${target.architecture}${target.platform === "win32" ? ".exe" : ""}`;
const outputPath = join(outputDir, filename);
const result = spawnSync(
  "go",
  ["build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-o", outputPath, "."],
  {
    cwd: sidecarRoot,
    env: {
      ...process.env,
      CGO_ENABLED: "1",
      GOOS: goos,
      GOARCH: goarch,
    },
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
}

function parseTarget(argv, env) {
  const platformIndex = argv.indexOf("--platform");
  const archIndex = argv.indexOf("--arch");
  const platform = platformIndex >= 0
    ? argv[platformIndex + 1]
    : env.REGENIC_WHATSAPP_SIDECAR_PLATFORM || currentPlatform();
  const architecture = archIndex >= 0
    ? argv[archIndex + 1]
    : env.REGENIC_WHATSAPP_SIDECAR_ARCH || process.arch;
  const supported = new Set([
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ]);
  if (!supported.has(`${platform}-${architecture}`)) {
    throw new Error(`Unsupported sidecar target: ${platform}-${architecture}`);
  }
  return { platform, architecture };
}

function currentPlatform() {
  return process.platform;
}

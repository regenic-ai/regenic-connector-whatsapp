import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const regenicRoot = process.env.REGENIC_ROOT?.trim();

if (regenicRoot) {
  const contractRoot = resolve(regenicRoot, "packages/connector-contract");
  const contractManifest = join(contractRoot, "package.json");
  if (!existsSync(contractManifest)) {
    throw new Error(`REGENIC_ROOT does not contain packages/connector-contract: ${regenicRoot}`);
  }
  const manifest = JSON.parse(readFileSync(contractManifest, "utf8"));
  if (manifest.name !== "@regenic/connector-contract") {
    throw new Error("REGENIC_ROOT points to an unexpected connector-contract package");
  }

  const scopePath = join(packageRoot, "node_modules", "@regenic");
  const linkPath = join(scopePath, "connector-contract");
  mkdirSync(scopePath, { recursive: true });
  if (existsSync(linkPath)) {
    if (!lstatSync(linkPath).isSymbolicLink()) {
      throw new Error("Refusing to replace a non-symlink connector-contract installation");
    }
    unlinkSync(linkPath);
  }
  symlinkSync(contractRoot, linkPath, process.platform === "win32" ? "junction" : "dir");
}

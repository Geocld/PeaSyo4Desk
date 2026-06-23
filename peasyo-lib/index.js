const { readFileSync } = require("node:fs");
const path = require("node:path");

const { platform, arch } = process;
const { name: packageName, version } = require("./package.json");

function isMusl() {
  if (!process.report || typeof process.report.getReport !== "function") {
    try {
      return readFileSync("/usr/bin/ldd", "utf8").includes("musl");
    } catch (_error) {
      return true;
    }
  }

  const report = process.report.getReport();
  return !report.header.glibcVersionRuntime;
}

function resolveTarget() {
  if (platform === "win32") {
    if (arch === "x64") return "win32-x64-msvc";
    throw new Error(`Unsupported architecture on Windows: ${arch}`);
  }

  if (platform === "darwin") {
    if (arch === "x64") return "darwin-x64";
    if (arch === "arm64") return "darwin-arm64";
    throw new Error(`Unsupported architecture on macOS: ${arch}`);
  }

  if (platform === "linux") {
    if (isMusl()) {
      throw new Error(
        "Unsupported Linux libc: musl. Only glibc builds are currently provided."
      );
    }
    if (arch === "x64") return "linux-x64-gnu";
    if (arch === "arm64") return "linux-arm64-gnu";
    throw new Error(`Unsupported architecture on Linux: ${arch}`);
  }

  throw new Error(`Unsupported OS: ${platform}, architecture: ${arch}`);
}

const target = resolveTarget();
const addonPath = path.join(__dirname, "native", version, `${packageName}.${target}.node`);

module.exports = require(addonPath);

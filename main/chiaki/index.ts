import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type DesktopTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64-gnu"
  | "linux-x64-gnu"
  | "win32-x64-msvc";

const ADDON_BASE_NAME = "chiaki-lib";

const LOCAL_ADDON_FILE_BY_TARGET: Record<DesktopTarget, string> = {
  "darwin-arm64": "chiaki-lib.darwin-arm64.node",
  "darwin-x64": "chiaki-lib.darwin-x64.node",
  "linux-arm64-gnu": "chiaki-lib.linux-arm64-gnu.node",
  "linux-x64-gnu": "chiaki-lib.linux-x64-gnu.node",
  "win32-x64-msvc": "chiaki-lib.win32-x64-msvc.node",
};

declare const __non_webpack_require__: undefined | ((id: string) => any);
const runtimeRequire =
  typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__
    : // eslint-disable-next-line no-eval
      (0, eval)("require");

let loadError: unknown = null;
const attemptedLocalPaths: string[] = [];

const isMusl = () => {
  if (!process.report || typeof process.report.getReport !== "function") {
    try {
      return readFileSync("/usr/bin/ldd", "utf8").includes("musl");
    } catch {
      return true;
    }
  }

  const report = process.report.getReport();
  return !report.header.glibcVersionRuntime;
};

const resolveDesktopTarget = (): DesktopTarget => {
  const { platform, arch } = process;

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

  throw new Error(`Unsupported platform for desktop native binding: ${platform}/${arch}`);
};

const tryLoad = (specifier: string) => {
  try {
    return runtimeRequire(specifier);
  } catch (error) {
    loadError = error;
    return null;
  }
};

const loadBinding = () => {
  const target = resolveDesktopTarget();
  const localFile = LOCAL_ADDON_FILE_BY_TARGET[target];

  const candidateDirs = [
    __dirname,
    path.resolve(__dirname, "..", "main", "chiaki"),
    path.resolve(__dirname, "..", "..", "main", "chiaki"),
    path.resolve(process.cwd(), "main", "chiaki"),
    path.resolve(process.cwd(), "app", "main", "chiaki"),
  ];

  const seen = new Set<string>();
  for (const dir of candidateDirs) {
    const localBindingPath = path.resolve(dir, localFile);
    if (seen.has(localBindingPath)) {
      continue;
    }
    seen.add(localBindingPath);
    attemptedLocalPaths.push(localBindingPath);

    if (existsSync(localBindingPath)) {
      const localBinding = tryLoad(localBindingPath);
      if (localBinding) {
        return localBinding;
      }
    }
  }

  const platformPackageName = `${ADDON_BASE_NAME}-${target}`;
  const packageBinding = tryLoad(platformPackageName);
  if (packageBinding) {
    return packageBinding;
  }

  const cause =
    loadError && loadError instanceof Error
      ? `\nOriginal error: ${loadError.message}`
      : "";
  const localPathInfo =
    attemptedLocalPaths.length > 0
      ? `\nTried local paths:\n- ${attemptedLocalPaths.join("\n- ")}`
      : "";
  throw new Error(
    `Failed to load native addon '${ADDON_BASE_NAME}' for target '${target}'.${cause}${localPathInfo}`
  );
};

const binding = loadBinding();

export default binding;

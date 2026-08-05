const fs = require("node:fs");
const path = require("node:path");

const isMacBuild =
  process.platform === "darwin" ||
  process.env.RUNNER_OS === "macOS" ||
  process.env.npm_config_platform === "darwin";

const targets = ["darwin-x64", "darwin-arm64"];
const rootDir = path.resolve(__dirname, "..");
const sourceRoot = path.join(rootDir, "node_modules", "@ffmpeg-installer");
const resourceRoot = path.join(rootDir, "resources", "ffmpeg-installer");

const copyFile = (source, destination) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o755);
};

const copyBinary = (target) => {
  const source = path.join(sourceRoot, target, "ffmpeg");
  const destination = path.join(resourceRoot, target, "ffmpeg");

  if (!fs.existsSync(source)) {
    if (fs.existsSync(destination)) {
      fs.chmodSync(destination, 0o755);
      return;
    }
    throw new Error(
      `Missing ${target} FFmpeg binary. Expected ${source}. ` +
        "Install @ffmpeg-installer/darwin-x64 and @ffmpeg-installer/darwin-arm64 before packaging universal mac builds."
    );
  }

  copyFile(source, destination);
};

module.exports = async () => {
  if (!isMacBuild) {
    return;
  }

  for (const target of targets) {
    copyBinary(target);
  }

  console.log(
    `Prepared mac FFmpeg resources: ${targets
      .map((target) => path.join("resources", "ffmpeg-installer", target, "ffmpeg"))
      .join(", ")}`
  );
};

if (require.main === module) {
  module.exports().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

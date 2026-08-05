const prepareRuntimeNodeModules = require("./prepare-runtime-node-modules");
const prepareMacFfmpegResources = require("./prepare-mac-ffmpeg-resources");

module.exports = async () => {
  await prepareRuntimeNodeModules();
  await prepareMacFfmpegResources();
};

if (require.main === module) {
  module.exports().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

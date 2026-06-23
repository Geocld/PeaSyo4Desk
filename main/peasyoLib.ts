import fs from "fs";
import path from "path";

declare const __non_webpack_require__: NodeRequire | undefined;

const runtimeRequire =
  typeof __non_webpack_require__ === "function" ? __non_webpack_require__ : require;

const resolvePeasyoLibPath = () => {
  const candidates = [
    path.resolve(__dirname, "..", "peasyo-lib"),
    path.resolve(process.cwd(), "peasyo-lib"),
    path.resolve(__dirname, "..", "..", "peasyo-lib"),
  ];

  const match = candidates.find((candidate) => {
    return fs.existsSync(path.join(candidate, "package.json"));
  });

  if (!match) {
    throw new Error(`Local peasyo-lib was not found. Tried: ${candidates.join(", ")}`);
  }

  return match;
};

const peasyoLibPath = resolvePeasyoLibPath();
const rawPeasyo = runtimeRequire(peasyoLibPath);

const binding = rawPeasyo as any;

const decorateRemoteError = (error: any) => {
  if (!error || typeof error.message !== "string") {
    return error;
  }

  const match = error.message.match(
    /^\[([A-Z0-9_]+)\]\s+stage=([^\s]+)\s+nativeCode=(\d+)\s+message=(.*)$/
  );
  if (!match) {
    return error;
  }

  error.code = match[1];
  error.stage = match[2];
  error.nativeCode = Number(match[3]);
  error.nativeMessage = match[4];
  return error;
};

const wrapRemotePromise = (fn: unknown, name: string) => {
  return (options: unknown) => {
    if (typeof fn !== "function") {
      throw new Error(`peasyo-lib ${name} is required.`);
    }

    return Promise.resolve()
      .then(() => fn(options))
      .catch((error) => {
        throw decorateRemoteError(error);
      });
  };
};

const peasyo = {
  ...binding,
  codecs:
    binding.codecs ||
    Object.freeze({
      H264: 0,
      H265: 1,
      H265_HDR: 2,
    }),
  controllerButtons:
    binding.controllerButtons ||
    Object.freeze({
      CROSS: 1 << 0,
      MOON: 1 << 1,
      BOX: 1 << 2,
      PYRAMID: 1 << 3,
      DPAD_LEFT: 1 << 4,
      DPAD_RIGHT: 1 << 5,
      DPAD_UP: 1 << 6,
      DPAD_DOWN: 1 << 7,
      L1: 1 << 8,
      R1: 1 << 9,
      L3: 1 << 10,
      R3: 1 << 11,
      OPTIONS: 1 << 12,
      SHARE: 1 << 13,
      TOUCHPAD: 1 << 14,
      PS: 1 << 15,
    }),
  controllerAnalogButtons:
    binding.controllerAnalogButtons ||
    Object.freeze({
      L2: 1 << 16,
      R2: 1 << 17,
    }),
  remote:
    binding.remote ||
    Object.freeze({
      listDevices: wrapRemotePromise(binding.remoteListDevices, "remoteListDevices"),
      prepareConnection: wrapRemotePromise(
        binding.remotePrepareConnection,
        "remotePrepareConnection"
      ),
      prepareSession: wrapRemotePromise(binding.remotePrepareSession, "remotePrepareSession"),
      autoRegist: wrapRemotePromise(binding.remoteAutoRegist, "remoteAutoRegist"),
    }),
};

export default peasyo;

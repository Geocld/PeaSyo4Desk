import http from "node:http";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import type { WebContents } from "electron";
import ffmpeg from "fluent-ffmpeg";
import WS from "ws";
import chiaki from "chiaki-lib";
import {
  createNodeGamepadDriver,
  type ControllerStateSnapshot as NodeControllerStateSnapshot,
} from "./gamepadDriver";

const IS_WINDOWS = process.platform === "win32";
const IS_MACOS = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

const STREAM_WS_HOST = "127.0.0.1";
const STREAM_WS_PATH = "/stream";
const WS_BINARY_VIDEO = 1;
const WS_BINARY_AUDIO = 2;
const WS_BINARY_VIDEO_ENCODED = 3;
const MAX_VIDEO_CLIENT_BACKLOG_BYTES = 1 * 1024 * 1024;
const MAX_AUDIO_CLIENT_BACKLOG_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_AUDIO_INPUT_BYTES = 512 * 1024;
const MAX_NATIVE_VIDEO_FRAMES_IN_FLIGHT = 1;
const NATIVE_VIDEO_FRAME_ACK_TIMEOUT_MS = IS_WINDOWS ? 100 : IS_LINUX ? 120 : 250;
const NATIVE_ENCODED_VIDEO_SAMPLE_ACK_TIMEOUT_MS = IS_WINDOWS ? 350 : IS_LINUX ? 500 : 500;
const STEAMOS_ENCODED_VIDEO_SAMPLE_ACK_TIMEOUT_MS = 700;
type SteamOsWebCodecsProfile = "balanced" | "stable" | "ultra-stable";
const STEAMOS_WEBCODECS_PROFILE_DEFAULT: SteamOsWebCodecsProfile = "stable";
const STEAMOS_NATIVE_ENCODED_VIDEO_SAMPLES_IN_FLIGHT: Record<SteamOsWebCodecsProfile, number> = {
  balanced: 8,
  stable: 12,
  "ultra-stable": 16,
};
const VIDEO_DECODER_INPUT_HIGH_WATERMARK_BYTES = IS_WINDOWS ? 256 * 1024 : IS_LINUX ? 512 * 1024 : 1024 * 1024;
const MAX_PENDING_VIDEO_SAMPLE_BYTES_MIN = 256 * 1024;
const MAX_PENDING_VIDEO_SAMPLE_BYTES_MAX = 8 * 1024 * 1024;
const MAX_PENDING_VIDEO_SAMPLE_SECONDS = IS_WINDOWS ? 0.2 : IS_LINUX ? 0.16 : 0.22;
const MAX_PENDING_ENCODED_VIDEO_SAMPLE_BYTES_MIN = 512 * 1024;
const SDR_STREAM_FORMAT = "NV12";
const HDR_STREAM_FORMAT: "I010" | "P010" = "I010";
const SDR_PIXEL_FORMAT = "nv12";
const HDR_PIXEL_FORMAT: "p010le" | "yuv420p10le" = "yuv420p10le";

const BUTTONS = (chiaki as any).controllerButtons || {
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
};
const ANALOG_BUTTONS = (chiaki as any).controllerAnalogButtons || {
  L2: 1 << 16,
  R2: 1 << 17,
};
const MAX_CONTROLLER_TOUCH_ID = 127;
const MAX_CONTROLLER_TOUCHES = 2;
const CONTROLLER_RESET_RETRY_DELAY_MS = 500;
const BUTTON_NAME_TO_MASK = {
  cross: BUTTONS.CROSS,
  circle: BUTTONS.MOON,
  moon: BUTTONS.MOON,
  square: BUTTONS.BOX,
  box: BUTTONS.BOX,
  triangle: BUTTONS.PYRAMID,
  pyramid: BUTTONS.PYRAMID,
  up: BUTTONS.DPAD_UP,
  dpad_up: BUTTONS.DPAD_UP,
  down: BUTTONS.DPAD_DOWN,
  dpad_down: BUTTONS.DPAD_DOWN,
  left: BUTTONS.DPAD_LEFT,
  dpad_left: BUTTONS.DPAD_LEFT,
  right: BUTTONS.DPAD_RIGHT,
  dpad_right: BUTTONS.DPAD_RIGHT,
  l1: BUTTONS.L1,
  r1: BUTTONS.R1,
  l3: BUTTONS.L3,
  r3: BUTTONS.R3,
  options: BUTTONS.OPTIONS,
  share: BUTTONS.SHARE,
  touchpad: BUTTONS.TOUCHPAD,
  ps: BUTTONS.PS,
  l2: ANALOG_BUTTONS.L2,
  r2: ANALOG_BUTTONS.R2,
};

const WebSocketServerCtor = (WS as any).WebSocketServer || (WS as any).Server;

type FfmpegDesktopTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "win32-x64";

const FFMPEG_BINARY_NAME = IS_WINDOWS ? "ffmpeg.exe" : "ffmpeg";
const FFMPEG_PACKAGE_DIR_BY_TARGET: Record<FfmpegDesktopTarget, string> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64",
  "linux-x64": "linux-x64",
  "win32-x64": "win32-x64",
};

declare const __non_webpack_require__: undefined | ((id: string) => any);
const runtimeRequire =
  typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__
    : // eslint-disable-next-line no-eval
      (0, eval)("require");

type StreamSessionSettings = {
  resolution?: number;
  bitrate?: number;
  bitrate_mode?: string;
  codec?: string;
  fps?: number;
  remote_resolution?: number;
  remote_bitrate?: number;
  remote_bitrate_mode?: string;
  remote_codec?: string;
  remote_fps?: number;
  gamepad_kernel?: unknown;
};

type ClientVideoCapabilities = {
  webCodecs?: boolean;
  preferCompressedVideo?: boolean;
  h264?: boolean;
  hevc?: boolean;
  isSteamOs?: boolean;
};

type ControllerKernel = "web" | "node";

type StreamPixelFormat = typeof SDR_STREAM_FORMAT | typeof HDR_STREAM_FORMAT;

type StartStreamSessionArgs = {
  streamHost?: string;
  host?: string;
  isRemote?: boolean;
  loginInfo?: Record<string, any>;
  settings?: StreamSessionSettings;
  ps5?: boolean;
  enableDualsense?: boolean;
  registKey?: string;
  morning?: string;
  videoProfile?: {
    width?: number;
    height?: number;
    maxFps?: number;
    bitrate?: number;
    codec?: string | number;
  };
  targetWebContents?: WebContents | null;
  clientVideoCapabilities?: ClientVideoCapabilities;
  steamOsWebCodecsProfile?: SteamOsWebCodecsProfile;
  consoleInfo?: {
    rpRegistKey?: string;
    rpKey?: string;
    registKey?: string;
    morning?: string;
    apName?: string;
    hostType?: string;
    isPs5?: boolean;
    serverNickname?: string;
    target?: number;
  };
};

type VideoConfig = {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  codec: number;
  codecName: string;
  format: StreamPixelFormat;
  outputPixelFormat: string;
  isHdr: boolean;
  frameSize: number;
  inputFormat: string;
};

type VideoOutputFormat = {
  format: StreamPixelFormat;
  outputPixelFormat: string;
  isHdr: boolean;
  frameSize: number;
};

type VideoDecoderPlan = {
  name: "software" | "videotoolbox" | "vaapi" | "d3d11va";
  inputOptions: string[];
  filterGraph: string | null;
  inputHighWaterMarkBytes: number;
};

type QueuedVideoSample = {
  id: number;
  data: Buffer;
  isSyncFrame: boolean;
  hasConfig: boolean;
  hasSlice: boolean;
};

type InFlightEncodedVideoSample = {
  id: number;
  sentAtMs: number;
};

type VideoTransportMode = "ffmpeg-rawvideo" | "compressed-webcodecs";

type StreamPerformanceStats = {
  resolution: string;
  rtt: string;
  fps: string;
  fl: string;
  pl: string;
  br: string;
  decode: string;
  decodeAvailable: boolean;
  decodeFrames: number;
  raw: {
    rttMs: number;
    measuredBitrateMbps: number;
    packetLossRatio: number;
    decodedFps: number;
    framesLost: number;
    decodeAvgMs: number;
    decodeFrames: number;
  };
};

const wsClients = new Set<any>();
const wsClientPressedButtons = new Map<any, Set<string>>();

let initialized = false;
let resolvedFfmpegPath: string | null = null;
let streamHttpServer: http.Server | null = null;
let streamWebSocketServer: any = null;
let streamWebSocketPort = 0;
let streamWebContents: WebContents | null = null;

let streamSession: any = null;
let streamSessionStarted = false;

let streamVideoConfig: VideoConfig | null = null;
let ffmpegInput: PassThrough | null = null;
let ffmpegCommand: any = null;
let ffmpegOutput: any = null;
let ffmpegInputBlocked = false;
let activeVideoDecoderPlanName: VideoDecoderPlan["name"] = "software";
let activeVideoTransportMode: VideoTransportMode = "ffmpeg-rawvideo";
let videoDecoderRecoveryInProgress = false;
const pendingVideoSamples: QueuedVideoSample[] = [];
let pendingVideoSampleBytes = 0;
const pendingChunks: Buffer[] = [];
let pendingBytes = 0;
let pendingVideoBroadcastFrame: Buffer | null = null;
let videoBroadcastFlushScheduled = false;
let nativeVideoFramesInFlight = 0;
let nativeVideoFrameInFlightAtMs = 0;
let activeClientIsSteamOs = false;
let activeSteamOsWebCodecsProfile: SteamOsWebCodecsProfile = STEAMOS_WEBCODECS_PROFILE_DEFAULT;
const pendingEncodedVideoSamples: QueuedVideoSample[] = [];
let pendingEncodedVideoSampleBytes = 0;
const nativeEncodedVideoSamplesInFlight: InFlightEncodedVideoSample[] = [];
let waitingForVideoSyncFrame = false;
let cachedVideoConfigSample: Buffer | null = null;
let cachedLinuxVaapiDevicePath: string | null | undefined;
let cachedFfmpegHwaccelsOutput: string | null | undefined;
const disabledVideoDecoderPlans = new Set<VideoDecoderPlan["name"]>();
let decodedFrameCount = 0;
let framesLostCount = 0;
const decodeFrameCostWindowMs: number[] = [];
let decodeFrameCostWindowTotalMs = 0;
let decodedFrameIntervalTotalMs = 0;
let decodedFrameIntervalCount = 0;
let lastDecodedFrameAtMs = 0;
const MAX_DECODE_COST_WINDOW = 240;
let queuedVideoSampleIdNext = 1;

let audioHeaderInfo: null | {
  channels: number;
  bits: number;
  rate: number;
  frameSize: number;
  unknown: number;
} = null;
let audioDecoderInput: PassThrough | null = null;
let audioDecoderCommand: any = null;
let audioDecoderOutput: any = null;
const audioInputQueue: Buffer[] = [];
let audioInputQueuedBytes = 0;
const audioPendingChunks: Buffer[] = [];
let audioPendingBytes = 0;
let audioInputBlocked = false;
let audioChunkBytes = 0;
let audioChannels = 2;
let audioSampleRate = 48000;
let audioFrameSamples = 960;

let oggSerial = 0;
let oggSeq = 0;
let oggGranule = 0n;

type ControllerTouchSnapshot = {
  id: number;
  x: number;
  y: number;
};

type ControllerStateSnapshot = NodeControllerStateSnapshot & {
  touchIdNext: number;
  touches: [ControllerTouchSnapshot, ControllerTouchSnapshot];
};

const controllerState: ControllerStateSnapshot = {
  buttons: 0,
  l2State: 0,
  r2State: 0,
  leftX: 0,
  leftY: 0,
  rightX: 0,
  rightY: 0,
  touchIdNext: 0,
  touches: [
    { id: -1, x: 0, y: 0 },
    { id: -1, x: 0, y: 0 },
  ],
};
const frontendControllerState: ControllerStateSnapshot = {
  buttons: 0,
  l2State: 0,
  r2State: 0,
  leftX: 0,
  leftY: 0,
  rightX: 0,
  rightY: 0,
  touchIdNext: 0,
  touches: [
    { id: -1, x: 0, y: 0 },
    { id: -1, x: 0, y: 0 },
  ],
};
const nodeControllerState: NodeControllerStateSnapshot = {
  buttons: 0,
  l2State: 0,
  r2State: 0,
  leftX: 0,
  leftY: 0,
  rightX: 0,
  rightY: 0,
};
const lastSubmittedControllerState: ControllerStateSnapshot = {
  buttons: 0,
  l2State: 0,
  r2State: 0,
  leftX: 0,
  leftY: 0,
  rightX: 0,
  rightY: 0,
  touchIdNext: 0,
  touches: [
    { id: -1, x: 0, y: 0 },
    { id: -1, x: 0, y: 0 },
  ],
};
let hasSubmittedControllerState = false;
let controllerKernel: ControllerKernel = "node";
let nodeGamepadDriver: ReturnType<typeof createNodeGamepadDriver> | null = null;
const controllerButtonRefCounts = new Map<string, number>();

type ControllerStatePayload = {
  buttons?: unknown;
  l2State?: unknown;
  r2State?: unknown;
  leftX?: unknown;
  leftY?: unknown;
  rightX?: unknown;
  rightY?: unknown;
  touchIdNext?: unknown;
  touches?: unknown;
};
let pendingDirectControllerState: ControllerStatePayload | null = null;
let directControllerStateFlushScheduled = false;
let delayedControllerResetRetryTimer: ReturnType<typeof setTimeout> | null = null;

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let b = 0; b < 8; b += 1) {
      if ((r & 0x80000000) !== 0) {
        r = ((r << 1) ^ 0x04c11db7) >>> 0;
      } else {
        r = (r << 1) >>> 0;
      }
    }
    table[i] = r >>> 0;
  }
  return table;
})();

const log = (...args) => {
  console.log("[stream-service]", ...args);
};

const isExistingFile = (filePath: string) => {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
};

const pushUniqueCandidatePath = (
  paths: string[],
  seen: Set<string>,
  value: string | null | undefined
) => {
  const nextValue = String(value || "").trim();
  if (!nextValue || seen.has(nextValue)) {
    return;
  }

  seen.add(nextValue);
  paths.push(nextValue);
};

const resolveFfmpegDesktopTarget = (): FfmpegDesktopTarget => {
  const target = `${process.platform}-${process.arch}`;
  if (target === "darwin-arm64") return "darwin-arm64";
  if (target === "darwin-x64") return "darwin-x64";
  if (target === "linux-arm64") return "linux-arm64";
  if (target === "linux-x64") return "linux-x64";
  if (target === "win32-x64") return "win32-x64";
  throw new Error(`Unsupported FFmpeg target: ${target}`);
};

const resolvePackagedFfmpegPath = () => {
  const target = resolveFfmpegDesktopTarget();
  const packageDir = FFMPEG_PACKAGE_DIR_BY_TARGET[target];
  return path.resolve(
    String(process.resourcesPath || ""),
    "ffmpeg-installer",
    packageDir,
    FFMPEG_BINARY_NAME
  );
};

const resolveFfmpegPath = () => {
  if (resolvedFfmpegPath && isExistingFile(resolvedFfmpegPath)) {
    return resolvedFfmpegPath;
  }

  const target = resolveFfmpegDesktopTarget();
  const packageDir = FFMPEG_PACKAGE_DIR_BY_TARGET[target];
  const candidatePaths: string[] = [];
  const seen = new Set<string>();
  const envFfmpegPath = String(process.env.PEASYO_FFMPEG_PATH || "").trim();

  pushUniqueCandidatePath(candidatePaths, seen, envFfmpegPath);
  if (IS_LINUX) {
    pushUniqueCandidatePath(candidatePaths, seen, "/app/bin/ffmpeg");
  }
  pushUniqueCandidatePath(candidatePaths, seen, resolvePackagedFfmpegPath());
  pushUniqueCandidatePath(
    candidatePaths,
    seen,
    path.resolve(
      String(process.resourcesPath || ""),
      "app.asar.unpacked",
      "node_modules",
      "@ffmpeg-installer",
      packageDir,
      FFMPEG_BINARY_NAME
    )
  );
  pushUniqueCandidatePath(
    candidatePaths,
    seen,
    path.resolve(process.cwd(), "node_modules", "@ffmpeg-installer", packageDir, FFMPEG_BINARY_NAME)
  );
  pushUniqueCandidatePath(
    candidatePaths,
    seen,
    path.resolve(__dirname, "..", "..", "node_modules", "@ffmpeg-installer", packageDir, FFMPEG_BINARY_NAME)
  );

  try {
    const installer = runtimeRequire("@ffmpeg-installer/ffmpeg");
    const installerPath = String(installer?.path || "").trim();
    pushUniqueCandidatePath(candidatePaths, seen, installerPath);
    if (installerPath.includes("app.asar")) {
      pushUniqueCandidatePath(
        candidatePaths,
        seen,
        installerPath.replace("app.asar", "app.asar.unpacked")
      );
    }
  } catch {
    // Ignore lookup failures here and continue with explicit path probing.
  }

  for (const candidatePath of candidatePaths) {
    if (!isExistingFile(candidatePath)) {
      continue;
    }

    resolvedFfmpegPath = candidatePath;
    return candidatePath;
  }

  throw new Error(
    `FFmpeg executable was not found for target '${target}'. Tried:\n- ${candidatePaths.join("\n- ")}`
  );
};

const readFfmpegCommandOutput = (args: string[]) => {
  const ffmpegPath = resolveFfmpegPath();
  const result = spawnSync(ffmpegPath, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });

  if (result.error) {
    log("ffmpeg probe failed:", result.error.message);
    return "";
  }

  return `${result.stdout || ""}\n${result.stderr || ""}`;
};

const getFfmpegHwaccelsOutput = () => {
  if (cachedFfmpegHwaccelsOutput !== undefined) {
    return cachedFfmpegHwaccelsOutput;
  }

  cachedFfmpegHwaccelsOutput = readFfmpegCommandOutput(["-hide_banner", "-hwaccels"]);
  return cachedFfmpegHwaccelsOutput;
};

const resolveLinuxVaapiDevicePath = () => {
  if (!IS_LINUX) {
    return null;
  }

  if (cachedLinuxVaapiDevicePath !== undefined) {
    return cachedLinuxVaapiDevicePath;
  }

  const envDevicePath = String(process.env.PEASYO_VAAPI_DEVICE || "").trim();
  if (envDevicePath && isExistingFile(envDevicePath)) {
    cachedLinuxVaapiDevicePath = envDevicePath;
    return cachedLinuxVaapiDevicePath;
  }

  try {
    const renderNodes = readdirSync("/dev/dri")
      .filter((entry) => /^renderD\d+$/.test(entry))
      .sort();
    if (renderNodes.length > 0) {
      cachedLinuxVaapiDevicePath = path.join("/dev/dri", renderNodes[0]);
      return cachedLinuxVaapiDevicePath;
    }
  } catch {
    // Ignore missing /dev/dri and fall back to software decode.
  }

  cachedLinuxVaapiDevicePath = null;
  return cachedLinuxVaapiDevicePath;
};

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const resolveSteamOsWebCodecsProfile = (value: unknown): SteamOsWebCodecsProfile => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (
    normalized === "balanced" ||
    normalized === "stable" ||
    normalized === "ultra-stable"
  ) {
    return normalized;
  }
  return STEAMOS_WEBCODECS_PROFILE_DEFAULT;
};

const getNativeEncodedVideoSamplesInFlightLimit = () => {
  if (!activeClientIsSteamOs) {
    return 1;
  }

  return STEAMOS_NATIVE_ENCODED_VIDEO_SAMPLES_IN_FLIGHT[activeSteamOsWebCodecsProfile];
};

const resolvePsnAccountId = (loginInfo: Record<string, any> | undefined) => {
  return String(
    loginInfo?.userInfo?.account_id ||
    loginInfo?.account_id ||
    ""
  ).trim();
};

const serializeSessionEventValue = (value: any, depth = 0): any => {
  if (depth > 3) {
    return "[MaxDepth]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    if (value.length <= 16) {
      return `Buffer(${value.length}):${value.toString("hex")}`;
    }
    return `Buffer(${value.length})`;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => serializeSessionEventValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const result: Record<string, any> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] = serializeSessionEventValue(nestedValue, depth + 1);
    }
    return result;
  }

  return value;
};

const serializeSessionEvent = (event: any) => {
  return serializeSessionEventValue(event, 0);
};

const ensureInitialized = () => {
  if (initialized) return;

  const nextFfmpegPath = resolveFfmpegPath();
  ffmpeg.setFfmpegPath(nextFfmpegPath);
  log("using ffmpeg binary:", nextFfmpegPath);

  if (typeof (chiaki as any).init === "function") {
    (chiaki as any).init();
  }

  initialized = true;
};

const resolveResolution = (resolution: number) => {
  if (resolution >= 1080) return { width: 1920, height: 1080 };
  if (resolution >= 720) return { width: 1280, height: 720 };
  if (resolution >= 540) return { width: 960, height: 540 };
  return { width: 640, height: 360 };
};

const getAutoBitrateForResolution = (resolution: number) => {
  if (resolution >= 1080) return 27000;
  if (resolution >= 720) return 10000;
  if (resolution >= 540) return 6000;
  return 2000;
};

const normalizeBitrateMode = (mode: unknown) => {
  return String(mode || "auto").toLowerCase() === "custom" ? "custom" : "auto";
};

const ensureBitrateForMode = (
  resolution: number,
  bitrateMode: unknown,
  bitrate: unknown
) => {
  if (normalizeBitrateMode(bitrateMode) === "custom") {
    const parsed = Math.round(Number(bitrate));
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(100000, Math.max(1000, parsed));
    }
  }

  return getAutoBitrateForResolution(resolution);
};

const codecName = (codec: number) => {
  if (codec === (chiaki as any).codecs.H265) return "H265";
  if (codec === (chiaki as any).codecs.H265_HDR) return "H265_HDR";
  if (codec === (chiaki as any).codecs.H264) return "H264";
  return String(codec);
};

const resolveCodec = (codec: string | number | undefined) => {
  if (typeof codec === "number") {
    return codec;
  }

  const raw = String(codec || "H265").toUpperCase();
  if (raw.includes("264")) {
    return (chiaki as any).codecs.H264;
  }
  if (raw.includes("HDR")) {
    return (chiaki as any).codecs.H265_HDR;
  }
  return (chiaki as any).codecs.H265;
};

const resolvePlatformCodec = (codec: number) => {
  if (IS_LINUX && codec === (chiaki as any).codecs.H265_HDR) {
    return (chiaki as any).codecs.H265;
  }
  return codec;
};

const CHIAKI_PS5_TARGET_FLOOR = 1000000;

const inferPs5FlagFromText = (value: unknown) => {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized.includes("PS5")) {
    return true;
  }

  if (normalized.includes("PS4")) {
    return false;
  }

  return undefined;
};

const resolveSessionPs5Flag = (
  argsPs5: boolean | undefined,
  consoleInfo: {
    apName?: string;
    hostType?: string;
    isPs5?: boolean;
    serverNickname?: string;
    target?: number;
  }
) => {
  if (typeof argsPs5 === "boolean") {
    return argsPs5;
  }

  const numericTarget = Number(consoleInfo.target);
  if (Number.isFinite(numericTarget) && numericTarget > 0) {
    return numericTarget >= CHIAKI_PS5_TARGET_FLOOR;
  }

  if (typeof consoleInfo.isPs5 === "boolean") {
    return consoleInfo.isPs5;
  }

  for (const value of [
    consoleInfo.hostType,
    consoleInfo.apName,
    consoleInfo.serverNickname,
  ]) {
    const inferred = inferPs5FlagFromText(value);
    if (typeof inferred === "boolean") {
      return inferred;
    }
  }

  throw new Error(
    "Unable to determine whether the cached host is PS4 or PS5. Please rediscover or re-register the console."
  );
};

const resolveInputFormat = (codec: number) => {
  if (codec === (chiaki as any).codecs.H265 || codec === (chiaki as any).codecs.H265_HDR) {
    return "hevc";
  }
  if (codec === (chiaki as any).codecs.H264) {
    return "h264";
  }
  return "h264";
};

const getSoftwareVideoDecoderInputOptions = () => {
  const options: string[] = ["-fflags +genpts", "-probesize 32", "-analyzeduration 0"];
  const inputFormat = streamVideoConfig?.inputFormat;

  if (IS_WINDOWS) {
    // Keep decoder queue shallow to reduce frame-thread reordering latency.
    options.push("-threads 1");
  }

  if (IS_LINUX && inputFormat === "hevc") {
    // Let FFmpeg autoscale Linux HEVC decode threads to avoid bitrate-driven latency growth.
    options.push("-threads 0");
  }

  return options;
};

const hasFfmpegHwaccel = (name: string) => {
  const hwaccelsOutput = getFfmpegHwaccelsOutput();
  if (!hwaccelsOutput) {
    return false;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(hwaccelsOutput);
};

const getPlatformVideoDecoderPreference = () => {
  const globalPreference = String(process.env.PEASYO_VIDEO_DECODER || "")
    .trim()
    .toLowerCase();

  const platformPreference = String(
    IS_WINDOWS
      ? process.env.PEASYO_WINDOWS_VIDEO_DECODER || ""
      : IS_LINUX
        ? process.env.PEASYO_LINUX_VIDEO_DECODER || ""
        : process.env.PEASYO_MACOS_VIDEO_DECODER || ""
  )
    .trim()
    .toLowerCase();

  return platformPreference || globalPreference || "auto";
};

const getPlatformVideoTransportPreference = () => {
  const globalPreference = String(process.env.PEASYO_VIDEO_TRANSPORT || "")
    .trim()
    .toLowerCase();

  const platformPreference = String(
    IS_WINDOWS
      ? process.env.PEASYO_WINDOWS_VIDEO_TRANSPORT || ""
      : IS_LINUX
        ? process.env.PEASYO_LINUX_VIDEO_TRANSPORT || ""
        : process.env.PEASYO_MACOS_VIDEO_TRANSPORT || ""
  )
    .trim()
    .toLowerCase();

  return platformPreference || globalPreference || "auto";
};

const isCompressedVideoTransportActive = () => {
  return activeVideoTransportMode === "compressed-webcodecs";
};

const shouldUseCompressedVideoTransport = (args: StartStreamSessionArgs) => {
  if (!streamVideoConfig) {
    return false;
  }

  const transportPreference = getPlatformVideoTransportPreference();
  if (
    transportPreference === "raw" ||
    transportPreference === "ffmpeg" ||
    transportPreference === "software"
  ) {
    return false;
  }

  if (
    transportPreference !== "auto" &&
    transportPreference !== "webcodecs" &&
    transportPreference !== "compressed"
  ) {
    return false;
  }

  const capabilities = args.clientVideoCapabilities || {};
  if (!capabilities.webCodecs) {
    return false;
  }

  return streamVideoConfig.inputFormat === "hevc"
    ? !!capabilities.hevc
    : !!capabilities.h264;
};

const canUseLinuxVaapiDecoder = () => {
  if (!IS_LINUX || !streamVideoConfig) {
    return false;
  }
  if (disabledVideoDecoderPlans.has("vaapi")) {
    return false;
  }

  const preference = getPlatformVideoDecoderPreference();
  if (preference === "software") {
    return false;
  }
  if (preference !== "auto" && preference !== "vaapi") {
    return false;
  }

  if (!hasFfmpegHwaccel("vaapi")) {
    return false;
  }

  return !!resolveLinuxVaapiDevicePath();
};

const canUseWindowsD3d11vaDecoder = () => {
  if (!IS_WINDOWS || !streamVideoConfig) {
    return false;
  }
  if (disabledVideoDecoderPlans.has("d3d11va")) {
    return false;
  }

  const preference = getPlatformVideoDecoderPreference();
  if (preference === "software") {
    return false;
  }
  if (preference !== "auto" && preference !== "d3d11va") {
    return false;
  }

  return hasFfmpegHwaccel("d3d11va");
};

const canUseMacosVideotoolboxDecoder = () => {
  if (!IS_MACOS || !streamVideoConfig) {
    return false;
  }
  if (disabledVideoDecoderPlans.has("videotoolbox")) {
    return false;
  }

  const preference = getPlatformVideoDecoderPreference();
  if (preference === "software") {
    return false;
  }
  if (preference !== "auto" && preference !== "videotoolbox") {
    return false;
  }

  return hasFfmpegHwaccel("videotoolbox");
};

const getVideoDecoderInputHighWatermarkBytes = () => {
  if (!streamVideoConfig) {
    return VIDEO_DECODER_INPUT_HIGH_WATERMARK_BYTES;
  }

  if (IS_LINUX && streamVideoConfig.isHdr) {
    return 512 * 1024;
  }

  return VIDEO_DECODER_INPUT_HIGH_WATERMARK_BYTES;
};

const buildVideoDecoderPlan = (): VideoDecoderPlan => {
  const softwarePlan: VideoDecoderPlan = {
    name: "software",
    inputOptions: getSoftwareVideoDecoderInputOptions(),
    filterGraph: null,
    inputHighWaterMarkBytes: getVideoDecoderInputHighWatermarkBytes(),
  };

  if (!streamVideoConfig) {
    return softwarePlan;
  }

  if (canUseWindowsD3d11vaDecoder()) {
    return {
      name: "d3d11va",
      inputOptions: [
        "-fflags +genpts",
        "-probesize 32",
        "-analyzeduration 0",
        "-threads 1",
        "-hwaccel d3d11va",
        "-hwaccel_output_format d3d11",
      ],
      filterGraph: `hwdownload,format=${streamVideoConfig.outputPixelFormat}`,
      inputHighWaterMarkBytes: getVideoDecoderInputHighWatermarkBytes(),
    };
  }

  if (canUseMacosVideotoolboxDecoder()) {
    return {
      name: "videotoolbox",
      inputOptions: [
        "-fflags +genpts",
        "-probesize 32",
        "-analyzeduration 0",
        "-threads 1",
        "-hwaccel videotoolbox",
      ],
      filterGraph: null,
      inputHighWaterMarkBytes: getVideoDecoderInputHighWatermarkBytes(),
    };
  }

  if (!canUseLinuxVaapiDecoder()) {
    return softwarePlan;
  }

  const vaapiDevicePath = resolveLinuxVaapiDevicePath();
  if (!vaapiDevicePath) {
    return softwarePlan;
  }

  return {
    name: "vaapi",
    inputOptions: [
      "-fflags +genpts",
      "-probesize 32",
      "-analyzeduration 0",
      "-threads 1",
      "-hwaccel vaapi",
      "-hwaccel_output_format vaapi",
      `-vaapi_device ${vaapiDevicePath}`,
    ],
    filterGraph: `hwdownload,format=${streamVideoConfig.outputPixelFormat}`,
    inputHighWaterMarkBytes: getVideoDecoderInputHighWatermarkBytes(),
  };
};

const inspectVideoSample = (sampleData: Buffer): QueuedVideoSample => {
  const inputFormat = streamVideoConfig?.inputFormat || "h264";
  let hasConfig = false;
  let hasSlice = false;
  let isSyncFrame = false;

  const length = sampleData.length;
  const inspectNalAt = (nalOffset: number) => {
    if (nalOffset < 0 || nalOffset >= length) {
      return;
    }

    if (inputFormat === "hevc") {
      if (nalOffset + 1 >= length) {
        return;
      }
      const nalType = (sampleData[nalOffset] >> 1) & 0x3f;
      if (nalType >= 0 && nalType <= 31) {
        hasSlice = true;
      }
      if (nalType >= 16 && nalType <= 21) {
        isSyncFrame = true;
      }
      if (nalType === 32 || nalType === 33 || nalType === 34) {
        hasConfig = true;
      }
      return;
    }

    const nalType = sampleData[nalOffset] & 0x1f;
    if (nalType === 1 || nalType === 2 || nalType === 5) {
      hasSlice = true;
    }
    if (nalType === 5) {
      isSyncFrame = true;
    }
    if (nalType === 7 || nalType === 8) {
      hasConfig = true;
    }
  };

  let foundAnnexBStartCode = false;
  let cursor = 0;
  while (cursor + 4 <= length) {
    let start = -1;
    let nalOffset = -1;

    for (let i = cursor; i + 3 < length; i += 1) {
      if (sampleData[i] !== 0 || sampleData[i + 1] !== 0) {
        continue;
      }
      if (sampleData[i + 2] === 1) {
        start = i;
        nalOffset = i + 3;
        break;
      }
      if (sampleData[i + 2] === 0 && sampleData[i + 3] === 1) {
        start = i;
        nalOffset = i + 4;
        break;
      }
    }

    if (start < 0 || nalOffset < 0 || nalOffset >= length) {
      break;
    }
    foundAnnexBStartCode = true;
    inspectNalAt(nalOffset);

    cursor = nalOffset + 1;
  }

  if (!foundAnnexBStartCode) {
    let lpCursor = 0;
    while (lpCursor + 4 <= length) {
      const nalSize = sampleData.readUInt32BE(lpCursor);
      lpCursor += 4;
      if (nalSize < 1 || lpCursor + nalSize > length) {
        break;
      }
      inspectNalAt(lpCursor);
      lpCursor += nalSize;
    }
  }

  return {
    id: queuedVideoSampleIdNext++,
    data: sampleData,
    isSyncFrame,
    hasConfig,
    hasSlice,
  };
};

const getMaxPendingVideoSampleBytes = () => {
  const bitrateMbps = Number(streamVideoConfig?.bitrate || 0) / 1000;
  const targetSeconds = IS_LINUX && streamVideoConfig?.isHdr
    ? Math.min(MAX_PENDING_VIDEO_SAMPLE_SECONDS, 0.18)
    : MAX_PENDING_VIDEO_SAMPLE_SECONDS;
  const targetBytes =
    bitrateMbps > 0 ? Math.round((bitrateMbps * 1024 * 1024) * targetSeconds / 8) : 0;
  if (IS_LINUX && streamVideoConfig?.inputFormat === "hevc") {
    const linuxHevcMinBytes = 160 * 1024;
    const linuxHevcMaxBytes = 384 * 1024;
    return Math.max(
      linuxHevcMinBytes,
      Math.min(linuxHevcMaxBytes, targetBytes || linuxHevcMinBytes)
    );
  }
  const maxBytes = IS_LINUX && streamVideoConfig?.isHdr ? 1024 * 1024 : MAX_PENDING_VIDEO_SAMPLE_BYTES_MAX;
  const minBytes = IS_LINUX && streamVideoConfig?.isHdr ? 256 * 1024 : MAX_PENDING_VIDEO_SAMPLE_BYTES_MIN;
  return Math.max(
    minBytes,
    Math.min(maxBytes, targetBytes || minBytes)
  );
};

const shouldResyncVideoDecoderOnBacklog = () => {
  return !!streamVideoConfig;
};

const clearPendingVideoSampleQueue = () => {
  pendingVideoSamples.length = 0;
  pendingVideoSampleBytes = 0;
  waitingForVideoSyncFrame = false;
};

const enqueueVideoSample = (sample: QueuedVideoSample) => {
  pendingVideoSamples.push(sample);
  pendingVideoSampleBytes += sample.data.length;
};

const shiftPendingVideoSample = () => {
  const sample = pendingVideoSamples.shift() || null;
  if (sample) {
    pendingVideoSampleBytes -= sample.data.length;
    if (pendingVideoSampleBytes < 0) {
      pendingVideoSampleBytes = 0;
    }
  }
  return sample;
};

const keepSamplesFromLatestSyncOrTail = (samples: QueuedVideoSample[], tailCount = 16) => {
  let syncIndex = -1;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (samples[i].isSyncFrame) {
      syncIndex = i;
      break;
    }
  }

  if (syncIndex >= 0) {
    return samples.slice(syncIndex);
  }

  if (samples.length <= tailCount) {
    return samples.slice();
  }

  return samples.slice(samples.length - tailCount);
};

const recreateVideoDecodePipelineForSync = (reason: string) => {
  const keptSamples = pendingVideoSamples.slice();
  const nextQueue = keepSamplesFromLatestSyncOrTail(keptSamples);

  destroyVideoPipeline();
  createVideoDecodePipeline();

  clearPendingVideoSampleQueue();

  if (cachedVideoConfigSample && (nextQueue.length < 1 || !nextQueue[0].hasConfig)) {
    enqueueVideoSample({
      id: queuedVideoSampleIdNext++,
      data: Buffer.from(cachedVideoConfigSample),
      isSyncFrame: false,
      hasConfig: true,
      hasSlice: false,
    });
  }

  for (const sample of nextQueue) {
    enqueueVideoSample(sample);
  }

  waitingForVideoSyncFrame = nextQueue.length < 1;
  log(
    waitingForVideoSyncFrame
      ? `video decoder resync requested (${reason}), waiting for next sync frame`
      : `video decoder resynced from latest sync frame (${reason})`
  );
};

const fallbackVideoDecoderToSoftware = (reason: string) => {
  if (videoDecoderRecoveryInProgress || activeVideoDecoderPlanName === "software") {
    return;
  }

  videoDecoderRecoveryInProgress = true;
  const failedPlan = activeVideoDecoderPlanName;
  const keptSamples = pendingVideoSamples.slice();
  const nextQueue = keepSamplesFromLatestSyncOrTail(keptSamples);
  disabledVideoDecoderPlans.add(failedPlan);
  log(
    `video decoder '${failedPlan}' failed (${reason}), falling back to software decode`
  );

  destroyVideoPipeline();
  createVideoDecodePipeline();

  clearPendingVideoSampleQueue();

  if (cachedVideoConfigSample && (nextQueue.length < 1 || !nextQueue[0].hasConfig)) {
    enqueueVideoSample({
      id: queuedVideoSampleIdNext++,
      data: Buffer.from(cachedVideoConfigSample),
      isSyncFrame: false,
      hasConfig: true,
      hasSlice: false,
    });
  }

  for (const sample of nextQueue) {
    enqueueVideoSample(sample);
  }

  waitingForVideoSyncFrame = nextQueue.length < 1;
  videoDecoderRecoveryInProgress = false;

  if (pendingVideoSamples.length > 0) {
    flushPendingVideoSamples();
  }
};

const resolveOutputFormat = (
  codec: number,
  width: number,
  height: number
): VideoOutputFormat => {
  const isHdr = codec === (chiaki as any).codecs.H265_HDR;
  return {
    format: isHdr ? HDR_STREAM_FORMAT : SDR_STREAM_FORMAT,
    outputPixelFormat: isHdr ? HDR_PIXEL_FORMAT : SDR_PIXEL_FORMAT,
    isHdr,
    frameSize: isHdr ? width * height * 3 : Math.floor((width * height * 3) / 2),
  };
};

const normalizeButtonName = (buttonName: unknown) => {
  const key = String(buttonName || "").trim().toLowerCase();
  return BUTTON_NAME_TO_MASK[key] ? key : null;
};

const clampInt = (value: unknown, min: number, max: number) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  if (numeric < min) return min;
  if (numeric > max) return max;
  return Math.trunc(numeric);
};

const normalizeTouchPoint = (touch: unknown): ControllerTouchSnapshot => {
  const rawTouch = touch && typeof touch === "object" ? (touch as Record<string, unknown>) : {};
  const id = clampInt(rawTouch.id, -1, MAX_CONTROLLER_TOUCH_ID);
  if (id < 0) {
    return {
      id: -1,
      x: 0,
      y: 0,
    };
  }

  return {
    id,
    x: clampInt(rawTouch.x, 0, 0xffff),
    y: clampInt(rawTouch.y, 0, 0xffff),
  };
};

const copyTouchPoint = (target: ControllerTouchSnapshot, source: ControllerTouchSnapshot) => {
  target.id = source.id;
  target.x = source.x;
  target.y = source.y;
};

const isSameTouchPoint = (left: ControllerTouchSnapshot, right: ControllerTouchSnapshot) => {
  return left.id === right.id && left.x === right.x && left.y === right.y;
};

const resetNodeControllerState = (state: NodeControllerStateSnapshot) => {
  state.buttons = 0;
  state.l2State = 0;
  state.r2State = 0;
  state.leftX = 0;
  state.leftY = 0;
  state.rightX = 0;
  state.rightY = 0;
};

const resetControllerState = (state: ControllerStateSnapshot) => {
  resetNodeControllerState(state);
  state.touchIdNext = 0;
  state.touches[0].id = -1;
  state.touches[0].x = 0;
  state.touches[0].y = 0;
  state.touches[1].id = -1;
  state.touches[1].x = 0;
  state.touches[1].y = 0;
};

const copyNodeControllerState = (
  target: NodeControllerStateSnapshot,
  source: NodeControllerStateSnapshot
) => {
  target.buttons = source.buttons;
  target.l2State = source.l2State;
  target.r2State = source.r2State;
  target.leftX = source.leftX;
  target.leftY = source.leftY;
  target.rightX = source.rightX;
  target.rightY = source.rightY;
};

const copyControllerState = (target: ControllerStateSnapshot, source: ControllerStateSnapshot) => {
  copyNodeControllerState(target, source);
  target.touchIdNext = source.touchIdNext;
  copyTouchPoint(target.touches[0], source.touches[0]);
  copyTouchPoint(target.touches[1], source.touches[1]);
};

const isSameNodeControllerState = (
  left: NodeControllerStateSnapshot,
  right: NodeControllerStateSnapshot
) => {
  return (
    left.buttons === right.buttons &&
    left.l2State === right.l2State &&
    left.r2State === right.r2State &&
    left.leftX === right.leftX &&
    left.leftY === right.leftY &&
    left.rightX === right.rightX &&
    left.rightY === right.rightY
  );
};

const isSameControllerState = (left: ControllerStateSnapshot, right: ControllerStateSnapshot) => {
  return (
    isSameNodeControllerState(left, right) &&
    left.touchIdNext === right.touchIdNext &&
    isSameTouchPoint(left.touches[0], right.touches[0]) &&
    isSameTouchPoint(left.touches[1], right.touches[1])
  );
};

const isNeutralControllerState = (state: ControllerStateSnapshot) => {
  if (
    state.buttons !== 0 ||
    state.l2State !== 0 ||
    state.r2State !== 0 ||
    state.leftX !== 0 ||
    state.leftY !== 0 ||
    state.rightX !== 0 ||
    state.rightY !== 0
  ) {
    return false;
  }

  return state.touches.every((touch) => touch.id < 0);
};

const clearDelayedControllerResetRetry = () => {
  if (delayedControllerResetRetryTimer) {
    clearTimeout(delayedControllerResetRetryTimer);
    delayedControllerResetRetryTimer = null;
  }
};

const setNormalizedNodeControllerState = (
  target: NodeControllerStateSnapshot,
  state: NodeControllerStateSnapshot | ControllerStatePayload
) => {
  target.buttons = clampInt((state as any).buttons, 0, 0xffffffff) >>> 0;
  target.l2State = clampInt((state as any).l2State, 0, 255);
  target.r2State = clampInt((state as any).r2State, 0, 255);
  target.leftX = clampInt((state as any).leftX, -32768, 32767);
  target.leftY = clampInt((state as any).leftY, -32768, 32767);
  target.rightX = clampInt((state as any).rightX, -32768, 32767);
  target.rightY = clampInt((state as any).rightY, -32768, 32767);
};

const setNormalizedTouchState = (
  target: ControllerStateSnapshot,
  state: ControllerStatePayload | ControllerStateSnapshot
) => {
  target.touchIdNext = clampInt((state as any).touchIdNext, 0, MAX_CONTROLLER_TOUCH_ID);
  const touches = Array.isArray((state as any).touches) ? (state as any).touches : [];
  for (let i = 0; i < MAX_CONTROLLER_TOUCHES; i += 1) {
    const slot = i as 0 | 1;
    copyTouchPoint(target.touches[slot], normalizeTouchPoint(touches[i]));
  }
};

const setNormalizedControllerState = (
  target: ControllerStateSnapshot,
  state: ControllerStatePayload | ControllerStateSnapshot
) => {
  setNormalizedNodeControllerState(target, state);
  setNormalizedTouchState(target, state);
};

const mergeAxisInput = (primary: number, secondary: number) => {
  return Math.abs(primary) >= Math.abs(secondary) ? primary : secondary;
};

const buildEffectiveControllerState = (): ControllerStateSnapshot => {
  if (controllerKernel !== "node") {
    return {
      ...frontendControllerState,
      touches: [
        { ...frontendControllerState.touches[0] },
        { ...frontendControllerState.touches[1] },
      ],
    };
  }

  const merged: ControllerStateSnapshot = {
    buttons: (frontendControllerState.buttons | nodeControllerState.buttons) >>> 0,
    l2State: Math.max(frontendControllerState.l2State, nodeControllerState.l2State),
    r2State: Math.max(frontendControllerState.r2State, nodeControllerState.r2State),
    leftX: mergeAxisInput(frontendControllerState.leftX, nodeControllerState.leftX),
    leftY: mergeAxisInput(frontendControllerState.leftY, nodeControllerState.leftY),
    rightX: mergeAxisInput(frontendControllerState.rightX, nodeControllerState.rightX),
    rightY: mergeAxisInput(frontendControllerState.rightY, nodeControllerState.rightY),
    touchIdNext: frontendControllerState.touchIdNext,
    touches: [
      { ...frontendControllerState.touches[0] },
      { ...frontendControllerState.touches[1] },
    ],
  };

  if (merged.l2State > 0) {
    merged.buttons |= ANALOG_BUTTONS.L2;
  }
  if (merged.r2State > 0) {
    merged.buttons |= ANALOG_BUTTONS.R2;
  }

  return merged;
};

const pushControllerState = (reason: string, options?: { force?: boolean }) => {
  if (!streamSession || !streamSessionStarted) {
    return;
  }

  if (
    !options?.force &&
    hasSubmittedControllerState &&
    isSameControllerState(controllerState, lastSubmittedControllerState)
  ) {
    return;
  }

  try {
    streamSession.setControllerState(controllerState);
    copyControllerState(lastSubmittedControllerState, controllerState);
    hasSubmittedControllerState = true;
  } catch (error: any) {
    log(`setControllerState failed (${reason}):`, error?.message || String(error));
  }
};

const applyEffectiveControllerState = (reason: string) => {
  const nextState = buildEffectiveControllerState();

  if (isSameControllerState(controllerState, nextState)) {
    return;
  }

  copyControllerState(controllerState, nextState);
  pushControllerState(reason);

  if (isNeutralControllerState(controllerState)) {
    clearDelayedControllerResetRetry();
    delayedControllerResetRetryTimer = setTimeout(() => {
      delayedControllerResetRetryTimer = null;

      if (!streamSession || !streamSessionStarted) {
        return;
      }

      if (!isNeutralControllerState(controllerState)) {
        return;
      }

      // Retry one neutral packet after a short delay to reduce sticky inputs
      // when a release packet gets dropped in transport/session handling.
      pushControllerState("neutral-reset-retry", { force: true });
    }, CONTROLLER_RESET_RETRY_DELAY_MS);
  } else {
    clearDelayedControllerResetRetry();
  }
};

const applyNodeControllerState = (state: NodeControllerStateSnapshot, reason: string) => {
  setNormalizedNodeControllerState(nodeControllerState, state);
  applyEffectiveControllerState(reason);
};

const resolveControllerKernel = (settings: StreamSessionSettings | null | undefined): ControllerKernel => {
  const normalizedKernel = String(settings?.gamepad_kernel || "").trim().toLowerCase();
  if (normalizedKernel === "web" || normalizedKernel === "node") {
    return normalizedKernel;
  }

  return "node";
};

const stopNodeGamepadDriver = () => {
  if (!nodeGamepadDriver) {
    resetNodeControllerState(nodeControllerState);
    return;
  }

  nodeGamepadDriver.stop();
  nodeGamepadDriver = null;
  resetNodeControllerState(nodeControllerState);
};

const startNodeGamepadDriver = () => {
  if (controllerKernel !== "node") {
    stopNodeGamepadDriver();
    return;
  }

  if (!nodeGamepadDriver) {
    nodeGamepadDriver = createNodeGamepadDriver({
      onStateChange: (state) => {
        applyNodeControllerState(state, "node-sdl:state");
      },
      onError: (error) => {
        log("node-sdl driver error:", error?.message || String(error));
      },
      onLog: (message) => {
        log(message);
      },
    });
  }

  const started = nodeGamepadDriver.start();
  if (!started) {
    log("node-sdl driver unavailable, node kernel will run without native gamepad input.");
    stopNodeGamepadDriver();
  }
};

const configureControllerKernel = (settings: StreamSessionSettings | null | undefined) => {
  controllerKernel = resolveControllerKernel(settings);
  if (controllerKernel === "node") {
    startNodeGamepadDriver();
  } else {
    stopNodeGamepadDriver();
  }

  applyEffectiveControllerState("controller-kernel:init");
  log(`controller kernel: ${controllerKernel}`);
};

const triggerNativeGamepadRumble = (data: {
  low?: unknown;
  high?: unknown;
  durationMs?: unknown;
}) => {
  if (controllerKernel !== "node" || !nodeGamepadDriver) {
    return {
      ok: false,
      reason: "controller-kernel-not-node",
    };
  }

  return nodeGamepadDriver.rumble(data || {});
};

const setControllerButtonState = (key: string, pressed: boolean) => {
  const mask = BUTTON_NAME_TO_MASK[key];
  if (!mask) {
    return;
  }

  if (pressed) {
    frontendControllerState.buttons |= mask;
  } else {
    frontendControllerState.buttons &= ~mask;
  }

  if (key === "l2") {
    frontendControllerState.l2State = pressed ? 0xff : 0;
  } else if (key === "r2") {
    frontendControllerState.r2State = pressed ? 0xff : 0;
  }
};

const updateControllerStateFromClient = (socket: any, key: string, pressed: boolean) => {
  const isPressed = !!pressed;
  const pressedButtons = wsClientPressedButtons.get(socket);
  if (!pressedButtons) {
    return false;
  }

  const refCount = controllerButtonRefCounts.get(key) || 0;
  if (isPressed) {
    if (pressedButtons.has(key)) {
      return false;
    }
    pressedButtons.add(key);
    controllerButtonRefCounts.set(key, refCount + 1);
    if (refCount === 0) {
      setControllerButtonState(key, true);
      return true;
    }
    return false;
  }

  if (!pressedButtons.has(key)) {
    return false;
  }

  pressedButtons.delete(key);
  if (refCount <= 1) {
    controllerButtonRefCounts.delete(key);
    if (refCount === 1) {
      setControllerButtonState(key, false);
      return true;
    }
    return false;
  }

  controllerButtonRefCounts.set(key, refCount - 1);
  return false;
};

const releaseClientPressedButtons = (socket: any, reason: string) => {
  const pressedButtons = wsClientPressedButtons.get(socket);
  if (!pressedButtons || pressedButtons.size < 1) {
    return;
  }

  let changed = false;
  const keys = Array.from(pressedButtons);
  for (const key of keys) {
    const refCount = controllerButtonRefCounts.get(key) || 0;
    pressedButtons.delete(key);
    if (refCount <= 1) {
      controllerButtonRefCounts.delete(key);
      if (refCount === 1) {
        setControllerButtonState(key, false);
        changed = true;
      }
    } else {
      controllerButtonRefCounts.set(key, refCount - 1);
    }
  }

  if (changed) {
    applyEffectiveControllerState(reason);
  }
};

const sendWsText = (client: any, payload: unknown) => {
  if (!client || client.readyState !== 1) {
    return;
  }
  try {
    client.send(JSON.stringify(payload));
  } catch {
    // ignore socket send failures
  }
};

const broadcastText = (payload: unknown) => {
  for (const client of wsClients) {
    sendWsText(client, payload);
  }
};

const sendVideoConfigToClient = (client: any) => {
  if (!streamVideoConfig) {
    return;
  }

  sendWsText(client, {
    type: "config",
    width: streamVideoConfig.width,
    height: streamVideoConfig.height,
    fps: streamVideoConfig.fps,
    format: streamVideoConfig.format,
    frameSize: streamVideoConfig.frameSize,
    transport: activeVideoTransportMode,
    codecName: streamVideoConfig.codecName,
    inputFormat: streamVideoConfig.inputFormat,
  });
};

const sendAudioConfigToClient = (client: any) => {
  if (!audioHeaderInfo) {
    sendWsText(client, {
      type: "audio_config",
      enabled: false,
    });
    return;
  }

  sendWsText(client, {
    type: "audio_config",
    enabled: true,
    channels: audioHeaderInfo.channels,
    bits: audioHeaderInfo.bits,
    rate: audioHeaderInfo.rate,
    frameSamples: audioHeaderInfo.frameSize,
    pcmFormat: "f32le",
    interleaved: true,
  });
};

const broadcastAudioConfig = () => {
  for (const client of wsClients) {
    sendAudioConfigToClient(client);
  }
};

const canUseNativeStreamBinary = () => {
  return !!streamWebContents && !streamWebContents.isDestroyed();
};

const postNativeTypedBinary = (kind: number, payload: Buffer) => {
  if (!payload || payload.length < 1 || !canUseNativeStreamBinary()) {
    return false;
  }

  try {
    const webContents = streamWebContents as WebContents;
    const sourceBuffer = payload.buffer as ArrayBuffer;
    const clonedBuffer = sourceBuffer.slice(
      payload.byteOffset,
      payload.byteOffset + payload.byteLength
    );
    webContents.postMessage("stream-binary", {
      kind,
      buffer: clonedBuffer,
      byteOffset: 0,
      byteLength: clonedBuffer.byteLength,
    });
    return true;
  } catch (error) {
    log("native stream binary postMessage failed:", (error as any)?.message || String(error));
    streamWebContents = null;
    return false;
  }
};

const broadcastTypedBinary = (kind: number, payload: Buffer) => {
  if (!payload || payload.length < 1) {
    return false;
  }

  if (postNativeTypedBinary(kind, payload)) {
    return true;
  }

  if (wsClients.size < 1) {
    return false;
  }

  const packet = Buffer.allocUnsafe(1 + payload.length);
  packet[0] = kind & 0xff;
  payload.copy(packet, 1);
  const backlogLimit =
    kind === WS_BINARY_AUDIO ? MAX_AUDIO_CLIENT_BACKLOG_BYTES : MAX_VIDEO_CLIENT_BACKLOG_BYTES;
  let sent = false;

  for (const client of wsClients) {
    if (!client || client.readyState !== 1) {
      continue;
    }
    if ((client as any).bufferedAmount > backlogLimit) {
      continue;
    }

    try {
      client.send(packet, { binary: true, compress: false });
      sent = true;
    } catch {
      // ignore send failures, socket lifecycle handlers will clean it up
    }
  }

  return sent;
};

const closeWsClient = (socket: any) => {
  if (!socket || !wsClients.has(socket)) {
    return;
  }

  releaseClientPressedButtons(socket, "client-closed");
  wsClientPressedButtons.delete(socket);
  wsClients.delete(socket);

  try {
    socket.close();
  } catch {
    // ignore
  }
};

const handleWsControlText = (socket: any, message: any) => {
  const key = normalizeButtonName(message?.button);
  if (!key || message?.type !== "control_button") {
    return;
  }

  const changed = updateControllerStateFromClient(socket, key, !!message?.pressed);
  if (changed) {
    applyEffectiveControllerState(`ws:${key}:${message?.pressed ? "down" : "up"}`);
  }
};

const applyControllerState = (state: ControllerStatePayload | null | undefined, reason: string) => {
  if (!state || typeof state !== "object") {
    return;
  }

  setNormalizedControllerState(frontendControllerState, state);
  applyEffectiveControllerState(reason);
};

const handleWsControlState = (message: any) => {
  applyControllerState(message?.state, "ws:state");
};

const flushPendingDirectControllerState = () => {
  directControllerStateFlushScheduled = false;
  const state = pendingDirectControllerState;
  pendingDirectControllerState = null;
  applyControllerState(state, "ipc:state");
};

const setControllerStateDirect = (state: ControllerStatePayload) => {
  if (!state || typeof state !== "object") {
    return;
  }

  pendingDirectControllerState = { ...state };
  if (directControllerStateFlushScheduled) {
    return;
  }

  directControllerStateFlushScheduled = true;
  setImmediate(flushPendingDirectControllerState);
};

const onWsMessage = (socket: any, raw: Buffer) => {
  let message: any = null;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    sendWsText(socket, { type: "message", data: raw.toString() });
    return;
  }

  if (message?.type === "ping") {
    sendWsText(socket, { type: "pong", ts: Date.now() });
    return;
  }

  if (message?.type === "control_button") {
    handleWsControlText(socket, message);
    return;
  }

  if (message?.type === "control_state") {
    handleWsControlState(message);
    return;
  }

  sendWsText(socket, {
    type: "ack",
    ts: Date.now(),
    data: message,
  });
};

const startSocketServer = async () => {
  ensureInitialized();

  if (streamHttpServer && streamWebSocketServer && streamWebSocketPort > 0) {
    return {
      host: STREAM_WS_HOST,
      port: streamWebSocketPort,
      path: STREAM_WS_PATH,
      reused: true,
    };
  }

  const httpServer = http.createServer();
  const websocketServer = new WebSocketServerCtor({
    server: httpServer,
    path: STREAM_WS_PATH,
  });

  websocketServer.on("connection", (socket) => {
    wsClients.add(socket);
    wsClientPressedButtons.set(socket, new Set());

    try {
      socket?._socket?.setNoDelay?.(true);
    } catch {
      // ignore socket tuning failures
    }

    sendWsText(socket, { type: "connected", ts: Date.now() });
    sendVideoConfigToClient(socket);
    sendAudioConfigToClient(socket);

    socket.on("message", (raw) => {
      let data: Buffer;
      if (Buffer.isBuffer(raw)) {
        data = raw;
      } else if (Array.isArray(raw)) {
        data = Buffer.concat(raw.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item))));
      } else if (raw instanceof ArrayBuffer) {
        data = Buffer.from(raw);
      } else {
        data = Buffer.from(String(raw));
      }
      onWsMessage(socket, data);
    });
    socket.on("error", () => closeWsClient(socket));
    socket.on("close", () => closeWsClient(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error) => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(0, STREAM_WS_HOST, () => {
      httpServer.removeListener("error", onError);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    websocketServer.close();
    httpServer.close();
    throw new Error("Failed to start stream websocket server.");
  }

  streamHttpServer = httpServer;
  streamWebSocketServer = websocketServer;
  streamWebSocketPort = address.port;

  const resetStreamServerState = () => {
    streamWebSocketServer = null;
    streamHttpServer = null;
    streamWebSocketPort = 0;
  };

  websocketServer.on("close", resetStreamServerState);
  httpServer.on("close", resetStreamServerState);

  return {
    host: STREAM_WS_HOST,
    port: streamWebSocketPort,
    path: STREAM_WS_PATH,
    reused: false,
  };
};

const stopSocketServer = async () => {
  const websocketServer = streamWebSocketServer;
  const httpServer = streamHttpServer;

  for (const socket of wsClients) {
    closeWsClient(socket);
  }
  wsClients.clear();
  wsClientPressedButtons.clear();

  streamWebSocketServer = null;
  streamHttpServer = null;
  streamWebSocketPort = 0;

  if (websocketServer) {
    await new Promise<void>((resolve) => {
      websocketServer.close(() => resolve());
    });
  }

  if (httpServer && httpServer.listening) {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  return { stopped: true };
};

const attachStreamWebContents = (webContents: WebContents | null | undefined) => {
  streamWebContents = webContents && !webContents.isDestroyed() ? webContents : null;
  nativeVideoFramesInFlight = 0;
  nativeVideoFrameInFlightAtMs = 0;
  nativeEncodedVideoSamplesInFlight.length = 0;
  pendingEncodedVideoSamples.length = 0;
  pendingEncodedVideoSampleBytes = 0;
};

const destroyVideoPipeline = () => {
  clearPendingVideoSampleQueue();
  pendingChunks.length = 0;
  pendingBytes = 0;
  pendingVideoBroadcastFrame = null;
  videoBroadcastFlushScheduled = false;
  nativeVideoFramesInFlight = 0;
  nativeVideoFrameInFlightAtMs = 0;
  nativeEncodedVideoSamplesInFlight.length = 0;
  pendingEncodedVideoSamples.length = 0;
  pendingEncodedVideoSampleBytes = 0;
  ffmpegInputBlocked = false;
  decodedFrameCount = 0;
  framesLostCount = 0;
  decodeFrameCostWindowMs.length = 0;
  decodeFrameCostWindowTotalMs = 0;
  decodedFrameIntervalTotalMs = 0;
  decodedFrameIntervalCount = 0;
  lastDecodedFrameAtMs = 0;

  if (ffmpegInput) {
    try {
      ffmpegInput.end();
    } catch {
      // ignore
    }
    ffmpegInput = null;
  }

  if (ffmpegCommand) {
    try {
      ffmpegCommand.kill("SIGKILL");
    } catch {
      // ignore
    }
    ffmpegCommand = null;
  }

  ffmpegOutput = null;
  activeVideoDecoderPlanName = "software";
  activeVideoTransportMode = "ffmpeg-rawvideo";
  videoDecoderRecoveryInProgress = false;
};

const buildEncodedVideoSamplePacket = (sample: QueuedVideoSample) => {
  let payload = sample.data;

  if (sample.isSyncFrame && cachedVideoConfigSample && !sample.hasConfig) {
    payload = Buffer.concat([cachedVideoConfigSample, sample.data]);
  }

  const packet = Buffer.allocUnsafe(5 + payload.length);
  packet[0] = (sample.isSyncFrame ? 1 : 0) | (sample.hasConfig ? 2 : 0);
  packet.writeUInt32LE(sample.id >>> 0, 1);
  payload.copy(packet, 5);
  return packet;
};

const getMaxPendingEncodedVideoSampleBytes = () => {
  return Math.max(MAX_PENDING_ENCODED_VIDEO_SAMPLE_BYTES_MIN, getMaxPendingVideoSampleBytes());
};

const clearPendingEncodedVideoSampleQueue = () => {
  pendingEncodedVideoSamples.length = 0;
  pendingEncodedVideoSampleBytes = 0;
};

const enqueuePendingEncodedVideoSample = (sample: QueuedVideoSample) => {
  pendingEncodedVideoSamples.push(sample);
  pendingEncodedVideoSampleBytes += sample.data.length;
};

const shiftPendingEncodedVideoSample = () => {
  const sample = pendingEncodedVideoSamples.shift() || null;
  if (sample) {
    pendingEncodedVideoSampleBytes -= sample.data.length;
    if (pendingEncodedVideoSampleBytes < 0) {
      pendingEncodedVideoSampleBytes = 0;
    }
  }
  return sample;
};

const resyncEncodedVideoQueueForBacklog = (reason: string) => {
  const keptSamples = pendingEncodedVideoSamples.slice();
  const nextQueue = keepSamplesFromLatestSyncOrTail(keptSamples);
  clearPendingEncodedVideoSampleQueue();
  for (const sample of nextQueue) {
    enqueuePendingEncodedVideoSample(sample);
  }

  waitingForVideoSyncFrame = nextQueue.length < 1;
  log(
    waitingForVideoSyncFrame
      ? `encoded video queue resync requested (${reason}), waiting for next sync frame`
      : `encoded video queue trimmed to latest sync frame (${reason})`
  );
};

const trimPendingEncodedVideoSampleQueue = () => {
  if (pendingEncodedVideoSampleBytes <= getMaxPendingEncodedVideoSampleBytes()) {
    return;
  }

  resyncEncodedVideoQueueForBacklog("compressed sample backlog");
};

const consumeInFlightEncodedVideoSample = (sampleId?: number) => {
  if (nativeEncodedVideoSamplesInFlight.length < 1) {
    return false;
  }

  const numericSampleId = Number(sampleId);
  if (!Number.isFinite(numericSampleId) || numericSampleId < 1) {
    nativeEncodedVideoSamplesInFlight.shift();
    return true;
  }

  const normalizedSampleId = Math.trunc(numericSampleId);
  const inFlightIndex = nativeEncodedVideoSamplesInFlight.findIndex(
    (entry) => entry.id === normalizedSampleId
  );
  if (inFlightIndex < 0) {
    return false;
  }

  nativeEncodedVideoSamplesInFlight.splice(inFlightIndex, 1);
  return true;
};

const flushPendingEncodedVideoSample = () => {
  const now = Date.now();
  const shouldUseNativeAck = canUseNativeStreamBinary();
  const encodedAckTimeoutMs = activeClientIsSteamOs
    ? STEAMOS_ENCODED_VIDEO_SAMPLE_ACK_TIMEOUT_MS
    : NATIVE_ENCODED_VIDEO_SAMPLE_ACK_TIMEOUT_MS;
  const oldestInFlightSample = nativeEncodedVideoSamplesInFlight[0] || null;
  if (
    shouldUseNativeAck &&
    oldestInFlightSample &&
    now - oldestInFlightSample.sentAtMs > encodedAckTimeoutMs
  ) {
    if (activeClientIsSteamOs) {
      resyncEncodedVideoQueueForBacklog("encoded sample ack timeout");
    }
    nativeEncodedVideoSamplesInFlight.length = 0;
  }

  if (pendingEncodedVideoSamples.length < 1) {
    return;
  }

  if (!shouldUseNativeAck) {
    const sample = pendingEncodedVideoSamples[0];
    if (!sample) {
      return;
    }

    if (broadcastTypedBinary(WS_BINARY_VIDEO_ENCODED, buildEncodedVideoSamplePacket(sample))) {
      shiftPendingEncodedVideoSample();
    }
    return;
  }

  const maxInFlightSamples = Math.max(1, getNativeEncodedVideoSamplesInFlightLimit());
  while (nativeEncodedVideoSamplesInFlight.length < maxInFlightSamples) {
    const sample = pendingEncodedVideoSamples[0];
    if (!sample) {
      break;
    }

    if (!broadcastTypedBinary(WS_BINARY_VIDEO_ENCODED, buildEncodedVideoSamplePacket(sample))) {
      break;
    }

    shiftPendingEncodedVideoSample();
    nativeEncodedVideoSamplesInFlight.push({
      id: sample.id,
      sentAtMs: Date.now(),
    });
  }
};

const dispatchEncodedVideoSample = (sample: QueuedVideoSample) => {
  if (!sample.hasSlice) {
    return;
  }

  if (waitingForVideoSyncFrame && !sample.isSyncFrame) {
    return;
  }

  if (waitingForVideoSyncFrame && sample.isSyncFrame) {
    waitingForVideoSyncFrame = false;
  }

  enqueuePendingEncodedVideoSample(sample);
  trimPendingEncodedVideoSampleQueue();

  flushPendingEncodedVideoSample();
};

const activateCompressedVideoTransport = () => {
  destroyVideoPipeline();
  activeVideoTransportMode = "compressed-webcodecs";
  nativeEncodedVideoSamplesInFlight.length = 0;
  clearPendingEncodedVideoSampleQueue();
  waitingForVideoSyncFrame = false;
};

const flushPendingVideoBroadcastFrame = () => {
  videoBroadcastFlushScheduled = false;
  const frame = pendingVideoBroadcastFrame;
  if (!frame || frame.length < 1) {
    pendingVideoBroadcastFrame = null;
    return;
  }

  if (canUseNativeStreamBinary()) {
    const now = Date.now();
    const maxFramesInFlight = streamVideoConfig?.isHdr
      ? 1
      : MAX_NATIVE_VIDEO_FRAMES_IN_FLIGHT;
    if (
      nativeVideoFramesInFlight > 0 &&
      now - nativeVideoFrameInFlightAtMs > NATIVE_VIDEO_FRAME_ACK_TIMEOUT_MS
    ) {
      nativeVideoFramesInFlight = 0;
      nativeVideoFrameInFlightAtMs = 0;
    }

    if (nativeVideoFramesInFlight >= maxFramesInFlight) {
      return;
    }

    if (postNativeTypedBinary(WS_BINARY_VIDEO, frame)) {
      pendingVideoBroadcastFrame = null;
      nativeVideoFramesInFlight += 1;
      nativeVideoFrameInFlightAtMs = now;
      return;
    }
  }

  pendingVideoBroadcastFrame = null;
  broadcastTypedBinary(WS_BINARY_VIDEO, frame);
};

const queueVideoBroadcastFrame = (frame: Buffer) => {
  if (!frame || frame.length < 1) {
    return;
  }

  pendingVideoBroadcastFrame = frame;
  if (videoBroadcastFlushScheduled) {
    return;
  }

  videoBroadcastFlushScheduled = true;
  flushPendingVideoBroadcastFrame();
};

const notifyVideoFrameRendered = (sampleId?: number) => {
  if (isCompressedVideoTransportActive()) {
    if (!consumeInFlightEncodedVideoSample(sampleId)) {
      return;
    }
    flushPendingEncodedVideoSample();
    return;
  }

  if (nativeVideoFramesInFlight > 0) {
    nativeVideoFramesInFlight -= 1;
  }
  if (nativeVideoFramesInFlight < 1) {
    nativeVideoFramesInFlight = 0;
    nativeVideoFrameInFlightAtMs = 0;
  }

  if (!pendingVideoBroadcastFrame || videoBroadcastFlushScheduled) {
    return;
  }

  videoBroadcastFlushScheduled = true;
  flushPendingVideoBroadcastFrame();
};

const discardPendingDecodedBytes = (byteCount: number) => {
  let remaining = Math.max(0, byteCount);

  while (remaining > 0 && pendingChunks.length > 0) {
    const head = pendingChunks[0];
    if (head.length <= remaining) {
      remaining -= head.length;
      pendingChunks.shift();
      continue;
    }

    pendingChunks[0] = head.subarray(remaining);
    remaining = 0;
  }

  pendingBytes = Math.max(0, pendingBytes - Math.max(0, byteCount));
};

const trimPendingDecodedFrames = (frameSize: number) => {
  if (
    !canUseNativeStreamBinary() ||
    frameSize < 1 ||
    (nativeVideoFramesInFlight < 1 && !pendingVideoBroadcastFrame)
  ) {
    return;
  }

  const completeFrames = Math.floor(pendingBytes / frameSize);
  const framesToDrop = Math.max(0, completeFrames - 1);
  if (framesToDrop < 1) {
    return;
  }

  discardPendingDecodedBytes(framesToDrop * frameSize);
};

const handleDecodedVideoChunk = (chunk: Buffer) => {
  if (!chunk || chunk.length < 1 || !streamVideoConfig) {
    return;
  }

  const frameSize = streamVideoConfig.frameSize;
  pendingChunks.push(chunk);
  pendingBytes += chunk.length;
  trimPendingDecodedFrames(frameSize);

  while (pendingBytes >= frameSize) {
    const decodeFrameStart = performance.now();
    const frame = streamVideoConfig.isHdr
      ? Buffer.allocUnsafeSlow(frameSize)
      : Buffer.allocUnsafe(frameSize);
    let copied = 0;
    while (copied < frameSize && pendingChunks.length > 0) {
      const head = pendingChunks[0];
      const need = frameSize - copied;
      if (head.length <= need) {
        head.copy(frame, copied);
        copied += head.length;
        pendingChunks.shift();
      } else {
        head.copy(frame, copied, 0, need);
        pendingChunks[0] = head.subarray(need);
        copied += need;
      }
    }

    pendingBytes -= frameSize;
    const now = Date.now();
    if (lastDecodedFrameAtMs > 0) {
      decodedFrameIntervalTotalMs += Math.max(0, now - lastDecodedFrameAtMs);
      decodedFrameIntervalCount += 1;
    }
    lastDecodedFrameAtMs = now;
    decodedFrameCount += 1;

    const decodeCostMs = Math.max(0, performance.now() - decodeFrameStart);
    decodeFrameCostWindowMs.push(decodeCostMs);
    decodeFrameCostWindowTotalMs += decodeCostMs;
    if (decodeFrameCostWindowMs.length > MAX_DECODE_COST_WINDOW) {
      const removed = decodeFrameCostWindowMs.shift() || 0;
      decodeFrameCostWindowTotalMs -= removed;
    }

    queueVideoBroadcastFrame(frame);
  }
};

const createVideoDecodePipeline = () => {
  if (!streamVideoConfig) {
    return;
  }

  destroyVideoPipeline();
  const decoderPlan = buildVideoDecoderPlan();
  activeVideoDecoderPlanName = decoderPlan.name;

  ffmpegInput = new PassThrough({
    highWaterMark: decoderPlan.inputHighWaterMarkBytes,
  });

  ffmpegCommand = ffmpeg(ffmpegInput)
    .inputFormat(streamVideoConfig.inputFormat)
    .inputOptions(decoderPlan.inputOptions)
    .outputOptions("-fflags", "nobuffer")
    .outputOptions("-flags", "low_delay")
    .outputOptions("-vsync", "0")
    .outputOptions("-an")
    .outputOptions("-sn")
    .outputOptions("-dn")
    .outputOptions("-pix_fmt", streamVideoConfig.outputPixelFormat)
    .outputOptions("-f", "rawvideo")
    .outputOptions("-vcodec", "rawvideo")
    .on("start", (cmd) => log(`ffmpeg video decoder started (${decoderPlan.name}):`, cmd))
    .on("error", (error) => {
      const message = error?.message || String(error);
      log("ffmpeg video decoder error:", message);
      fallbackVideoDecoderToSoftware(message);
    })
    .on("end", () => log("ffmpeg video decoder ended"));

  if (decoderPlan.filterGraph) {
    ffmpegCommand.outputOptions("-vf", decoderPlan.filterGraph);
  }

  ffmpegOutput = ffmpegCommand.pipe();
  ffmpegOutput.on("data", handleDecodedVideoChunk);
  ffmpegOutput.on("error", (error) => {
    log("ffmpeg video output error:", error?.message || String(error));
  });
};

const flushPendingVideoSamples = () => {
  if (!ffmpegInput || !ffmpegInput.writable) {
    return;
  }

  while (!ffmpegInputBlocked && pendingVideoSamples.length > 0) {
    const sample = shiftPendingVideoSample();
    if (!sample) {
      break;
    }

    const ok = ffmpegInput.write(sample.data);
    if (!ok) {
      ffmpegInputBlocked = true;
      ffmpegInput.once("drain", () => {
        ffmpegInputBlocked = false;
        flushPendingVideoSamples();
      });
      break;
    }
  }
};

const dispatchVideoSample = (sampleData: Buffer) => {
  if (!sampleData || sampleData.length < 1) {
    return;
  }

  const inspectedSample = inspectVideoSample(sampleData);
  if (inspectedSample.hasConfig) {
    cachedVideoConfigSample = Buffer.from(sampleData);
  }

  if (isCompressedVideoTransportActive()) {
    dispatchEncodedVideoSample(inspectedSample);
    return;
  }

  if (!ffmpegInput || !ffmpegInput.writable) {
    return;
  }

  if (waitingForVideoSyncFrame && !inspectedSample.isSyncFrame) {
    return;
  }

  if (waitingForVideoSyncFrame && inspectedSample.isSyncFrame) {
    waitingForVideoSyncFrame = false;
  }

  enqueueVideoSample(inspectedSample);

  if (shouldResyncVideoDecoderOnBacklog() && pendingVideoSampleBytes > getMaxPendingVideoSampleBytes()) {
    recreateVideoDecodePipelineForSync("compressed sample backlog");
  }

  if (pendingVideoSamples.length > 0) {
    flushPendingVideoSamples();
  }
};

const oggCrc = (page: Buffer) => {
  let crc = 0;
  for (let i = 0; i < page.length; i += 1) {
    const index = ((crc >>> 24) ^ page[i]) & 0xff;
    crc = (((crc << 8) >>> 0) ^ OGG_CRC_TABLE[index]) >>> 0;
  }
  return crc >>> 0;
};

const buildOpusHeadPacket = (channels: number, sampleRate: number) => {
  const packet = Buffer.alloc(19);
  packet.write("OpusHead", 0, "ascii");
  packet[8] = 1;
  packet[9] = channels & 0xff;
  packet.writeUInt16LE(0, 10);
  packet.writeUInt32LE(sampleRate >>> 0, 12);
  packet.writeInt16LE(0, 16);
  packet[18] = 0;
  return packet;
};

const buildOpusTagsPacket = () => {
  const vendor = Buffer.from("peasyo4desk", "utf8");
  const packet = Buffer.alloc(8 + 4 + vendor.length + 4);
  packet.write("OpusTags", 0, "ascii");
  packet.writeUInt32LE(vendor.length, 8);
  vendor.copy(packet, 12);
  packet.writeUInt32LE(0, 12 + vendor.length);
  return packet;
};

const resetAudioInputQueue = () => {
  audioInputQueue.length = 0;
  audioInputQueuedBytes = 0;
};

const trimAudioInputQueue = () => {
  while (audioInputQueuedBytes > MAX_PENDING_AUDIO_INPUT_BYTES && audioInputQueue.length > 0) {
    const dropped = audioInputQueue.shift();
    if (!dropped) {
      continue;
    }
    audioInputQueuedBytes -= dropped.length;
  }

  if (audioInputQueuedBytes < 0) {
    audioInputQueuedBytes = 0;
  }
};

const flushQueuedAudioInput = () => {
  if (!audioDecoderInput || !audioDecoderInput.writable || audioInputBlocked) {
    return;
  }

  while (audioInputQueue.length > 0 && audioDecoderInput && audioDecoderInput.writable && !audioInputBlocked) {
    const nextPage = audioInputQueue.shift();
    if (!nextPage) {
      continue;
    }

    audioInputQueuedBytes -= nextPage.length;
    const ok = audioDecoderInput.write(nextPage);
    if (!ok) {
      audioInputBlocked = true;
      audioDecoderInput.once("drain", () => {
        audioInputBlocked = false;
        flushQueuedAudioInput();
      });
    }
  }

  if (audioInputQueuedBytes < 0) {
    audioInputQueuedBytes = 0;
  }
};

const writeAudioInput = (data: Buffer) => {
  if (!audioDecoderInput || !audioDecoderInput.writable) {
    return false;
  }

  if (audioInputBlocked) {
    audioInputQueue.push(data);
    audioInputQueuedBytes += data.length;
    trimAudioInputQueue();
    return true;
  }

  const ok = audioDecoderInput.write(data);
  if (!ok) {
    audioInputBlocked = true;
    audioDecoderInput.once("drain", () => {
      audioInputBlocked = false;
      flushQueuedAudioInput();
    });
  }
  return true;
};

const writeOggPage = (packet: Buffer, headerType: number, granulePosition: bigint) => {
  if (!packet || packet.length < 1) {
    return false;
  }

  const segmentCount = Math.floor(packet.length / 255) + 1;
  if (segmentCount > 255) {
    return false;
  }

  const headerSize = 27 + segmentCount;
  const page = Buffer.allocUnsafe(headerSize + packet.length);
  page.write("OggS", 0, "ascii");
  page[4] = 0;
  page[5] = headerType & 0xff;
  page.writeBigUInt64LE(granulePosition, 6);
  page.writeUInt32LE(oggSerial, 14);
  page.writeUInt32LE(oggSeq >>> 0, 18);
  page.writeUInt32LE(0, 22);
  page[26] = segmentCount;

  let remaining = packet.length;
  for (let i = 0; i < segmentCount; i += 1) {
    const lacing = remaining >= 255 ? 255 : remaining;
    page[27 + i] = lacing;
    remaining -= lacing;
  }

  packet.copy(page, headerSize);
  const crc = oggCrc(page);
  page.writeUInt32LE(crc, 22);
  oggSeq += 1;

  return writeAudioInput(page);
};

const resetAudioPending = () => {
  audioPendingChunks.length = 0;
  audioPendingBytes = 0;
};

const destroyAudioPipeline = () => {
  resetAudioPending();
  resetAudioInputQueue();
  audioInputBlocked = false;

  if (audioDecoderInput) {
    try {
      audioDecoderInput.end();
    } catch {
      // ignore
    }
    audioDecoderInput = null;
  }

  if (audioDecoderCommand) {
    try {
      audioDecoderCommand.kill("SIGKILL");
    } catch {
      // ignore
    }
    audioDecoderCommand = null;
  }

  audioDecoderOutput = null;
};

const handleAudioDecodedChunk = (chunk: Buffer) => {
  if (!chunk || chunk.length < 1 || audioChunkBytes < 1) {
    return;
  }

  audioPendingChunks.push(chunk);
  audioPendingBytes += chunk.length;

  while (audioPendingBytes >= audioChunkBytes) {
    const pcm = Buffer.allocUnsafeSlow(audioChunkBytes);
    let copied = 0;
    while (copied < audioChunkBytes && audioPendingChunks.length > 0) {
      const head = audioPendingChunks[0];
      const need = audioChunkBytes - copied;
      if (head.length <= need) {
        head.copy(pcm, copied);
        copied += head.length;
        audioPendingChunks.shift();
      } else {
        head.copy(pcm, copied, 0, need);
        audioPendingChunks[0] = head.subarray(need);
        copied += need;
      }
    }

    audioPendingBytes -= audioChunkBytes;
    broadcastTypedBinary(WS_BINARY_AUDIO, pcm);
  }

  if (audioPendingBytes > audioChunkBytes * 32) {
    resetAudioPending();
  }
};

const createAudioDecodePipeline = () => {
  destroyAudioPipeline();
  if (!audioHeaderInfo) {
    return;
  }

  audioChannels = audioHeaderInfo.channels;
  audioSampleRate = audioHeaderInfo.rate;
  audioFrameSamples = audioHeaderInfo.frameSize;
  audioChunkBytes = audioFrameSamples * audioChannels * 4;

  audioDecoderInput = new PassThrough({
    highWaterMark: 1024 * 1024,
  });

  audioDecoderCommand = ffmpeg(audioDecoderInput)
    .inputFormat("ogg")
    .inputOptions("-fflags", "+genpts")
    .outputOptions("-fflags", "nobuffer")
    .outputOptions("-flags", "low_delay")
    .outputOptions("-vn")
    .outputOptions("-sn")
    .outputOptions("-dn")
    .audioChannels(audioChannels)
    .audioFrequency(audioSampleRate)
    .audioCodec("pcm_f32le")
    .outputOptions("-f", "f32le")
    .on("start", (cmd) => log("ffmpeg audio decoder started:", cmd))
    .on("error", (error) => log("ffmpeg audio decoder error:", error?.message || String(error)))
    .on("end", () => log("ffmpeg audio decoder ended"));

  audioDecoderOutput = audioDecoderCommand.pipe();
  audioDecoderOutput.on("data", handleAudioDecodedChunk);
  audioDecoderOutput.on("error", (error) => {
    log("ffmpeg audio output error:", error?.message || String(error));
  });

  oggSerial = crypto.randomBytes(4).readUInt32LE(0);
  oggSeq = 0;
  oggGranule = 0n;

  writeOggPage(buildOpusHeadPacket(audioChannels, audioSampleRate), 0x02, 0n);
  writeOggPage(buildOpusTagsPacket(), 0x00, 0n);
};

const onAudioHeader = (header: any) => {
  if (!header) {
    return;
  }

  const channels = Number(header.channels) || 0;
  const bits = Number(header.bits) || 0;
  const rate = Number(header.rate) || 0;
  const frameSize = Number(header.frameSize) || 0;
  if (channels < 1 || rate < 1 || frameSize < 1) {
    return;
  }

  audioHeaderInfo = {
    channels,
    bits,
    rate,
    frameSize,
    unknown: Number(header.unknown) || 0,
  };

  createAudioDecodePipeline();
  broadcastAudioConfig();
};

const dispatchAudioFrame = (opusPacket: Buffer) => {
  if (!audioHeaderInfo || !opusPacket || opusPacket.length < 1 || !audioDecoderInput) {
    return;
  }

  oggGranule += BigInt(audioFrameSamples);
  writeOggPage(opusPacket, 0x00, oggGranule);
};

const hapticLevelFromPeak = (peak: number) => {
  if (peak <= 0) {
    return 0;
  }

  const db = 20 * Math.log10(peak / 0.6);
  if (!Number.isFinite(db) || db <= 0) {
    return 0;
  }

  let level = Math.trunc(db);
  if (level <= 0x50) {
    return 0;
  }
  if (level > 0xff) {
    level = 0xff;
  }
  return level;
};

const formatHapticPeak = (peak: number) => {
  if (peak <= 0) {
    return 0;
  }

  const db = 20 * Math.log10(peak / 0.6);
  if (!Number.isFinite(db) || db <= 0) {
    return 0;
  }

  let level = Math.trunc(db);
  if (level > 0xff) {
    level = 0xff;
  }
  return level;
};

let hapticsFrameSeq = 0;

const nextHapticsFrameSeq = () => {
  hapticsFrameSeq = (hapticsFrameSeq + 1) & 0x7fffffff;
  return hapticsFrameSeq;
};

const broadcastRumbleEvent = (event: any) => {
  const payload: Record<string, unknown> = {
    name: "rumble",
    unknown: clampInt(event?.unknown, 0, 0xff),
    left: clampInt(event?.left, 0, 0xff),
    right: clampInt(event?.right, 0, 0xff),
    peakLeft: clampInt(event?.peakLeft, 0, 0xff),
    peakRight: clampInt(event?.peakRight, 0, 0xff),
  };
  if (typeof event?.source === "string" && event.source.length > 0) {
    payload.source = event.source;
  }
  if (Number.isFinite(event?.hapticFrameSeq)) {
    payload.hapticFrameSeq = Math.trunc(Number(event.hapticFrameSeq));
  }

  broadcastText({
    type: "session_event",
    name: "rumble",
    event: payload,
  });
};

const broadcastHapticAudioEvent = (frame: any, frameSeq: number) => {
  const frameData = frame?.data;
  const buffer = Buffer.isBuffer(frameData) ? frameData : Buffer.from(frameData || []);
  if (buffer.length < 1) {
    return;
  }

  broadcastText({
    type: "session_event",
    name: "haptic_audio",
    event: {
      name: "haptic_audio",
      source: "haptic_audio",
      hapticFrameSeq: frameSeq,
      format: "s16le",
      channels: 2,
      dataBase64: buffer.toString("base64"),
      byteLength: buffer.length,
    },
  });
};

const normalizeFixedByteArrayEventValue = (value: unknown, length: number) => {
  if (length <= 0) {
    return undefined;
  }

  let source: Uint8Array | null = null;
  if (Buffer.isBuffer(value)) {
    source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (value instanceof Uint8Array) {
    source = value;
  } else if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    source = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  } else if (Array.isArray(value)) {
    source = Uint8Array.from(value.map((item) => clampInt(item, 0, 0xff)));
  }

  if (!source) {
    return undefined;
  }

  const normalized = new Uint8Array(length);
  normalized.set(source.subarray(0, length));
  return Array.from(normalized);
};

const broadcastTriggerEffectsEvent = (event: any) => {
  const payload: Record<string, unknown> = {
    name: "trigger_effects",
  };

  if (event?.typeLeft !== undefined) {
    payload.typeLeft = clampInt(event.typeLeft, 0, 0xff);
  }
  if (event?.typeRight !== undefined) {
    payload.typeRight = clampInt(event.typeRight, 0, 0xff);
  }

  const left = normalizeFixedByteArrayEventValue(event?.left, 10);
  const right = normalizeFixedByteArrayEventValue(event?.right, 10);
  if (left) {
    payload.left = left;
  }
  if (right) {
    payload.right = right;
  }

  broadcastText({
    type: "session_event",
    name: "trigger_effects",
    event: payload,
  });
};

const dispatchHapticsFrameAsRumble = (frame: any, frameSeq: number) => {
  const frameData = frame?.data;
  const buffer = Buffer.isBuffer(frameData) ? frameData : Buffer.from(frameData || []);
  if (buffer.length < 4) {
    return;
  }

  const sampleSize = 2 * 2;
  const sampleCount = Math.floor(buffer.length / sampleSize);
  if (sampleCount < 1) {
    return;
  }

  let peakLeft = 0;
  let peakRight = 0;

  for (let i = 0; i < sampleCount; i += 1) {
    const offset = i * sampleSize;
    const amplitudeLeft = buffer.readInt16LE(offset);
    const amplitudeRight = buffer.readInt16LE(offset + 2);

    if (amplitudeLeft > peakLeft) {
      peakLeft = amplitudeLeft;
    }
    if (amplitudeRight > peakRight) {
      peakRight = amplitudeRight;
    }
  }

  const left = hapticLevelFromPeak(peakLeft);
  const right = hapticLevelFromPeak(peakRight);

  broadcastRumbleEvent({
    unknown: buffer[0],
    left,
    right,
    peakLeft: formatHapticPeak(peakLeft),
    peakRight: formatHapticPeak(peakRight),
    source: "haptic_audio",
    hapticFrameSeq: frameSeq,
  });
};

const cleanupSessionOnly = () => {
  clearDelayedControllerResetRetry();
  for (const socket of wsClients) {
    releaseClientPressedButtons(socket, "session-stop");
  }
  stopNodeGamepadDriver();
  controllerButtonRefCounts.clear();
  resetControllerState(controllerState);
  resetControllerState(frontendControllerState);
  resetNodeControllerState(nodeControllerState);
  resetControllerState(lastSubmittedControllerState);
  hasSubmittedControllerState = false;
  pendingDirectControllerState = null;
  directControllerStateFlushScheduled = false;

  if (streamSession) {
    try {
      streamSession.stop();
    } catch {
      // ignore
    }
    if (streamSessionStarted) {
      try {
        streamSession.join();
      } catch {
        // ignore
      }
    }
    try {
      streamSession.close();
    } catch {
      // ignore
    }
  }

  streamSession = null;
  streamSessionStarted = false;
  streamWebContents = null;
  streamVideoConfig = null;
  activeClientIsSteamOs = false;
  activeSteamOsWebCodecsProfile = STEAMOS_WEBCODECS_PROFILE_DEFAULT;

  destroyVideoPipeline();
  cachedVideoConfigSample = null;
  waitingForVideoSyncFrame = false;
  queuedVideoSampleIdNext = 1;
  destroyAudioPipeline();
  audioHeaderInfo = null;
};

const buildSessionOptions = (args: StartStreamSessionArgs) => {
  const host = (args.streamHost || args.host || "").trim();
  if (!host) {
    throw new Error("streamHost is required.");
  }

  const consoleInfo = args.consoleInfo || {};
  const registKey = (args.registKey || consoleInfo.rpRegistKey || consoleInfo.registKey || "").trim();
  const morning = (args.morning || consoleInfo.rpKey || consoleInfo.morning || "").trim();
  if (!registKey || !morning) {
    throw new Error("Missing registKey/morning. Please ensure host cache contains rpRegistKey and rpKey.");
  }

  const settings = args.settings || {};
  const isRemote = !!args.isRemote;
  const settingsResolution = isRemote ? settings.remote_resolution : settings.resolution;
  const settingsBitrate = isRemote ? settings.remote_bitrate : settings.bitrate;
  const settingsBitrateMode = normalizeBitrateMode(
    isRemote ? settings.remote_bitrate_mode : settings.bitrate_mode
  );
  const settingsFps = isRemote ? settings.remote_fps : settings.fps;
  const settingsCodec = isRemote ? settings.remote_codec : settings.codec;
  const selectedResolution = Number(settingsResolution || 1080);

  const profileResolution = args.videoProfile?.width && args.videoProfile?.height
    ? { width: Number(args.videoProfile.width), height: Number(args.videoProfile.height) }
    : resolveResolution(selectedResolution);
  const profileFps = Number(args.videoProfile?.maxFps || settingsFps || 60);
  const defaultBitrate = ensureBitrateForMode(
    selectedResolution,
    settingsBitrateMode,
    settingsBitrate
  );
  const requestedBitrate = Number(args.videoProfile?.bitrate);
  const profileBitrate =
    Number.isFinite(requestedBitrate) && requestedBitrate > 0
      ? requestedBitrate
      : defaultBitrate;
  const requestedCodec = resolveCodec(args.videoProfile?.codec || settingsCodec || "H265");
  let profileCodec = resolvePlatformCodec(requestedCodec);
  if (IS_LINUX && requestedCodec !== profileCodec) {
    log(`downgrading requested codec ${codecName(requestedCodec)} to ${codecName(profileCodec)} on Linux`);
  }

  const clientVideoCapabilities = args.clientVideoCapabilities || {};
  const profileInputFormat = resolveInputFormat(profileCodec);
  if (
    clientVideoCapabilities.webCodecs &&
    profileInputFormat === "hevc" &&
    !clientVideoCapabilities.hevc &&
    !!clientVideoCapabilities.h264
  ) {
    const fallbackCodec = resolvePlatformCodec((chiaki as any).codecs.H264);
    if (fallbackCodec !== profileCodec) {
      log(
        `downgrading requested codec ${codecName(profileCodec)} to ${codecName(fallbackCodec)} for client WebCodecs support`
      );
      profileCodec = fallbackCodec;
    }
  }

  const outputFormat = resolveOutputFormat(
    profileCodec,
    profileResolution.width,
    profileResolution.height
  );
  const psnAccountId = resolvePsnAccountId(args.loginInfo);
  const ps5 = resolveSessionPs5Flag(args.ps5, consoleInfo);

  streamVideoConfig = {
    width: profileResolution.width,
    height: profileResolution.height,
    fps: profileFps,
    bitrate: profileBitrate,
    codec: profileCodec,
    codecName: codecName(profileCodec),
    format: outputFormat.format,
    outputPixelFormat: outputFormat.outputPixelFormat,
    isHdr: outputFormat.isHdr,
    frameSize: outputFormat.frameSize,
    inputFormat: resolveInputFormat(profileCodec),
  };

  return {
    host,
    ps5,
    enableDualsense: args.enableDualsense !== false,
    enableKeyboard: false,
    registKey,
    morning,
    ...(psnAccountId ? { psnAccountId } : {}),
    videoProfile: {
      width: streamVideoConfig.width,
      height: streamVideoConfig.height,
      maxFps: streamVideoConfig.fps,
      bitrate: streamVideoConfig.bitrate,
      codec: streamVideoConfig.codec,
      maxOperatingRate: 32767,
    },
  };
};

const createSession = (sessionOptions: any) => {
  streamSession = new (chiaki as any).Session(sessionOptions, {
    onEvent: (event) => {
      const eventName = String(event?.name || "unknown");
      if (eventName === "rumble") {
        // Session rumble packets already carry direct motor levels, so forward
        // them as-is without the haptics-audio peak filtering path.
        broadcastRumbleEvent(event);
      } else if (eventName === "trigger_effects") {
        // Forward adaptive trigger mode and raw 10-byte params so the renderer
        // can write them into the DualSense HID output report.
        broadcastTriggerEffectsEvent(event);
      } else {
        broadcastText({
          type: "session_event",
          name: eventName,
          event: serializeSessionEvent(event),
        });
      }

      if (eventName === "connected") {
        broadcastText({ type: "session_status", status: "connected" });
        pushControllerState("connected-init");
      } else if (eventName === "quit") {
        broadcastText({ type: "session_status", status: "quit" });
      } else {
        broadcastText({ type: "session_status", status: eventName });
      }
    },
    onLog: () => {
      // console.log(`[chiaki:${event.levelChar}]`, event.message);
    },
    onVideoSample: (sample) => {
      const sampleFramesLost = Number(sample?.framesLost);
      if (Number.isFinite(sampleFramesLost) && sampleFramesLost > 0) {
        framesLostCount += Math.trunc(sampleFramesLost);
      }
      dispatchVideoSample(sample.data);
    },
    onAudioHeader: (header) => {
      onAudioHeader(header);
    },
    onAudioFrame: (frame) => {
      dispatchAudioFrame(frame.data);
    },
    onHapticsFrame: (frame) => {
      // Emit raw haptics PCM first for DS5 HID path, and keep rumble fallback
      // for non-supported connections/devices.
      const frameSeq = nextHapticsFrameSeq();
      broadcastHapticAudioEvent(frame, frameSeq);
      dispatchHapticsFrameAsRumble(frame, frameSeq);
    },
  });
};

const getPerformanceStats = (): StreamPerformanceStats => {
  let rttMs = 0;
  let measuredBitrateMbps = 0;
  let packetLossRatio = 0;

  if (streamSession && typeof streamSession.getPerformanceStats === "function") {
    try {
      const stats = streamSession.getPerformanceStats() || {};
      rttMs = Number(stats.rtt) || 0;
      measuredBitrateMbps = Number(stats.measuredBitrate) || 0;
      packetLossRatio = Number(stats.packetLoss) || 0;
    } catch (error) {
      log("getPerformanceStats failed:", (error as any)?.message || String(error));
    }
  }

  const decodeAvgMs =
    decodeFrameCostWindowMs.length > 0
      ? decodeFrameCostWindowTotalMs / decodeFrameCostWindowMs.length
      : 0;
  const decodedFrameIntervalAvgMs =
    decodedFrameIntervalCount > 0 ? decodedFrameIntervalTotalMs / decodedFrameIntervalCount : 0;
  const decodedFps = decodedFrameIntervalAvgMs > 0 ? 1000 / decodedFrameIntervalAvgMs : 0;
  const resolution = streamVideoConfig
    ? `${streamVideoConfig.width}x${streamVideoConfig.height}`
    : "--";
  const decodeText =
    decodeAvgMs > 0
      ? `${decodeAvgMs.toFixed(2)} ms`
      : "--";

  return {
    resolution,
    rtt: rttMs > 0 ? `${rttMs.toFixed(2)} ms` : "--",
    fps: decodedFps > 0 ? `${decodedFps.toFixed(2)}` : "--",
    fl: `${framesLostCount}`,
    pl: packetLossRatio > 0 ? `${(packetLossRatio * 100).toFixed(2)} %` : "0.00 %",
    br: measuredBitrateMbps > 0 ? `${measuredBitrateMbps.toFixed(2)} Mbps` : "0.00 Mbps",
    decode: decodeText,
    decodeAvailable: false,
    decodeFrames: decodedFrameCount,
    raw: {
      rttMs,
      measuredBitrateMbps,
      packetLossRatio,
      decodedFps,
      framesLost: framesLostCount,
      decodeAvgMs,
      decodeFrames: decodedFrameCount,
    },
  };
};

const stopSession = async (closeSocketServer = true) => {
  cleanupSessionOnly();
  broadcastText({ type: "session_status", status: "stopped" });

  if (closeSocketServer) {
    await stopSocketServer();
  }

  return { stopped: true };
};

const gotoBedAndStop = async (closeSocketServer = true) => {
  let gotoBedError: Error | null = null;

  if (streamSession) {
    try {
      streamSession.gotoBed();
      await wait(800);
    } catch (error: any) {
      gotoBedError =
        error instanceof Error
          ? error
          : new Error(String(error || "Failed to put console into standby."));
    }
  }

  const result = await stopSession(closeSocketServer);
  if (gotoBedError) {
    throw gotoBedError;
  }

  return {
    ...result,
    gotoBedSent: true,
  };
};

const startSession = async (args: StartStreamSessionArgs) => {
  ensureInitialized();
  attachStreamWebContents(args.targetWebContents);
  const wsInfo = await startSocketServer();
  activeClientIsSteamOs = !!args.clientVideoCapabilities?.isSteamOs;

  if (streamSession || streamSessionStarted) {
    await stopSession(false);
  }

  activeSteamOsWebCodecsProfile = resolveSteamOsWebCodecsProfile(args.steamOsWebCodecsProfile);
  configureControllerKernel(args.settings);
  const sessionOptions = buildSessionOptions(args);
  if (shouldUseCompressedVideoTransport(args)) {
    activateCompressedVideoTransport();
    log(
      `using compressed video transport (${streamVideoConfig?.inputFormat || "unknown"} -> WebCodecs)`
    );
  } else {
    throw new Error("WebCodec video transport is unavailable on this device or for the selected codec.");
  }
  createSession(sessionOptions);

  streamSession.start();
  streamSessionStarted = true;

  broadcastText({
    type: "session_status",
    status: "starting",
    codec: streamVideoConfig?.codecName,
  });

  if (streamVideoConfig) {
    broadcastText({
      type: "config",
      width: streamVideoConfig.width,
      height: streamVideoConfig.height,
      fps: streamVideoConfig.fps,
      format: streamVideoConfig.format,
      frameSize: streamVideoConfig.frameSize,
      transport: activeVideoTransportMode,
      codecName: streamVideoConfig.codecName,
      inputFormat: streamVideoConfig.inputFormat,
    });
  }
  broadcastAudioConfig();

  return {
    ...wsInfo,
    video: streamVideoConfig,
    audioEnabled: !!audioHeaderInfo,
    binaryTransport: canUseNativeStreamBinary() ? "electron-ipc" : "websocket",
    videoTransport: activeVideoTransportMode,
  };
};

export const StreamSessionService = {
  attachStreamWebContents,
  startSocketServer,
  stopSocketServer,
  startSession,
  setControllerStateDirect,
  triggerNativeGamepadRumble,
  notifyVideoFrameRendered,
  stopSession,
  gotoBedAndStop,
  getPerformanceStats,
};

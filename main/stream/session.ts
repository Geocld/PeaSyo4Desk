import http from "node:http";
import crypto from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import type { WebContents } from "electron";
import ffmpeg from "fluent-ffmpeg";
import WS from "ws";
import chiaki from "../chiaki";

const STREAM_WS_HOST = "127.0.0.1";
const STREAM_WS_PATH = "/stream";
const WS_BINARY_VIDEO = 1;
const WS_BINARY_AUDIO = 2;
const MAX_VIDEO_CLIENT_BACKLOG_BYTES = 1 * 1024 * 1024;
const MAX_AUDIO_CLIENT_BACKLOG_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_AUDIO_INPUT_BYTES = 512 * 1024;
const MAX_NATIVE_VIDEO_FRAMES_IN_FLIGHT = 2;
const NATIVE_VIDEO_FRAME_ACK_TIMEOUT_MS = 250;
const SDR_STREAM_FORMAT = "NV12";
const HDR_STREAM_FORMAT = "I010";
const SDR_PIXEL_FORMAT = "nv12";
const HDR_PIXEL_FORMAT = "yuv420p10le";

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

const FFMPEG_BINARY_NAME = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
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
};

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
  consoleInfo?: {
    rpRegistKey?: string;
    rpKey?: string;
    registKey?: string;
    morning?: string;
    apName?: string;
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

type StreamPerformanceStats = {
  resolution: string;
  rtt: string;
  fps: string;
  fl: string;
  pl: string;
  br: string;
  decode: string;
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
const pendingChunks: Buffer[] = [];
let pendingBytes = 0;
let pendingVideoBroadcastFrame: Buffer | null = null;
let videoBroadcastFlushScheduled = false;
let nativeVideoFramesInFlight = 0;
let nativeVideoFrameInFlightAtMs = 0;
let decodedFrameCount = 0;
let framesLostCount = 0;
const decodeFrameCostWindowMs: number[] = [];
let decodeFrameCostWindowTotalMs = 0;
let decodedFrameIntervalTotalMs = 0;
let decodedFrameIntervalCount = 0;
let lastDecodedFrameAtMs = 0;
const MAX_DECODE_COST_WINDOW = 240;

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

const controllerState = {
  buttons: 0,
  l2State: 0,
  r2State: 0,
  leftX: 0,
  leftY: 0,
  rightX: 0,
  rightY: 0,
};
const controllerButtonRefCounts = new Map<string, number>();

type ControllerStatePayload = {
  buttons?: unknown;
  l2State?: unknown;
  r2State?: unknown;
  leftX?: unknown;
  leftY?: unknown;
  rightX?: unknown;
  rightY?: unknown;
};
let pendingDirectControllerState: ControllerStatePayload | null = null;
let directControllerStateFlushScheduled = false;

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

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

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

const resolveInputFormat = (codec: number) => {
  if (codec === (chiaki as any).codecs.H265 || codec === (chiaki as any).codecs.H265_HDR) {
    return "hevc";
  }
  if (codec === (chiaki as any).codecs.H264) {
    return "h264";
  }
  return "h264";
};

const getVideoDecoderInputOptions = () => {
  const options: string[] = [
    "-fflags +genpts",
  ];

  // This pipeline always downloads decoded frames back to system memory for IPC transport.
  // On macOS, videotoolbox still performs well here. On Windows, `-hwaccel auto` often
  // selects a path that adds expensive GPU->CPU readback and hurts frame pacing.
  if (process.platform === "darwin") {
    options.push("-hwaccel videotoolbox");
  }

  return options;
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

const setControllerButtonState = (key: string, pressed: boolean) => {
  const mask = BUTTON_NAME_TO_MASK[key];
  if (!mask) {
    return;
  }

  if (pressed) {
    controllerState.buttons |= mask;
  } else {
    controllerState.buttons &= ~mask;
  }

  if (key === "l2") {
    controllerState.l2State = pressed ? 0xff : 0;
  } else if (key === "r2") {
    controllerState.r2State = pressed ? 0xff : 0;
  }
};

const pushControllerState = (reason: string) => {
  if (!streamSession || !streamSessionStarted) {
    return;
  }

  try {
    streamSession.setControllerState(controllerState);
  } catch (error: any) {
    log(`setControllerState failed (${reason}):`, error?.message || String(error));
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
    pushControllerState(reason);
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
    const transferBuffer = payload.buffer as ArrayBuffer;
    webContents.postMessage(
      "stream-binary",
      {
        kind,
        buffer: transferBuffer,
        byteOffset: payload.byteOffset,
        byteLength: payload.byteLength,
      },
      [transferBuffer]
    );
    return true;
  } catch (error) {
    log("native stream binary postMessage failed:", (error as any)?.message || String(error));
    streamWebContents = null;
    return false;
  }
};

const broadcastTypedBinary = (kind: number, payload: Buffer) => {
  if (!payload || payload.length < 1) {
    return;
  }

  if (postNativeTypedBinary(kind, payload)) {
    return;
  }

  if (wsClients.size < 1) {
    return;
  }

  const packet = Buffer.allocUnsafe(1 + payload.length);
  packet[0] = kind & 0xff;
  payload.copy(packet, 1);
  const backlogLimit =
    kind === WS_BINARY_AUDIO ? MAX_AUDIO_CLIENT_BACKLOG_BYTES : MAX_VIDEO_CLIENT_BACKLOG_BYTES;

  for (const client of wsClients) {
    if (!client || client.readyState !== 1) {
      continue;
    }
    if ((client as any).bufferedAmount > backlogLimit) {
      continue;
    }

    try {
      client.send(packet, { binary: true, compress: false });
    } catch {
      // ignore send failures, socket lifecycle handlers will clean it up
    }
  }
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
    pushControllerState(`ws:${key}:${message?.pressed ? "down" : "up"}`);
  }
};

const applyControllerState = (state: ControllerStatePayload | null | undefined, reason: string) => {
  if (!state || typeof state !== "object") {
    return;
  }

  controllerState.buttons = (clampInt(state.buttons, 0, 0xffffffff) >>> 0);
  controllerState.l2State = clampInt(state.l2State, 0, 255);
  controllerState.r2State = clampInt(state.r2State, 0, 255);
  controllerState.leftX = clampInt(state.leftX, -32768, 32767);
  controllerState.leftY = clampInt(state.leftY, -32768, 32767);
  controllerState.rightX = clampInt(state.rightX, -32768, 32767);
  controllerState.rightY = clampInt(state.rightY, -32768, 32767);

  pushControllerState(reason);
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
};

const destroyVideoPipeline = () => {
  pendingChunks.length = 0;
  pendingBytes = 0;
  pendingVideoBroadcastFrame = null;
  videoBroadcastFlushScheduled = false;
  nativeVideoFramesInFlight = 0;
  nativeVideoFrameInFlightAtMs = 0;
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
  setImmediate(flushPendingVideoBroadcastFrame);
};

const notifyVideoFrameRendered = () => {
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
  setImmediate(flushPendingVideoBroadcastFrame);
};

const handleDecodedVideoChunk = (chunk: Buffer) => {
  if (!chunk || chunk.length < 1 || !streamVideoConfig) {
    return;
  }

  const frameSize = streamVideoConfig.frameSize;
  pendingChunks.push(chunk);
  pendingBytes += chunk.length;

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

  if (pendingBytes > frameSize * 4) {
    pendingChunks.length = 0;
    pendingBytes = 0;
  }
};

const createVideoDecodePipeline = () => {
  if (!streamVideoConfig) {
    return;
  }

  destroyVideoPipeline();

  ffmpegInput = new PassThrough({
    highWaterMark: 4 * 1024 * 1024,
  });

  ffmpegCommand = ffmpeg(ffmpegInput)
    .inputFormat(streamVideoConfig.inputFormat)
    .inputOptions(getVideoDecoderInputOptions())
    .outputOptions("-fflags", "nobuffer")
    .outputOptions("-flags", "low_delay")
    .outputOptions("-an")
    .outputOptions("-sn")
    .outputOptions("-dn")
    .outputOptions("-pix_fmt", streamVideoConfig.outputPixelFormat)
    .outputOptions("-f", "rawvideo")
    .outputOptions("-vcodec", "rawvideo")
    .on("start", (cmd) => log("ffmpeg video decoder started:", cmd))
    .on("error", (error) => log("ffmpeg video decoder error:", error?.message || String(error)))
    .on("end", () => log("ffmpeg video decoder ended"));

  ffmpegOutput = ffmpegCommand.pipe();
  ffmpegOutput.on("data", handleDecodedVideoChunk);
  ffmpegOutput.on("error", (error) => {
    log("ffmpeg video output error:", error?.message || String(error));
  });
};

const dispatchVideoSample = (sampleData: Buffer) => {
  if (!sampleData || sampleData.length < 1 || !ffmpegInput || !ffmpegInput.writable || ffmpegInputBlocked) {
    return;
  }

  const ok = ffmpegInput.write(sampleData);
  if (!ok) {
    ffmpegInputBlocked = true;
    ffmpegInput.once("drain", () => {
      ffmpegInputBlocked = false;
    });
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

const dispatchHapticsFrameAsRumble = (frame: any) => {
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

  broadcastText({
    type: "session_event",
    name: "rumble",
    event: {
      name: "rumble",
      unknown: buffer[0],
      left,
      right,
      peakLeft: formatHapticPeak(peakLeft),
      peakRight: formatHapticPeak(peakRight),
    },
  });
};

const cleanupSessionOnly = () => {
  for (const socket of wsClients) {
    releaseClientPressedButtons(socket, "session-stop");
  }
  controllerButtonRefCounts.clear();
  controllerState.buttons = 0;
  controllerState.l2State = 0;
  controllerState.r2State = 0;
  controllerState.leftX = 0;
  controllerState.leftY = 0;
  controllerState.rightX = 0;
  controllerState.rightY = 0;
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

  destroyVideoPipeline();
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
  let profileCodec = resolveCodec(args.videoProfile?.codec || settingsCodec || "H265");
  const isWindowsRealtime1080p60 =
    process.platform === "win32" &&
    profileResolution.width >= 1920 &&
    profileResolution.height >= 1080 &&
    profileFps >= 60;
  if (isWindowsRealtime1080p60 && profileCodec === (chiaki as any).codecs.H265) {
    profileCodec = (chiaki as any).codecs.H264;
    log("forcing H264 on Windows for 1080p60 stream to improve frame pacing");
  }
  const outputFormat = resolveOutputFormat(
    profileCodec,
    profileResolution.width,
    profileResolution.height
  );
  const psnAccountId = resolvePsnAccountId(args.loginInfo);
  const ps5 = typeof args.ps5 === "boolean"
    ? args.ps5
    : !String(consoleInfo.apName || "").toUpperCase().includes("PS4");

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
      broadcastText({
        type: "session_event",
        name: event?.name || "unknown",
        event: serializeSessionEvent(event),
      });

      if (event?.name === "connected") {
        broadcastText({ type: "session_status", status: "connected" });
        pushControllerState("connected-init");
      } else if (event?.name === "quit") {
        broadcastText({ type: "session_status", status: "quit" });
      } else {
        broadcastText({ type: "session_status", status: event?.name || "unknown" });
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
      dispatchHapticsFrameAsRumble(frame);
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

  return {
    resolution,
    rtt: rttMs > 0 ? `${rttMs.toFixed(2)} ms` : "--",
    fps: decodedFps > 0 ? `${decodedFps.toFixed(2)}` : "--",
    fl: `${framesLostCount}`,
    pl: packetLossRatio > 0 ? `${(packetLossRatio * 100).toFixed(2)} %` : "0.00 %",
    br: measuredBitrateMbps > 0 ? `${measuredBitrateMbps.toFixed(2)} Mbps` : "0.00 Mbps",
    decode: decodeAvgMs > 0 ? `${decodeAvgMs.toFixed(2)} ms` : "--",
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

  if (streamSession || streamSessionStarted) {
    await stopSession(false);
  }

  const sessionOptions = buildSessionOptions(args);
  createVideoDecodePipeline();
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
    });
  }
  broadcastAudioConfig();

  return {
    ...wsInfo,
    video: streamVideoConfig,
    audioEnabled: !!audioHeaderInfo,
    binaryTransport: canUseNativeStreamBinary() ? "electron-ipc" : "websocket",
  };
};

export const StreamSessionService = {
  attachStreamWebContents,
  startSocketServer,
  stopSocketServer,
  startSession,
  setControllerStateDirect,
  notifyVideoFrameRendered,
  stopSession,
  gotoBedAndStop,
  getPerformanceStats,
};

import http from "node:http";
import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import WS from "ws";
import chiaki from "../chiaki/chiaki.node";

const STREAM_WS_HOST = "127.0.0.1";
const STREAM_WS_PATH = "/stream";
const WS_BINARY_VIDEO = 1;
const WS_BINARY_AUDIO = 2;
const MAX_CLIENT_BACKLOG_BYTES = 8 * 1024 * 1024;
const PIX_FMT = "yuv420p";

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
const ffmpegPath = (ffmpegInstaller as any).path;

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

type StartStreamSessionArgs = {
  streamHost?: string;
  host?: string;
  isRemote?: boolean;
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
  frameSize: number;
  inputFormat: string;
};

const wsClients = new Set<any>();
const wsClientPressedButtons = new Map<any, Set<string>>();

let initialized = false;
let streamHttpServer: http.Server | null = null;
let streamWebSocketServer: any = null;
let streamWebSocketPort = 0;

let streamSession: any = null;
let streamSessionStarted = false;

let streamVideoConfig: VideoConfig | null = null;
let ffmpegInput: PassThrough | null = null;
let ffmpegCommand: any = null;
let ffmpegOutput: any = null;
let ffmpegInputBlocked = false;
const pendingChunks: Buffer[] = [];
let pendingBytes = 0;

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

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

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
  initialized = true;

  if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
  }
  if (typeof (chiaki as any).init === "function") {
    (chiaki as any).init();
  }
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
    format: "I420",
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

const broadcastTypedBinary = (kind: number, payload: Buffer) => {
  if (wsClients.size < 1 || !payload || payload.length < 1) {
    return;
  }

  const packet = Buffer.concat([Buffer.from([kind]), payload]);
  for (const client of wsClients) {
    if (!client || client.readyState !== 1) {
      continue;
    }
    if ((client as any).bufferedAmount > MAX_CLIENT_BACKLOG_BYTES) {
      continue;
    }

    try {
      client.send(packet, { binary: true });
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

const handleWsControlState = (message: any) => {
  const state = message?.state;
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

  pushControllerState("ws:state");
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

const destroyVideoPipeline = () => {
  pendingChunks.length = 0;
  pendingBytes = 0;
  ffmpegInputBlocked = false;

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

const handleDecodedVideoChunk = (chunk: Buffer) => {
  if (!chunk || chunk.length < 1 || !streamVideoConfig) {
    return;
  }

  const frameSize = streamVideoConfig.frameSize;
  pendingChunks.push(chunk);
  pendingBytes += chunk.length;

  while (pendingBytes >= frameSize) {
    const frame = Buffer.allocUnsafe(frameSize);
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
    broadcastTypedBinary(WS_BINARY_VIDEO, frame);
  }

  if (pendingBytes > frameSize * 8) {
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
    .inputOptions("-fflags", "+genpts")
    .outputOptions("-fflags", "nobuffer")
    .outputOptions("-flags", "low_delay")
    .outputOptions("-an")
    .outputOptions("-sn")
    .outputOptions("-dn")
    .outputOptions("-r", String(streamVideoConfig.fps))
    .outputOptions("-pix_fmt", PIX_FMT)
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

const writeAudioInput = (data: Buffer) => {
  if (!audioDecoderInput || !audioDecoderInput.writable || audioInputBlocked) {
    return false;
  }

  const ok = audioDecoderInput.write(data);
  if (!ok) {
    audioInputBlocked = true;
    audioDecoderInput.once("drain", () => {
      audioInputBlocked = false;
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
    const pcm = Buffer.allocUnsafe(audioChunkBytes);
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
  const profileCodec = resolveCodec(args.videoProfile?.codec || settingsCodec || "H265");
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
    frameSize: Math.floor((profileResolution.width * profileResolution.height * 3) / 2),
    inputFormat: resolveInputFormat(profileCodec),
  };

  return {
    host,
    ps5,
    enableDualsense: args.enableDualsense !== false,
    registKey,
    morning,
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
    onLog: (event) => {
      console.log(`[chiaki:${event.levelChar}]`, event.message);
    },
    onVideoSample: (sample) => {
      dispatchVideoSample(sample.data);
    },
    onAudioHeader: (header) => {
      onAudioHeader(header);
    },
    onAudioFrame: (frame) => {
      dispatchAudioFrame(frame.data);
    },
  });
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
      format: "I420",
      frameSize: streamVideoConfig.frameSize,
    });
  }
  broadcastAudioConfig();

  return {
    ...wsInfo,
    video: streamVideoConfig,
    audioEnabled: !!audioHeaderInfo,
  };
};

export const StreamSessionService = {
  startSocketServer,
  stopSocketServer,
  startSession,
  stopSession,
  gotoBedAndStop,
};

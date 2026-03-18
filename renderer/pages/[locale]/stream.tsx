import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import { addToast } from "@heroui/react";
import ActionBar from "../../components/ActionBar";
import Alert from "../../components/Alert";
import Loading from "../../components/Loading";
import Perform from "../../components/Perform";
import { useSettings } from "../../context/userContext";
import { defaultSettings } from "../../context/userContext.defaults";
import { handleGamepadLedColorFromChiaki } from "../../lib/gamepadLedColor";
import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";
import { triggerGamepadRumbleFromChiaki } from "../../lib/gamepadRumble";
import { handleGamepadTriggerEffectsFromChiaki } from "../../lib/gamepadTriggerEffects";
import Ipc from "../../lib/ipc";

const PENDING_STREAM_STORAGE_KEY = "pending-stream-config";
const WS_BINARY_VIDEO = 1;
const WS_BINARY_AUDIO = 2;
const MAX_PENDING_AUDIO_BYTES = 4 * 1024 * 1024;
const AUDIO_CONTEXT_LATENCY_SEC = 0.08;
const AUDIO_SCHEDULE_LEAD_SEC = 0.12;
const AUDIO_MAX_BUFFER_SEC = 0.3;
const AUDIO_EDGE_FADE_SEC = 0.002;
const SHORT_PS_PRESS_MS = 150;
const LONG_PS_PRESS_MS = 1000;

type PendingStreamConfig = {
  streamHost?: string;
  isRemote?: boolean;
  consoleInfo?: {
    apName?: string;
    host?: string;
    remoteHost?: string;
    parsedRemoteHost?: string;
    rpRegistKey?: string;
    rpKey?: string;
    registKey?: string;
    morning?: string;
  };
};

const clamp = (value: number) => {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
};

const GAMEPAD_DEADZONE = 0.12;

const CONTROLLER_BUTTONS = {
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

const CONTROLLER_ANALOG_BUTTONS = {
  L2: 1 << 16,
  R2: 1 << 17,
};

const KEYBOARD_BUTTON_ACTION_MASKS = {
  DPadUp: CONTROLLER_BUTTONS.DPAD_UP,
  DPadDown: CONTROLLER_BUTTONS.DPAD_DOWN,
  DPadLeft: CONTROLLER_BUTTONS.DPAD_LEFT,
  DPadRight: CONTROLLER_BUTTONS.DPAD_RIGHT,
  A: CONTROLLER_BUTTONS.CROSS,
  B: CONTROLLER_BUTTONS.MOON,
  X: CONTROLLER_BUTTONS.BOX,
  Y: CONTROLLER_BUTTONS.PYRAMID,
  View: CONTROLLER_BUTTONS.SHARE,
  Menu: CONTROLLER_BUTTONS.OPTIONS,
  Nexus: CONTROLLER_BUTTONS.PS,
  Touchpad: CONTROLLER_BUTTONS.TOUCHPAD,
  LeftShoulder: CONTROLLER_BUTTONS.L1,
  RightShoulder: CONTROLLER_BUTTONS.R1,
  LeftThumb: CONTROLLER_BUTTONS.L3,
  RightThumb: CONTROLLER_BUTTONS.R3,
} as const;

const KEYBOARD_INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const DEFAULT_KEYBOARD_MAPPING = defaultSettings.input_mousekeyboard_maping;
const LEGACY_TOUCHPAD_KEY = "t";
const LEGACY_RIGHT_STICK_UP_KEY = "r";

type ControllerStatePayload = {
  buttons: number;
  l2State: number;
  r2State: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
};

type VideoFrameFormat = "I420" | "I010";

type HdrWebglRenderer = {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vertexArray: WebGLVertexArrayObject;
  vertexBuffer: WebGLBuffer;
  yTexture: WebGLTexture;
  uTexture: WebGLTexture;
  vTexture: WebGLTexture;
  width: number;
  height: number;
};

type SdrWebglRenderer = {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vertexArray: WebGLVertexArrayObject;
  vertexBuffer: WebGLBuffer;
  yTexture: WebGLTexture;
  uTexture: WebGLTexture;
  vTexture: WebGLTexture;
  width: number;
  height: number;
};

const SDR_VERTEX_SHADER_SOURCE = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;

void main() {
  v_texCoord = a_texCoord;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const SDR_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

in vec2 v_texCoord;
uniform sampler2D u_texY;
uniform sampler2D u_texU;
uniform sampler2D u_texV;
out vec4 outColor;

void main() {
  float y = texture(u_texY, v_texCoord).r;
  float u = texture(u_texU, v_texCoord).r - 0.5;
  float v = texture(u_texV, v_texCoord).r - 0.5;

  float c = max(y - 0.062745098, 0.0) * 1.16438356;
  float r = c + 1.59602678 * v;
  float g = c - 0.39176229 * u - 0.81296764 * v;
  float b = c + 2.01723214 * u;

  outColor = vec4(clamp(vec3(r, g, b), 0.0, 1.0), 1.0);
}
`;

const HDR_VERTEX_SHADER_SOURCE = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;

void main() {
  v_texCoord = a_texCoord;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const HDR_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;
precision highp usampler2D;

in vec2 v_texCoord;
uniform usampler2D u_texY;
uniform usampler2D u_texU;
uniform usampler2D u_texV;
out vec4 outColor;

vec3 pqToLinear(vec3 value) {
  const float m1 = 0.1593017578125;
  const float m2 = 78.84375;
  const float c1 = 0.8359375;
  const float c2 = 18.8515625;
  const float c3 = 18.6875;

  vec3 powered = pow(max(value, vec3(0.0)), vec3(1.0 / m2));
  vec3 numerator = max(powered - vec3(c1), vec3(0.0));
  vec3 denominator = max(vec3(c2) - vec3(c3) * powered, vec3(1e-6));
  return pow(numerator / denominator, vec3(1.0 / m1));
}

vec3 acesTonemap(vec3 value) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((value * (a * value + b)) / (value * (c * value + d) + e), 0.0, 1.0);
}

vec3 linearToSrgb(vec3 value) {
  vec3 lower = value * 12.92;
  vec3 higher = 1.055 * pow(max(value, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  vec3 cutoff = step(vec3(0.0031308), value);
  return mix(lower, higher, cutoff);
}

void main() {
  ivec2 ySize = textureSize(u_texY, 0);
  ivec2 uvSize = textureSize(u_texU, 0);
  ivec2 yCoord = min(ivec2(v_texCoord * vec2(ySize)), ySize - ivec2(1));
  ivec2 uvCoord = min(ivec2(v_texCoord * vec2(uvSize)), uvSize - ivec2(1));

  float yRaw = float(texelFetch(u_texY, yCoord, 0).r & 1023u);
  float uRaw = float(texelFetch(u_texU, uvCoord, 0).r & 1023u);
  float vRaw = float(texelFetch(u_texV, uvCoord, 0).r & 1023u);

  float y = clamp((yRaw - 64.0) / 876.0, 0.0, 1.0);
  float cb = clamp((uRaw - 512.0) / 896.0, -0.5, 0.5);
  float cr = clamp((vRaw - 512.0) / 896.0, -0.5, 0.5);

  vec3 pqRgb = clamp(vec3(
    y + 1.4746 * cr,
    y - 0.164553 * cb - 0.571353 * cr,
    y + 1.8814 * cb
  ), 0.0, 1.0);

  vec3 linearHdr = pqToLinear(pqRgb) * (10000.0 / 203.0);
  vec3 linearSdr = acesTonemap(linearHdr);
  vec3 srgb = linearToSrgb(linearSdr);
  outColor = vec4(srgb, 1.0);
}
`;

const NON_ERROR_SESSION_EVENT_NAMES = new Set([
  "connected",
  "holepunch",
  "nickname_received",
  "keyboard_open",
  "keyboard_text_change",
  "keyboard_remote_close",
  "rumble",
  "trigger_effects",
  "motion_reset",
  "led_color",
  "haptic_intensity",
  "trigger_intensity",
  "haptic_audio",
]);

const buildSessionEventErrorMessage = (
  event: any,
  t: (key: string, options?: Record<string, any>) => string
) => {
  const sessionEvent =
    event && typeof event === "object" ? event : { name: String(event || "unknown") };
  const name = String(sessionEvent.name || "unknown");

  if (name === "quit") {
    const lines = [
      `${t("EventLabel")}: ${name}`,
      `${t("ReasonLabel")}: ${String(sessionEvent.reasonName || sessionEvent.reason || "-")}`,
    ];
    if (sessionEvent.reasonText) {
      lines.push(`${t("DetailLabel")}: ${String(sessionEvent.reasonText)}`);
    }
    return lines.join("\n");
  }

  if (name === "login_pin_request") {
    return [
      `${t("EventLabel")}: ${name}`,
      `${t("PinIncorrectLabel")}: ${String(!!sessionEvent.pinIncorrect)}`,
      t("LoginPinRequestNotHandled"),
    ].join("\n");
  }

  return JSON.stringify(sessionEvent, null, 2);
};

const buildSocketCloseMessage = (
  event: CloseEvent,
  t: (key: string, options?: Record<string, any>) => string
) => {
  const lines = [t("WebSocketCloseEvent"), `${t("CodeLabel")}: ${event.code}`];

  if (event.reason) {
    lines.push(`${t("ReasonLabel")}: ${event.reason}`);
  }

  lines.push(`${t("WasCleanLabel")}: ${String(event.wasClean)}`);
  return lines.join("\n");
};

const getErrorMessage = (error: any, fallback: string) => {
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  if (error?.message && typeof error.message === "string") {
    return error.message;
  }

  return fallback;
};

const normalizeKeyboardMapping = (value: unknown) => {
  if (!value || typeof value !== "object") {
    return DEFAULT_KEYBOARD_MAPPING as Record<string, string>;
  }

  const nextMapping: Record<string, string> = {};
  for (const [key, action] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key === "string" && typeof action === "string") {
      nextMapping[key] = action;
    }
  }

  const mergedMapping = {
    ...DEFAULT_KEYBOARD_MAPPING,
    ...nextMapping,
  } as Record<string, string>;
  const rawTouchpadBinding = nextMapping[LEGACY_TOUCHPAD_KEY];
  const hasTouchpadBinding = Object.values(nextMapping).includes("Touchpad");
  const hasRightStickUpBindingOnOtherKey = Object.entries(nextMapping).some(
    ([key, action]) =>
      key !== LEGACY_TOUCHPAD_KEY && action === "RightThumbYAxisPlus"
  );

  if (!hasTouchpadBinding) {
    if (
      rawTouchpadBinding === "RightThumbYAxisPlus" &&
      !hasRightStickUpBindingOnOtherKey
    ) {
      mergedMapping[LEGACY_RIGHT_STICK_UP_KEY] = "RightThumbYAxisPlus";
      delete mergedMapping[LEGACY_TOUCHPAD_KEY];
    } else if (rawTouchpadBinding && rawTouchpadBinding !== "Touchpad") {
      return mergedMapping;
    }

    mergedMapping[LEGACY_TOUCHPAD_KEY] = "Touchpad";
  }

  return mergedMapping;
};

const mergeAnalogInput = (gamepadValue: number, keyboardValue: number) => {
  return Math.abs(keyboardValue) >= Math.abs(gamepadValue) ? keyboardValue : gamepadValue;
};

const getKeyboardAxisValue = (
  activeActions: Set<string>,
  negativeAction: string,
  positiveAction: string
) => {
  const negative = activeActions.has(negativeAction) ? -1 : 0;
  const positive = activeActions.has(positiveAction) ? 1 : 0;
  return Math.max(-1, Math.min(1, negative + positive));
};

const isEditableKeyboardTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return KEYBOARD_INPUT_TAGS.has(target.tagName) || target.isContentEditable;
};

function StreamPage() {
  const { t } = useTranslation("stream");
  const router = useRouter();
  const { settings } = useSettings();

  const [status, setStatus] = useState("");
  const [connectState, setConnectState] = useState("initializing");
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [audioMuted, setAudioMuted] = useState(false);
  const [showPerformance, setShowPerformance] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [videoFormat, setVideoFormat] = useState<VideoFrameFormat>("I420");
  const [sessionAlert, setSessionAlert] = useState<{
    title: string;
    content: string;
  } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hdrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const rafRef = useRef<number | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsUrlRef = useRef("");
  const statsTextRef = useRef("");

  const widthRef = useRef(1280);
  const heightRef = useRef(720);
  const fpsRef = useRef(60);
  const frameSizeRef = useRef(Math.floor((1280 * 720 * 3) / 2));
  const videoFormatRef = useRef<VideoFrameFormat>("I420");
  const latestFrameRef = useRef<Uint8Array | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);
  const sdrRendererRef = useRef<SdrWebglRenderer | null>(null);
  const sdrGpuRenderingDisabledRef = useRef(false);
  const hdrRendererRef = useRef<HdrWebglRenderer | null>(null);

  const receivedFramesRef = useRef(0);
  const renderedFramesRef = useRef(0);
  const droppedFramesRef = useRef(0);
  const lastRenderFramesRef = useRef(0);
  const lastStatsAtRef = useRef(Date.now());

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioGainNodeRef = useRef<GainNode | null>(null);
  const audioUnlockedRef = useRef(false);
  const audioAvailableRef = useRef(false);
  const audioMutedRef = useRef(false);
  const audioPlaybackEnabledRef = useRef(false);
  const audioChannelsRef = useRef(2);
  const audioRateRef = useRef(48000);
  const audioFrameSamplesRef = useRef(960);
  const nextAudioTimeRef = useRef(0);
  const pendingAudioQueueRef = useRef<ArrayBuffer[]>([]);
  const pendingAudioBytesRef = useRef(0);
  const audioReceivedChunksRef = useRef(0);
  const audioPlayedChunksRef = useRef(0);
  const audioDroppedChunksRef = useRef(0);
  const validGamepadCountRef = useRef(0);
  const controlSendCountRef = useRef(0);
  const controlSendErrorCountRef = useRef(0);
  const lastControlStateKeyRef = useRef("");
  const disconnectingRef = useRef(false);
  const connectedToastShownRef = useRef(false);
  const sessionConnectedRef = useRef(false);
  const videoReadyRef = useRef(false);
  const sessionErrorHandledRef = useRef(false);
  const connectedToastRafRef = useRef<number | null>(null);
  const audioStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardPressedKeysRef = useRef<Map<string, string>>(new Map());
  const keyboardMappingRef = useRef<Record<string, string>>(DEFAULT_KEYBOARD_MAPPING);

  const isSessionConnected = connectState === "connected";
  const shouldShowVideo = isSessionConnected && videoReady;

  const openSessionAlert = (content: string, nextStatus?: string) => {
    if (sessionErrorHandledRef.current || disconnectingRef.current) {
      return;
    }

    sessionErrorHandledRef.current = true;
    setConnectState("session_error");
    setStatus(nextStatus || t("Session error"));
    setSessionAlert({
      title: t("Session error"),
      content,
    });
  };

  useEffect(() => {
    keyboardMappingRef.current = normalizeKeyboardMapping(
      settings?.input_mousekeyboard_maping
    );
  }, [settings?.input_mousekeyboard_maping]);

  const clearPressedKeyboardKeys = () => {
    keyboardPressedKeysRef.current.clear();
  };

  const applyVideoConfig = (config: any) => {
    const width = Number(config?.width || widthRef.current);
    const height = Number(config?.height || heightRef.current);
    const fps = Number(config?.fps || fpsRef.current);
    const format = config?.format === "I010" ? "I010" : "I420";
    const frameSize =
      Number(config?.frameSize) ||
      (format === "I010" ? width * height * 3 : Math.floor((width * height * 3) / 2));

    widthRef.current = width;
    heightRef.current = height;
    fpsRef.current = fps;
    frameSizeRef.current = frameSize;
    videoFormatRef.current = format;
    setVideoFormat(format);
    imageDataRef.current = null;
    ctxRef.current = null;

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = width;
      canvas.height = height;
    }

    const hdrCanvas = hdrCanvasRef.current;
    if (hdrCanvas) {
      hdrCanvas.width = width;
      hdrCanvas.height = height;
    }

    if (format !== "I010") {
      destroyHdrRenderer();
    }

    if (format === "I010" && !window.WebGL2RenderingContext) {
      openSessionAlert(t("HdrWebgl2Required"));
    }
  };

  const setAudioMutedState = (muted: boolean) => {
    audioMutedRef.current = muted;
    setAudioMuted(muted);

    if (audioGainNodeRef.current) {
      audioGainNodeRef.current.gain.value = muted ? 0 : 1;
    }
  };

  const applyAudioConfig = (config: any) => {
    const available = !!config?.enabled;
    audioAvailableRef.current = available;
    setAudioAvailable(available);
    if (!available) {
      nextAudioTimeRef.current = 0;
      pendingAudioQueueRef.current = [];
      pendingAudioBytesRef.current = 0;
      setAudioMutedState(false);
      return;
    }

    const channels = Number(config?.channels || audioChannelsRef.current);
    const rate = Number(config?.rate || audioRateRef.current);
    const frameSamples = Number(config?.frameSamples || audioFrameSamplesRef.current);

    if (channels > 0) audioChannelsRef.current = channels;
    if (rate > 0) audioRateRef.current = rate;
    if (frameSamples > 0) audioFrameSamplesRef.current = frameSamples;
    void ensureAudioContext();
  };

  const ensure2dContext = () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    if (!ctxRef.current) {
      ctxRef.current = canvas.getContext("2d", { alpha: false, desynchronized: true });
    }
    if (!ctxRef.current) {
      return null;
    }

    if (
      !imageDataRef.current ||
      imageDataRef.current.width !== widthRef.current ||
      imageDataRef.current.height !== heightRef.current
    ) {
      imageDataRef.current = ctxRef.current.createImageData(widthRef.current, heightRef.current);
    }

    return {
      ctx: ctxRef.current,
      imageData: imageDataRef.current,
    };
  };

  const drawI420Cpu = (frameBytes: Uint8Array) => {
    const renderingContext = ensure2dContext();
    if (!renderingContext) {
      return;
    }

    const width = widthRef.current;
    const height = heightRef.current;
    const yPlaneSize = width * height;
    const uvWidth = width >> 1;
    const uvHeight = height >> 1;
    const uPlaneOffset = yPlaneSize;
    const vPlaneOffset = uPlaneOffset + uvWidth * uvHeight;
    const output = renderingContext.imageData.data;

    let outIndex = 0;
    for (let y = 0; y < height; y += 1) {
      const yRow = y * width;
      const uvRow = (y >> 1) * uvWidth;
      for (let x = 0; x < width; x += 1) {
        const yVal = frameBytes[yRow + x];
        const uvIndex = uvRow + (x >> 1);
        const uVal = frameBytes[uPlaneOffset + uvIndex];
        const vVal = frameBytes[vPlaneOffset + uvIndex];

        const c = yVal - 16;
        const d = uVal - 128;
        const e = vVal - 128;
        const r = (298 * c + 409 * e + 128) >> 8;
        const g = (298 * c - 100 * d - 208 * e + 128) >> 8;
        const b = (298 * c + 516 * d + 128) >> 8;

        output[outIndex++] = clamp(r);
        output[outIndex++] = clamp(g);
        output[outIndex++] = clamp(b);
        output[outIndex++] = 255;
      }
    }

    renderingContext.ctx.putImageData(renderingContext.imageData, 0, 0);
  };

  const destroySdrRenderer = () => {
    const renderer = sdrRendererRef.current;
    if (!renderer) {
      return;
    }

    const { gl } = renderer;
    gl.deleteTexture(renderer.yTexture);
    gl.deleteTexture(renderer.uTexture);
    gl.deleteTexture(renderer.vTexture);
    gl.deleteBuffer(renderer.vertexBuffer);
    gl.deleteVertexArray(renderer.vertexArray);
    gl.deleteProgram(renderer.program);
    sdrRendererRef.current = null;
  };

  const destroyHdrRenderer = () => {
    const renderer = hdrRendererRef.current;
    if (!renderer) {
      return;
    }

    const { gl } = renderer;
    gl.deleteTexture(renderer.yTexture);
    gl.deleteTexture(renderer.uTexture);
    gl.deleteTexture(renderer.vTexture);
    gl.deleteBuffer(renderer.vertexBuffer);
    gl.deleteVertexArray(renderer.vertexArray);
    gl.deleteProgram(renderer.program);
    hdrRendererRef.current = null;
  };

  const compileWebglShader = (
    gl: WebGL2RenderingContext,
    type: number,
    source: string
  ) => {
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error("Failed to create HDR shader.");
    }

    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader) || "Unknown HDR shader compile error.";
      gl.deleteShader(shader);
      throw new Error(error);
    }

    return shader;
  };

  const createSdrTexture = (
    gl: WebGL2RenderingContext,
    textureUnit: number,
    width: number,
    height: number
  ) => {
    const texture = gl.createTexture();
    if (!texture) {
      throw new Error("Failed to create SDR texture.");
    }

    gl.activeTexture(textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      width,
      height,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      null
    );

    return texture;
  };

  const createHdrTexture = (
    gl: WebGL2RenderingContext,
    textureUnit: number,
    width: number,
    height: number
  ) => {
    const texture = gl.createTexture();
    if (!texture) {
      throw new Error("Failed to create HDR texture.");
    }

    gl.activeTexture(textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R16UI,
      width,
      height,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      null
    );

    return texture;
  };

  const createSdrRenderer = (width: number, height: number) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      desynchronized: true,
    });
    if (!gl) {
      return null;
    }

    const vertexShader = compileWebglShader(gl, gl.VERTEX_SHADER, SDR_VERTEX_SHADER_SOURCE);
    const fragmentShader = compileWebglShader(gl, gl.FRAGMENT_SHADER, SDR_FRAGMENT_SHADER_SOURCE);
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      throw new Error("Failed to create SDR program.");
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(program) || "Unknown SDR shader link error.";
      gl.deleteProgram(program);
      throw new Error(error);
    }

    const vertexArray = gl.createVertexArray();
    const vertexBuffer = gl.createBuffer();
    if (!vertexArray || !vertexBuffer) {
      if (vertexArray) gl.deleteVertexArray(vertexArray);
      if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
      gl.deleteProgram(program);
      throw new Error("Failed to create SDR vertex buffers.");
    }

    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1, 0, 1,
        1, -1, 1, 1,
        -1, 1, 0, 0,
        -1, 1, 0, 0,
        1, -1, 1, 1,
        1, 1, 1, 0,
      ]),
      gl.STATIC_DRAW
    );

    const positionLocation = gl.getAttribLocation(program, "a_position");
    const texCoordLocation = gl.getAttribLocation(program, "a_texCoord");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(texCoordLocation);
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 16, 8);

    const yTexture = createSdrTexture(gl, gl.TEXTURE0, width, height);
    const uTexture = createSdrTexture(gl, gl.TEXTURE1, width >> 1, height >> 1);
    const vTexture = createSdrTexture(gl, gl.TEXTURE2, width >> 1, height >> 1);

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "u_texY"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "u_texU"), 1);
    gl.uniform1i(gl.getUniformLocation(program, "u_texV"), 2);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.viewport(0, 0, width, height);

    return {
      gl,
      program,
      vertexArray,
      vertexBuffer,
      yTexture,
      uTexture,
      vTexture,
      width,
      height,
    };
  };

  const createHdrRenderer = (width: number, height: number) => {
    const canvas = hdrCanvasRef.current;
    if (!canvas) {
      throw new Error("HDR canvas is unavailable.");
    }

    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      throw new Error("WebGL2 is unavailable.");
    }

    const vertexShader = compileWebglShader(gl, gl.VERTEX_SHADER, HDR_VERTEX_SHADER_SOURCE);
    const fragmentShader = compileWebglShader(gl, gl.FRAGMENT_SHADER, HDR_FRAGMENT_SHADER_SOURCE);
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      throw new Error("Failed to create HDR program.");
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(program) || "Unknown HDR shader link error.";
      gl.deleteProgram(program);
      throw new Error(error);
    }

    const vertexArray = gl.createVertexArray();
    const vertexBuffer = gl.createBuffer();
    if (!vertexArray || !vertexBuffer) {
      if (vertexArray) gl.deleteVertexArray(vertexArray);
      if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
      gl.deleteProgram(program);
      throw new Error("Failed to create HDR vertex buffers.");
    }

    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1, 0, 1,
        1, -1, 1, 1,
        -1, 1, 0, 0,
        -1, 1, 0, 0,
        1, -1, 1, 1,
        1, 1, 1, 0,
      ]),
      gl.STATIC_DRAW
    );

    const positionLocation = gl.getAttribLocation(program, "a_position");
    const texCoordLocation = gl.getAttribLocation(program, "a_texCoord");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(texCoordLocation);
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 16, 8);

    const yTexture = createHdrTexture(gl, gl.TEXTURE0, width, height);
    const uTexture = createHdrTexture(gl, gl.TEXTURE1, width >> 1, height >> 1);
    const vTexture = createHdrTexture(gl, gl.TEXTURE2, width >> 1, height >> 1);

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "u_texY"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "u_texU"), 1);
    gl.uniform1i(gl.getUniformLocation(program, "u_texV"), 2);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.viewport(0, 0, width, height);

    return {
      gl,
      program,
      vertexArray,
      vertexBuffer,
      yTexture,
      uTexture,
      vTexture,
      width,
      height,
    };
  };

  const ensureHdrRenderer = () => {
    const width = widthRef.current;
    const height = heightRef.current;
    const renderer = hdrRendererRef.current;

    if (renderer && renderer.width === width && renderer.height === height) {
      return renderer;
    }

    destroyHdrRenderer();
    const nextRenderer = createHdrRenderer(width, height);
    hdrRendererRef.current = nextRenderer;
    return nextRenderer;
  };

  const ensureSdrRenderer = () => {
    if (sdrGpuRenderingDisabledRef.current) {
      return null;
    }

    const width = widthRef.current;
    const height = heightRef.current;
    const renderer = sdrRendererRef.current;

    if (renderer && renderer.width === width && renderer.height === height) {
      return renderer;
    }

    destroySdrRenderer();

    try {
      const nextRenderer = createSdrRenderer(width, height);
      if (!nextRenderer) {
        sdrGpuRenderingDisabledRef.current = true;
        return null;
      }
      sdrRendererRef.current = nextRenderer;
      return nextRenderer;
    } catch (error) {
      destroySdrRenderer();
      sdrGpuRenderingDisabledRef.current = true;
      console.warn("[stream] Failed to initialize SDR WebGL renderer, fallback to CPU:", error);
      return null;
    }
  };

  const drawI420Gpu = (frameBytes: Uint8Array) => {
    const renderer = ensureSdrRenderer();
    if (!renderer) {
      return false;
    }

    const width = widthRef.current;
    const height = heightRef.current;
    const yPlaneSize = width * height;
    const uvWidth = width >> 1;
    const uvHeight = height >> 1;
    const uvPlaneSize = uvWidth * uvHeight;

    if (frameBytes.byteLength < yPlaneSize + uvPlaneSize * 2) {
      return false;
    }

    const yPlane = frameBytes.subarray(0, yPlaneSize);
    const uPlane = frameBytes.subarray(yPlaneSize, yPlaneSize + uvPlaneSize);
    const vPlane = frameBytes.subarray(yPlaneSize + uvPlaneSize, yPlaneSize + uvPlaneSize * 2);

    const { gl } = renderer;
    gl.viewport(0, 0, width, height);
    gl.useProgram(renderer.program);
    gl.bindVertexArray(renderer.vertexArray);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, renderer.yTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.UNSIGNED_BYTE, yPlane);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, renderer.uTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      uvWidth,
      uvHeight,
      gl.RED,
      gl.UNSIGNED_BYTE,
      uPlane
    );

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, renderer.vTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      uvWidth,
      uvHeight,
      gl.RED,
      gl.UNSIGNED_BYTE,
      vPlane
    );

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return true;
  };

  const drawI010HdrFrame = (frameBytes: Uint8Array) => {
    const renderer = ensureHdrRenderer();
    const width = widthRef.current;
    const height = heightRef.current;
    const yPlaneBytes = width * height * 2;
    const uvWidth = width >> 1;
    const uvHeight = height >> 1;
    const uvPlaneBytes = uvWidth * uvHeight * 2;

    if (frameBytes.byteLength < yPlaneBytes + uvPlaneBytes * 2) {
      return;
    }

    const yPlane = new Uint16Array(frameBytes.buffer, 0, yPlaneBytes >> 1);
    const uPlane = new Uint16Array(frameBytes.buffer, yPlaneBytes, uvPlaneBytes >> 1);
    const vPlane = new Uint16Array(
      frameBytes.buffer,
      yPlaneBytes + uvPlaneBytes,
      uvPlaneBytes >> 1
    );

    const { gl } = renderer;
    gl.viewport(0, 0, width, height);
    gl.useProgram(renderer.program);
    gl.bindVertexArray(renderer.vertexArray);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, renderer.yTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED_INTEGER, gl.UNSIGNED_SHORT, yPlane);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, renderer.uTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      uvWidth,
      uvHeight,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      uPlane
    );

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, renderer.vTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      uvWidth,
      uvHeight,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      vPlane
    );

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const queueAudioBuffer = (arrayBuffer: ArrayBuffer) => {
    pendingAudioQueueRef.current.push(arrayBuffer);
    pendingAudioBytesRef.current += arrayBuffer.byteLength;

    while (
      pendingAudioBytesRef.current > MAX_PENDING_AUDIO_BYTES &&
      pendingAudioQueueRef.current.length > 0
    ) {
      const dropped = pendingAudioQueueRef.current.shift();
      if (dropped) {
        pendingAudioBytesRef.current -= dropped.byteLength;
        audioDroppedChunksRef.current += 1;
      }
    }
  };

  const playAudioChunk = (arrayBuffer: ArrayBuffer) => {
    const audioContext = audioContextRef.current;
    if (!audioContext || audioContext.state !== "running" || !audioAvailableRef.current) {
      return false;
    }

    const channels = audioChannelsRef.current;
    const sampleRate = audioRateRef.current;
    const pcm = new Float32Array(arrayBuffer);
    if (pcm.length < channels) {
      return false;
    }

    const frames = Math.floor(pcm.length / channels);
    if (frames < 1) {
      return false;
    }

    const audioBuffer = audioContext.createBuffer(channels, frames, sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      const out = audioBuffer.getChannelData(channel);
      let inIndex = channel;
      for (let i = 0; i < frames; i += 1) {
        out[i] = pcm[inIndex];
        inIndex += channels;
      }
    }

    const now = audioContext.currentTime;
    const targetStartTime = now + AUDIO_SCHEDULE_LEAD_SEC;
    if (nextAudioTimeRef.current < targetStartTime) {
      nextAudioTimeRef.current = targetStartTime;
    }
    if (nextAudioTimeRef.current - now > AUDIO_MAX_BUFFER_SEC) {
      nextAudioTimeRef.current = targetStartTime;
      audioDroppedChunksRef.current += 1;
    }

    const source = audioContext.createBufferSource();
    const chunkGain = audioContext.createGain();
    const chunkStartTime = nextAudioTimeRef.current;
    const chunkEndTime = chunkStartTime + audioBuffer.duration;
    const fadeDuration = Math.min(
      AUDIO_EDGE_FADE_SEC,
      Math.max(audioBuffer.duration / 4, 0)
    );

    source.buffer = audioBuffer;
    source.connect(chunkGain);
    chunkGain.connect(audioGainNodeRef.current || audioContext.destination);

    if (fadeDuration > 0) {
      chunkGain.gain.setValueAtTime(0, chunkStartTime);
      chunkGain.gain.linearRampToValueAtTime(1, chunkStartTime + fadeDuration);
      chunkGain.gain.setValueAtTime(1, Math.max(chunkStartTime, chunkEndTime - fadeDuration));
      chunkGain.gain.linearRampToValueAtTime(0, chunkEndTime);
    } else {
      chunkGain.gain.setValueAtTime(1, chunkStartTime);
    }

    source.start(chunkStartTime);
    nextAudioTimeRef.current += audioBuffer.duration;
    audioPlayedChunksRef.current += 1;

    return true;
  };

  const flushPendingAudio = () => {
    while (pendingAudioQueueRef.current.length > 0) {
      const buf = pendingAudioQueueRef.current.shift();
      if (!buf) continue;
      pendingAudioBytesRef.current -= buf.byteLength;
      if (!playAudioChunk(buf)) {
        audioDroppedChunksRef.current += 1;
      }
    }
    if (pendingAudioBytesRef.current < 0) {
      pendingAudioBytesRef.current = 0;
    }
  };

  const handleAudioFrameBytes = (audioBytes: Uint8Array) => {
    if (audioBytes.byteLength < 4) {
      return;
    }

    audioReceivedChunksRef.current += 1;
    const aligned = new Uint8Array(audioBytes.byteLength);
    aligned.set(audioBytes);

    if (
      !audioUnlockedRef.current ||
      !videoReadyRef.current ||
      !audioPlaybackEnabledRef.current
    ) {
      queueAudioBuffer(aligned.buffer);
      return;
    }

    const ok = playAudioChunk(aligned.buffer);
    if (!ok) {
      audioDroppedChunksRef.current += 1;
    }
  };

  const handleVideoFrameBytes = (frameBytes: Uint8Array) => {
    if (frameBytes.byteLength !== frameSizeRef.current) {
      return;
    }

    receivedFramesRef.current += 1;
    if (latestFrameRef.current) {
      droppedFramesRef.current += 1;
    }

    const frame = new Uint8Array(frameBytes.byteLength);
    frame.set(frameBytes);
    latestFrameRef.current = frame;
  };

  const handleBinaryPacket = (packetBytes: Uint8Array) => {
    if (packetBytes.byteLength < 2) {
      return;
    }

    const kind = packetBytes[0];
    const payload = packetBytes.subarray(1);
    if (kind === WS_BINARY_VIDEO) {
      handleVideoFrameBytes(payload);
      return;
    }
    if (kind === WS_BINARY_AUDIO) {
      handleAudioFrameBytes(payload);
    }
  };

  const ensureAudioContext = async (flushPending = false) => {
    if (!audioAvailableRef.current) {
      return;
    }

    if (!audioContextRef.current) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) {
        setStatus(t("AudioContextNotSupported"));
        return;
      }
      audioContextRef.current = new Ctx({ latencyHint: AUDIO_CONTEXT_LATENCY_SEC });
    }

    if (!audioGainNodeRef.current && audioContextRef.current) {
      audioGainNodeRef.current = audioContextRef.current.createGain();
      audioGainNodeRef.current.connect(audioContextRef.current.destination);
    }

    if (audioContextRef.current.state !== "running") {
      try {
        await audioContextRef.current.resume();
      } catch {
        // ignore
      }
    }

    audioUnlockedRef.current = audioContextRef.current.state === "running";
    if (audioUnlockedRef.current) {
      setAudioMutedState(audioMutedRef.current);
      if (flushPending && videoReadyRef.current && audioPlaybackEnabledRef.current) {
        flushPendingAudio();
      }
    }
  };

  const clearConnectedFeedbackTimers = () => {
    if (connectedToastRafRef.current !== null) {
      cancelAnimationFrame(connectedToastRafRef.current);
      connectedToastRafRef.current = null;
    }

    if (audioStartTimerRef.current) {
      clearTimeout(audioStartTimerRef.current);
      audioStartTimerRef.current = null;
    }
  };

  const showConnectedToastThenEnableAudio = () => {
    if (
      !sessionConnectedRef.current ||
      !videoReadyRef.current ||
      connectedToastShownRef.current ||
      disconnectingRef.current
    ) {
      return;
    }

    connectedToastShownRef.current = true;
    clearConnectedFeedbackTimers();

    const runAfterVideoPaint = () => {
      connectedToastRafRef.current = requestAnimationFrame(() => {
        connectedToastRafRef.current = requestAnimationFrame(() => {
          connectedToastRafRef.current = null;

          if (disconnectingRef.current) {
            return;
          }

          addToast({
            title: t("Connected"),
            color: "success",
          });

          audioStartTimerRef.current = setTimeout(() => {
            audioStartTimerRef.current = null;
            audioPlaybackEnabledRef.current = true;

            if (audioAvailableRef.current) {
              void ensureAudioContext(true);
            }
          }, 180);
        });
      });
    };

    runAfterVideoPaint();
  };

  const toggleAudioMuted = async () => {
    if (!audioAvailableRef.current) {
      return;
    }

    if (!audioUnlockedRef.current || !audioContextRef.current) {
      await ensureAudioContext(false);
    }

    setAudioMutedState(!audioMutedRef.current);
  };

  const normalizeAxis = (value: number) => {
    if (!Number.isFinite(value)) {
      return 0;
    }
    const clamped = Math.max(-1, Math.min(1, value));
    if (Math.abs(clamped) < GAMEPAD_DEADZONE) {
      return 0;
    }
    return clamped;
  };

  const toSignedAxis = (value: number) => {
    const clamped = Math.max(-1, Math.min(1, value));
    if (clamped === -1) {
      return -32768;
    }
    return Math.trunc(clamped * 32767);
  };

  const getButtonValue = (gamepad: Gamepad, index: number) => {
    const btn = gamepad.buttons[index];
    if (!btn) {
      return 0;
    }
    const raw = typeof btn.value === "number" ? btn.value : btn.pressed ? 1 : 0;
    return Math.max(0, Math.min(1, raw));
  };

  const isButtonPressed = (gamepad: Gamepad, index: number, threshold = 0.5) => {
    const btn = gamepad.buttons[index];
    if (!btn) {
      return false;
    }
    return !!btn.pressed || getButtonValue(gamepad, index) >= threshold;
  };

  const sendControllerState = (state: ControllerStatePayload) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const stateKey = `${state.buttons}|${state.l2State}|${state.r2State}|${state.leftX}|${state.leftY}|${state.rightX}|${state.rightY}`;
    if (stateKey === lastControlStateKeyRef.current) {
      return;
    }

    try {
      ws.send(
        JSON.stringify({
          type: "control_state",
          state,
        })
      );
      lastControlStateKeyRef.current = stateKey;
      controlSendCountRef.current += 1;
    } catch {
      controlSendErrorCountRef.current += 1;
    }
  };

  const pollAndSendGamepadState = () => {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    let validCount = 0;

    const mergedState: ControllerStatePayload = {
      buttons: 0,
      l2State: 0,
      r2State: 0,
      leftX: 0,
      leftY: 0,
      rightX: 0,
      rightY: 0,
    };

    let leftXNorm = 0;
    let leftYNorm = 0;
    let rightXNorm = 0;
    let rightYNorm = 0;

    for (const gamepad of gamepads) {
      if (!gamepad || !gamepad.connected) {
        continue;
      }
      if (!gamepad.axes || gamepad.axes.length !== 4) {
        continue;
      }

      validCount += 1;

      if (isButtonPressed(gamepad, 0)) mergedState.buttons |= CONTROLLER_BUTTONS.CROSS;
      if (isButtonPressed(gamepad, 1)) mergedState.buttons |= CONTROLLER_BUTTONS.MOON;
      if (isButtonPressed(gamepad, 2)) mergedState.buttons |= CONTROLLER_BUTTONS.BOX;
      if (isButtonPressed(gamepad, 3)) mergedState.buttons |= CONTROLLER_BUTTONS.PYRAMID;
      if (isButtonPressed(gamepad, 4)) mergedState.buttons |= CONTROLLER_BUTTONS.L1;
      if (isButtonPressed(gamepad, 5)) mergedState.buttons |= CONTROLLER_BUTTONS.R1;
      if (isButtonPressed(gamepad, 8)) mergedState.buttons |= CONTROLLER_BUTTONS.SHARE;
      if (isButtonPressed(gamepad, 9)) mergedState.buttons |= CONTROLLER_BUTTONS.OPTIONS;
      if (isButtonPressed(gamepad, 10)) mergedState.buttons |= CONTROLLER_BUTTONS.L3;
      if (isButtonPressed(gamepad, 11)) mergedState.buttons |= CONTROLLER_BUTTONS.R3;
      if (isButtonPressed(gamepad, 12)) mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_UP;
      if (isButtonPressed(gamepad, 13)) mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_DOWN;
      if (isButtonPressed(gamepad, 14)) mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_LEFT;
      if (isButtonPressed(gamepad, 15)) mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_RIGHT;
      if (isButtonPressed(gamepad, 16)) mergedState.buttons |= CONTROLLER_BUTTONS.PS;
      if (isButtonPressed(gamepad, 17)) mergedState.buttons |= CONTROLLER_BUTTONS.TOUCHPAD;

      const l2Value = getButtonValue(gamepad, 6);
      const r2Value = getButtonValue(gamepad, 7);
      mergedState.l2State = Math.max(mergedState.l2State, Math.round(l2Value * 255));
      mergedState.r2State = Math.max(mergedState.r2State, Math.round(r2Value * 255));
      if (l2Value >= 0.2) mergedState.buttons |= CONTROLLER_ANALOG_BUTTONS.L2;
      if (r2Value >= 0.2) mergedState.buttons |= CONTROLLER_ANALOG_BUTTONS.R2;

      const leftX = normalizeAxis(gamepad.axes[0] || 0);
      const leftY = normalizeAxis(gamepad.axes[1] || 0);
      const rightX = normalizeAxis(gamepad.axes[2] || 0);
      const rightY = normalizeAxis(gamepad.axes[3] || 0);

      if (Math.abs(leftX) > Math.abs(leftXNorm)) leftXNorm = leftX;
      if (Math.abs(leftY) > Math.abs(leftYNorm)) leftYNorm = leftY;
      if (Math.abs(rightX) > Math.abs(rightXNorm)) rightXNorm = rightX;
      if (Math.abs(rightY) > Math.abs(rightYNorm)) rightYNorm = rightY;
    }

    if (keyboardPressedKeysRef.current.size > 0) {
      const activeActions = new Set(Array.from(keyboardPressedKeysRef.current.values()));

      for (const [action, mask] of Object.entries(KEYBOARD_BUTTON_ACTION_MASKS)) {
        if (activeActions.has(action)) {
          mergedState.buttons |= mask;
        }
      }

      if (activeActions.has("LeftTrigger")) {
        mergedState.buttons |= CONTROLLER_ANALOG_BUTTONS.L2;
        mergedState.l2State = Math.max(mergedState.l2State, 255);
      }

      if (activeActions.has("RightTrigger")) {
        mergedState.buttons |= CONTROLLER_ANALOG_BUTTONS.R2;
        mergedState.r2State = Math.max(mergedState.r2State, 255);
      }

      leftXNorm = mergeAnalogInput(
        leftXNorm,
        getKeyboardAxisValue(activeActions, "LeftThumbXAxisPlus", "LeftThumbXAxisMinus")
      );
      leftYNorm = mergeAnalogInput(
        leftYNorm,
        getKeyboardAxisValue(activeActions, "LeftThumbYAxisPlus", "LeftThumbYAxisMinus")
      );
      rightXNorm = mergeAnalogInput(
        rightXNorm,
        getKeyboardAxisValue(activeActions, "RightThumbXAxisPlus", "RightThumbXAxisMinus")
      );
      rightYNorm = mergeAnalogInput(
        rightYNorm,
        getKeyboardAxisValue(activeActions, "RightThumbYAxisPlus", "RightThumbYAxisMinus")
      );
    }

    mergedState.leftX = toSignedAxis(leftXNorm);
    mergedState.leftY = toSignedAxis(leftYNorm);
    mergedState.rightX = toSignedAxis(rightXNorm);
    mergedState.rightY = toSignedAxis(rightYNorm);

    validGamepadCountRef.current = validCount;
    sendControllerState(mergedState);
  };

  const updateStats = () => {
    const now = Date.now();
    const deltaSec = Math.max((now - lastStatsAtRef.current) / 1000, 0.001);
    const renderFps = ((renderedFramesRef.current - lastRenderFramesRef.current) / deltaSec).toFixed(1);
    lastRenderFramesRef.current = renderedFramesRef.current;
    lastStatsAtRef.current = now;

    const ws = socketRef.current;
    const wsState = ws ? ws.readyState : 3;
    const wsText = wsState === WebSocket.OPEN ? "OPEN" : String(wsState);

    const audioBufferedMs = audioContextRef.current
      ? Math.max(0, (nextAudioTimeRef.current - audioContextRef.current.currentTime) * 1000).toFixed(0)
      : "0";

    statsTextRef.current =
      t("StatsTemplate", {
        wsText,
        width: widthRef.current,
        height: heightRef.current,
        fps: fpsRef.current,
        received: receivedFramesRef.current,
        rendered: renderedFramesRef.current,
        dropped: droppedFramesRef.current,
        renderFps,
        audioReceived: audioReceivedChunksRef.current,
        audioPlayed: audioPlayedChunksRef.current,
        audioDropped: audioDroppedChunksRef.current,
        audioBufferedMs,
        gamepads: validGamepadCountRef.current,
        controlSent: controlSendCountRef.current,
        controlFailed: controlSendErrorCountRef.current,
      });
  };

  const renderLoop = () => {
    pollAndSendGamepadState();

    const frame = latestFrameRef.current;
    if (frame) {
      latestFrameRef.current = null;
      try {
        if (videoFormatRef.current === "I010") {
          drawI010HdrFrame(frame);
        } else {
          const renderedWithGpu = drawI420Gpu(frame);
          if (!renderedWithGpu) {
            drawI420Cpu(frame);
          }
        }

        renderedFramesRef.current += 1;

        if (!videoReadyRef.current) {
          videoReadyRef.current = true;
          setVideoReady(true);
          showConnectedToastThenEnableAudio();
        }
      } catch (error) {
        openSessionAlert(
          [
            t("HdrRendererInitializationFailed"),
            getErrorMessage(
              error,
              t("HdrRendererSwitchCodecHint")
            ),
          ].join("\n"),
          t("HdrRendererErrorStatus")
        );
      }
    }

    rafRef.current = requestAnimationFrame(renderLoop);
  };

  useEffect(() => {
    let active = true;

    const start = async () => {
      try {
        disconnectingRef.current = false;
        connectedToastShownRef.current = false;
        sessionConnectedRef.current = false;
        videoReadyRef.current = false;
        sessionErrorHandledRef.current = false;
        audioPlaybackEnabledRef.current = false;
        nextAudioTimeRef.current = 0;
        pendingAudioQueueRef.current = [];
        pendingAudioBytesRef.current = 0;
        sdrGpuRenderingDisabledRef.current = false;
        clearConnectedFeedbackTimers();
        setVideoReady(false);
        setAudioMutedState(false);
        setAudioAvailable(false);
        audioAvailableRef.current = false;
        setSessionAlert(null);

        const raw = window.sessionStorage.getItem(PENDING_STREAM_STORAGE_KEY);
        if (!raw) {
          setStatus(t("PendingConfigMissing"));
          return;
        }

        let pendingConfig: PendingStreamConfig;
        try {
          pendingConfig = JSON.parse(raw);
        } catch (error) {
          setStatus(
            t("PendingConfigParseFailed", {
              error: String(error),
            })
          );
          return;
        }

        const streamHost =
          pendingConfig?.streamHost ||
          pendingConfig?.consoleInfo?.parsedRemoteHost ||
          pendingConfig?.consoleInfo?.remoteHost ||
          pendingConfig?.consoleInfo?.host ||
          "";

        if (!streamHost) {
          setStatus(t("StreamHostMissing"));
          setConnectState("error");
          return;
        }

        setStatus(t("Connecting..."));
        setConnectState("starting");
        const currentLoginInfo = await Ipc.send("app", "getCachedPsnLoginInfo").catch(
          () => null
        );
        const serverInfo: any = await Ipc.send("app", "startStreamSession", {
          streamHost,
          isRemote: !!pendingConfig?.isRemote,
          consoleInfo: pendingConfig?.consoleInfo || {},
          loginInfo: currentLoginInfo || undefined,
        });
        if (!active) return;

        const url = `ws://${serverInfo.host}:${serverInfo.port}${serverInfo.path}`;
        wsUrlRef.current = url;
        setStatus(t("Connecting..."));

        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;

        socket.onopen = () => {
          if (!active) return;
          lastControlStateKeyRef.current = "";
          setStatus(t("Connecting..."));
        };

        socket.onmessage = (event) => {
          if (!active) return;

          if (typeof event.data === "string") {
            try {
              const msg = JSON.parse(event.data);
              if (msg?.type === "config") {
                applyVideoConfig(msg);
              } else if (msg?.type === "audio_config") {
                applyAudioConfig(msg);
              } else if (msg?.type === "session_event") {
                const sessionEvent =
                  msg?.event && typeof msg.event === "object"
                    ? msg.event
                    : { name: msg?.name || "unknown" };
                const eventName = String(sessionEvent.name || msg?.name || "unknown");

                if (eventName === "rumble") {
                  triggerGamepadRumbleFromChiaki(sessionEvent);
                } else if (eventName === "trigger_effects") {
                  handleGamepadTriggerEffectsFromChiaki(sessionEvent);
                } else if (eventName === "led_color") {
                  handleGamepadLedColorFromChiaki(sessionEvent);
                } else if (eventName === "connected") {
                  sessionConnectedRef.current = true;
                  setConnectState("connected");
                  setStatus(t("Connected"));
                  showConnectedToastThenEnableAudio();
                } else if (!NON_ERROR_SESSION_EVENT_NAMES.has(eventName)) {
                  openSessionAlert(
                    buildSessionEventErrorMessage(sessionEvent, t),
                    `session: ${eventName}`
                  );
                } else if (typeof eventName === "string") {
                  setStatus(t("Session_activity"));
                }
              } else if (msg?.type === "session_status") {
                if (msg?.status === "connected") {
                  sessionConnectedRef.current = true;
                  setConnectState("connected");
                  setStatus(t("Connected"));
                  showConnectedToastThenEnableAudio();
                } else if (msg?.status === "starting") {
                  setConnectState("starting");
                  setStatus(t("Connecting..."));
                } else if (msg?.status === "quit" || msg?.status === "stopped") {
                  openSessionAlert(
                    `status: ${String(msg.status)}`,
                    `session: ${String(msg.status)}`
                  );
                } else {
                  setStatus(t("Session_activity"));
                }
              } else if (msg?.type === "connected") {
                setStatus(t("Connecting..."));
              }
            } catch {
              // ignore malformed text frame
            }
            return;
          }

          if (event.data instanceof ArrayBuffer) {
            handleBinaryPacket(new Uint8Array(event.data));
            return;
          }

          if (event.data instanceof Blob) {
            event.data
              .arrayBuffer()
              .then((ab) => {
                if (!active) return;
                handleBinaryPacket(new Uint8Array(ab));
              })
              .catch(() => undefined);
          }
        };

        socket.onerror = () => {
          if (!active) return;
          openSessionAlert(t("WebSocketErrorEvent"), t("WebSocketErrorStatus"));
        };

        socket.onclose = (closeEvent) => {
          if (!active) return;
          if (!disconnectingRef.current) {
            if (sessionErrorHandledRef.current) {
              setStatus(t("WebSocketClosedStatus"));
            } else {
              openSessionAlert(
                buildSocketCloseMessage(closeEvent, t),
                t("WebSocketClosedStatus")
              );
            }
          }
          if (socketRef.current === socket) {
            socketRef.current = null;
          }
        };
      } catch (error: any) {
        setStatus(
          t("StartSessionFailedWithReason", {
            reason: error?.message || String(error),
          })
        );
        setConnectState("error");
      }
    };

    start();
    rafRef.current = requestAnimationFrame(renderLoop);
    statsTimerRef.current = setInterval(updateStats, 1000);

    return () => {
      active = false;

      if (statsTimerRef.current) {
        clearInterval(statsTimerRef.current);
        statsTimerRef.current = null;
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      if (socketRef.current && socketRef.current.readyState < WebSocket.CLOSING) {
        socketRef.current.close();
      }
      socketRef.current = null;
      lastControlStateKeyRef.current = "";
      clearConnectedFeedbackTimers();

      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => undefined);
      }
      audioContextRef.current = null;
      audioGainNodeRef.current = null;
      audioUnlockedRef.current = false;
      audioAvailableRef.current = false;
      audioPlaybackEnabledRef.current = false;
      nextAudioTimeRef.current = 0;
      pendingAudioQueueRef.current = [];
      pendingAudioBytesRef.current = 0;
      sdrGpuRenderingDisabledRef.current = false;
      clearPressedKeyboardKeys();
      sessionConnectedRef.current = false;
      videoReadyRef.current = false;
      sessionErrorHandledRef.current = false;
      latestFrameRef.current = null;
      videoFormatRef.current = "I420";
      setVideoFormat("I420");
      destroySdrRenderer();
      destroyHdrRenderer();
      setVideoReady(false);

      Ipc.send("app", "stopStreamSession").catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  useEffect(() => {
    const unlockAudio = () => {
      if (audioAvailableRef.current && !audioUnlockedRef.current) {
        void ensureAudioContext(false);
      }
    };

    window.addEventListener("pointerdown", unlockAudio);

    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleKeyboardChange = (event: KeyboardEvent, pressed: boolean) => {
      if (isEditableKeyboardTarget(event.target)) {
        return;
      }

      const mappedAction = keyboardMappingRef.current[event.key];
      if (!mappedAction) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (pressed) {
        keyboardPressedKeysRef.current.set(event.key, mappedAction);
      } else {
        keyboardPressedKeysRef.current.delete(event.key);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      handleKeyboardChange(event, true);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      handleKeyboardChange(event, false);
    };

    const clearKeyboardState = () => {
      clearPressedKeyboardKeys();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearKeyboardState);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearKeyboardState);
      clearPressedKeyboardKeys();
    };
  }, []);

  const handleDisconnect = async () => {
    if (disconnectingRef.current) {
      return;
    }

    disconnectingRef.current = true;
    audioPlaybackEnabledRef.current = false;
    clearPressedKeyboardKeys();
    clearConnectedFeedbackTimers();
    setConnectState("disconnecting");
    setStatus(t("Disconnecting..."));

    try {
      if (socketRef.current && socketRef.current.readyState < WebSocket.CLOSING) {
        socketRef.current.close();
      }
    } catch {
      // ignore close errors
    }

    await Ipc.send("app", "stopStreamSession").catch(() => undefined);
    const localeParam = Array.isArray(router.query.locale)
      ? router.query.locale[0]
      : router.query.locale || "en";
    router.push(`/${localeParam}/home`);
  };

  const sendControlButtonState = (button: string, pressed: boolean) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      ws.send(
        JSON.stringify({
          type: "control_button",
          button,
          pressed,
        })
      );
      return true;
    } catch {
      return false;
    }
  };

  const sendControlButtonTap = (button: string, holdMs: number) => {
    const pressed = sendControlButtonState(button, true);
    if (!pressed) {
      return;
    }

    window.setTimeout(() => {
      sendControlButtonState(button, false);
    }, holdMs);
  };

  const handlePressPs = () => {
    sendControlButtonTap("ps", SHORT_PS_PRESS_MS);
  };

  const handleLongPressPs = () => {
    sendControlButtonTap("ps", LONG_PS_PRESS_MS);
  };

  const handleDisconnectAndStandby = async () => {
    if (disconnectingRef.current) {
      return;
    }

    disconnectingRef.current = true;
    audioPlaybackEnabledRef.current = false;
    clearPressedKeyboardKeys();
    clearConnectedFeedbackTimers();
    setConnectState("disconnecting");
    setStatus(t("Disconnecting and putting console into standby..."));

    try {
      if (socketRef.current && socketRef.current.readyState < WebSocket.CLOSING) {
        socketRef.current.close();
      }
    } catch {
      // ignore close errors
    }

    try {
      await Ipc.send("app", "gotoBedAndStopStreamSession");
    } catch (error) {
      addToast({
        title: t("Failed to put console into standby."),
        description: getErrorMessage(error, t("Failed to put console into standby.")),
        color: "danger",
      });
      await Ipc.send("app", "stopStreamSession").catch(() => undefined);
    }

    const localeParam = Array.isArray(router.query.locale)
      ? router.query.locale[0]
      : router.query.locale || "en";
    router.push(`/${localeParam}/home`);
  };

  const handleSessionAlertConfirm = async () => {
    setSessionAlert(null);
    await handleDisconnect();
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      {sessionAlert ? (
        <Alert
          title={sessionAlert.title}
          content={
            <pre className="whitespace-pre-wrap break-all text-sm">
              {sessionAlert.content}
            </pre>
          }
          onClose={handleSessionAlertConfirm}
        />
      ) : null}

      <ActionBar
        type="remoteplay"
        connectState={connectState}
        audioMuted={audioMuted}
        onAudio={audioAvailable ? toggleAudioMuted : undefined}
        onPressPs={handlePressPs}
        onLongPressPs={handleLongPressPs}
        onDisconnect={handleDisconnect}
        onDisconnectPowerOff={handleDisconnectAndStandby}
        onTogglePerformance={() => setShowPerformance((prev) => !prev)}
      />

      {showPerformance && <Perform connectState={connectState} />}

      <div className="absolute inset-0 flex items-center justify-center bg-black">
        <canvas
          ref={canvasRef}
          width={1280}
          height={720}
          className={`block h-auto w-full max-h-full max-w-full ${
            shouldShowVideo && videoFormat !== "I010" ? "opacity-100" : "opacity-0"
          }`}
        />
        <canvas
          ref={hdrCanvasRef}
          width={1280}
          height={720}
          className={`absolute inset-0 m-auto block h-auto w-full max-h-full max-w-full ${
            shouldShowVideo && videoFormat === "I010" ? "opacity-100" : "opacity-0"
          }`}
        />
      </div>

      {!shouldShowVideo ? (
        <Loading loadingText={status || t("Connecting...")} />
      ) : null}
    </div>
  );
}

export default StreamPage;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "home", "stream"]);

// eslint-disable-next-line react-refresh/only-export-components
export { getStaticPaths };

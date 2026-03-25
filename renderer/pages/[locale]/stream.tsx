import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import { addToast } from "@heroui/react";
import ActionBar from "../../components/ActionBar";
import Alert from "../../components/Alert";
import Loading from "../../components/Loading";
import Perform from "../../components/Perform";
import BrightnessModal from "../../components/stream/BrightnessModal";
import Touchpad, {
  type StreamTouchPoint as TouchPoint,
  type StreamTouchState,
} from "../../components/stream/Touchpad";
import FsrModal from "../../components/stream/FsrModal";
import {
  DEFAULT_GAMEPAD_BUTTON_MAPPING,
  normalizeGamepadButtonMapping,
  type GamepadMappingAction,
} from "../../common/gamepadMapping";
import { useSettings } from "../../context/userContext";
import { defaultSettings } from "../../context/userContext.defaults";
import { handleGamepadLedColorFromChiaki } from "../../lib/gamepadLedColor";
import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";
import { triggerGamepadRumbleFromChiaki } from "../../lib/gamepadRumble";
import { handleGamepadTriggerEffectsFromChiaki } from "../../lib/gamepadTriggerEffects";
import Ipc from "../../lib/ipc";
import {
  FSR_FRAGMENT_SHADER_SOURCE,
  FSR_VERTEX_SHADER_SOURCE,
  HDR_FRAGMENT_SHADER_SOURCE,
  HDR_P010_FRAGMENT_SHADER_SOURCE,
  HDR_VERTEX_SHADER_SOURCE,
  SDR_FRAGMENT_SHADER_SOURCE,
  SDR_NV12_FRAGMENT_SHADER_SOURCE,
  SDR_VERTEX_SHADER_SOURCE,
} from "../../lib/stream-video/shader-sources";
import type {
  FsrWebglRenderer,
  HdrWebglRenderer,
  SdrWebglRenderer,
  VideoFrameFormat,
} from "../../lib/stream-video/types";

const PENDING_STREAM_STORAGE_KEY = "pending-stream-config";
const WS_BINARY_VIDEO = 1;
const WS_BINARY_AUDIO = 2;
const MAX_PENDING_AUDIO_BYTES = 4 * 1024 * 1024;
const AUDIO_CONTEXT_LATENCY_SEC = 0.08;
const AUDIO_SCHEDULE_LEAD_SEC = 0.04;
const AUDIO_MAX_BUFFER_SEC = 0.8;
const SHORT_PS_PRESS_MS = 150;
const LONG_PS_PRESS_MS = 1000;
const MIN_CONTROLLER_POLLING_RATE = 30;
const MAX_CONTROLLER_POLLING_RATE = 1000;
const MAX_CONTROLLER_SEND_RATE = 120;
const MAX_CONTROLLER_TOUCH_ID = 127;
const TOUCHPAD_BUTTON_TAP_MS = 90;
const TOUCHPAD_SCALE_MIN = 0.5;
const TOUCHPAD_SCALE_MAX = 2;
const TOUCHPAD_OPACITY_MIN = 0;
const TOUCHPAD_OPACITY_MAX = 0.8;
const TOUCHPAD_OPACITY_DEFAULT = 0.6;
const GAMEPAD_AXIS_QUANTIZATION = 128;
const GAMEPAD_TRIGGER_QUANTIZATION = 64;
const GAMEPAD_TRIGGER_DEADZONE = 0.02;
const BRIGHTNESS_MIN = 50;
const BRIGHTNESS_MAX = 150;
const BRIGHTNESS_DEFAULT = 100;
const FSR_SHARPNESS_MIN = 0;
const FSR_SHARPNESS_MAX = 2;
const FSR_SHARPNESS_STEP = 0.05;

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

const isLinuxRuntime = () => {
  return typeof navigator !== "undefined" && /Linux/i.test(navigator.userAgent || "");
};

const isSteamOsRuntime = () => {
  if (typeof navigator === "undefined") {
    return false;
  }

  const platformText = `${navigator.userAgent || ""} ${navigator.platform || ""}`;
  return /steamos|steam deck/i.test(platformText);
};

const isHdrVideoFormat = (format: VideoFrameFormat) => {
  return format === "I010" || format === "P010";
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
  touchIdNext: number;
  touches: [TouchPoint, TouchPoint];
};

type VideoDisplayFormat = "default" | "stretch" | "zoom";
type ControllerInputKernel = "web" | "node";
type TouchpadVerticalPosition = "top" | "center" | "bottom";

const resolveControllerInputKernel = (settings: Record<string, any> | null | undefined): ControllerInputKernel => {
  const direct = String(settings?.gamepad_kernel || "")
    .trim()
    .toLowerCase();
  if (direct === "web" || direct === "node") {
    return direct;
  }

  return "node";
};

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

const normalizeTouchIdNext = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_CONTROLLER_TOUCH_ID, Math.trunc(numeric)));
};

const normalizeTouchPoint = (touch: unknown): TouchPoint => {
  const rawTouch = touch && typeof touch === "object" ? (touch as Record<string, unknown>) : {};
  const idNumeric = Number(rawTouch.id);
  const id = Number.isFinite(idNumeric)
    ? Math.max(-1, Math.min(MAX_CONTROLLER_TOUCH_ID, Math.trunc(idNumeric)))
    : -1;

  if (id < 0) {
    return { id: -1 };
  }

  const xNumeric = Number(rawTouch.x);
  const yNumeric = Number(rawTouch.y);
  const x = Number.isFinite(xNumeric) ? Math.max(0, Math.min(65535, Math.round(xNumeric))) : 0;
  const y = Number.isFinite(yNumeric) ? Math.max(0, Math.min(65535, Math.round(yNumeric))) : 0;
  return { id, x, y };
};

const cloneTouchPoint = (touch: TouchPoint): TouchPoint => {
  if (touch.id < 0) {
    return { id: -1 };
  }

  return {
    id: touch.id,
    x: touch.x,
    y: touch.y,
  };
};

const touchPointToKey = (touch: TouchPoint) => {
  if (touch.id < 0) {
    return "-1";
  }
  return `${touch.id}:${touch.x ?? 0}:${touch.y ?? 0}`;
};

const isSameTouchPoint = (left: TouchPoint, right: TouchPoint) => {
  if (left.id !== right.id) {
    return false;
  }
  if (left.id < 0) {
    return true;
  }

  return (left.x ?? 0) === (right.x ?? 0) && (left.y ?? 0) === (right.y ?? 0);
};

const createIdleTouchState = (): StreamTouchState => ({
  touchIdNext: 0,
  touches: [{ id: -1 }, { id: -1 }],
});

const buildControllerStateKey = (state: ControllerStatePayload) => {
  return `${state.buttons}|${state.l2State}|${state.r2State}|${state.leftX}|${state.leftY}|${state.rightX}|${state.rightY}|${state.touchIdNext}|${touchPointToKey(state.touches[0])}|${touchPointToKey(state.touches[1])}`;
};

const createIdleControllerState = (): ControllerStatePayload => ({
  buttons: 0,
  l2State: 0,
  r2State: 0,
  leftX: 0,
  leftY: 0,
  rightX: 0,
  rightY: 0,
  touchIdNext: 0,
  touches: [{ id: -1 }, { id: -1 }],
});

const cloneControllerState = (state: ControllerStatePayload): ControllerStatePayload => ({
  buttons: state.buttons,
  l2State: state.l2State,
  r2State: state.r2State,
  leftX: state.leftX,
  leftY: state.leftY,
  rightX: state.rightX,
  rightY: state.rightY,
  touchIdNext: state.touchIdNext,
  touches: [cloneTouchPoint(state.touches[0]), cloneTouchPoint(state.touches[1])],
});

const resolveControllerSendIntervalMs = (pollingRate: unknown) => {
  const numericRate = Number(pollingRate);
  const rate = Number.isFinite(numericRate) ? numericRate : defaultSettings.polling_rate;
  const clampedRate = Math.max(
    MIN_CONTROLLER_POLLING_RATE,
    Math.min(MAX_CONTROLLER_SEND_RATE, rate)
  );
  return Math.max(1, 1000 / clampedRate);
};

const quantizeSignedUnitValue = (value: number, steps: number) => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const clamped = Math.max(-1, Math.min(1, value));
  if (clamped === -1 || clamped === 1 || clamped === 0) {
    return clamped;
  }

  return Math.max(-1, Math.min(1, Math.round(clamped * steps) / steps));
};

const quantizeTriggerUnitValue = (value: number) => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const clamped = Math.max(0, Math.min(1, value));
  if (clamped < GAMEPAD_TRIGGER_DEADZONE) {
    return 0;
  }
  if (clamped > 1 - 0.5 / GAMEPAD_TRIGGER_QUANTIZATION) {
    return 1;
  }

  return Math.max(0, Math.min(1, Math.round(clamped * GAMEPAD_TRIGGER_QUANTIZATION) / GAMEPAD_TRIGGER_QUANTIZATION));
};

const isPriorityControllerStateChange = (
  nextState: ControllerStatePayload,
  previousState: ControllerStatePayload
) => {
  return (
    nextState.buttons !== previousState.buttons ||
    nextState.l2State !== previousState.l2State ||
    nextState.r2State !== previousState.r2State ||
    nextState.touchIdNext !== previousState.touchIdNext ||
    !isSameTouchPoint(nextState.touches[0], previousState.touches[0]) ||
    !isSameTouchPoint(nextState.touches[1], previousState.touches[1])
  );
};

const resolveControllerPollingIntervalMs = (pollingRate: unknown) => {
  const numericRate = Number(pollingRate);
  const rate = Number.isFinite(numericRate) ? numericRate : defaultSettings.polling_rate;
  const clampedRate = Math.max(
    MIN_CONTROLLER_POLLING_RATE,
    Math.min(MAX_CONTROLLER_POLLING_RATE, rate)
  );
  return Math.max(1, 1000 / clampedRate);
};

const normalizeVideoDisplayFormat = (value: unknown): VideoDisplayFormat => {
  if (value === "stretch" || value === "zoom") {
    return value;
  }
  return "default";
};

const normalizeTouchpadVerticalPosition = (value: unknown): TouchpadVerticalPosition => {
  if (value === "top" || value === "bottom") {
    return value;
  }
  return "center";
};

const normalizeTouchpadScale = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }

  return Math.max(TOUCHPAD_SCALE_MIN, Math.min(TOUCHPAD_SCALE_MAX, numeric));
};

const normalizeTouchpadOpacity = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return TOUCHPAD_OPACITY_DEFAULT;
  }

  return Math.max(TOUCHPAD_OPACITY_MIN, Math.min(TOUCHPAD_OPACITY_MAX, numeric));
};

const normalizeBrightnessSetting = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return BRIGHTNESS_DEFAULT;
  }

  return Math.max(BRIGHTNESS_MIN, Math.min(BRIGHTNESS_MAX, Math.round(numeric)));
};

const getVideoCanvasSizingClass = (format: VideoDisplayFormat) => {
  if (format === "stretch") {
    return "h-full w-full object-fill";
  }
  if (format === "zoom") {
    return "h-full w-full object-cover";
  }
  return "h-full w-full object-contain";
};

const normalizeFsrSharpness = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return defaultSettings.fsr_sharpness;
  }

  return Math.max(FSR_SHARPNESS_MIN, Math.min(FSR_SHARPNESS_MAX, numeric));
};

const toFsrShaderSharpness = (sharpness: number) => {
  const normalized = Math.max(FSR_SHARPNESS_MIN, Math.min(FSR_SHARPNESS_MAX, sharpness));
  // Match XStreaming behavior:
  // UI range 0~2 maps to shader range 0~0.2 (divide by 10).
  // 0 = strongest sharpening, 0.2 = weakest sharpening.
  return normalized * 0.1;
};

function StreamPage() {
  const { t } = useTranslation("stream");
  const router = useRouter();
  const { settings, setSettings } = useSettings();

  const [status, setStatus] = useState("");
  const [connectState, setConnectState] = useState("initializing");
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [audioMuted, setAudioMuted] = useState(false);
  const [showPerformance, setShowPerformance] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [showActionbar, setShowActionbar] = useState(false);
  const [showTouchpadOverlay, setShowTouchpadOverlay] = useState(false);
  const [showBrightnessModal, setShowBrightnessModal] = useState(false);
  const [showFsrModal, setShowFsrModal] = useState(false);
  const [isPs5Console, setIsPs5Console] = useState(true);
  const [brightness, setBrightness] = useState(BRIGHTNESS_DEFAULT);
  const [fsrSharpness, setFsrSharpness] = useState(
    normalizeFsrSharpness(defaultSettings.fsr_sharpness)
  );
  const [fsrFrameRendered, setFsrFrameRendered] = useState(false);
  const [videoFormat, setVideoFormat] = useState<VideoFrameFormat>("NV12");
  const [sessionAlert, setSessionAlert] = useState<{
    title: string;
    content: string;
  } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hdrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fsrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const rafRef = useRef<number | null>(null);
  const renderLoopScheduledRef = useRef(false);
  const inputLoopTimerRef = useRef<number | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsUrlRef = useRef("");
  const statsTextRef = useRef("");

  const widthRef = useRef(1280);
  const heightRef = useRef(720);
  const fpsRef = useRef(60);
  const frameSizeRef = useRef(Math.floor((1280 * 720 * 3) / 2));
  const videoFormatRef = useRef<VideoFrameFormat>("NV12");
  const videoConfigReceivedRef = useRef(false);
  const latestFrameRef = useRef<Uint8Array | null>(null);
  const pendingNativeVideoFrameBeforeConfigRef = useRef<Uint8Array | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);
  const sdrRendererRef = useRef<SdrWebglRenderer | null>(null);
  const sdrGpuRenderingDisabledRef = useRef(false);
  const forceSdrCpuRenderingRef = useRef(false);
  const hdrRendererRef = useRef<HdrWebglRenderer | null>(null);
  const fsrRendererRef = useRef<FsrWebglRenderer | null>(null);
  const fsrGpuRenderingDisabledRef = useRef(false);
  const fsrEnabledRef = useRef(Boolean(defaultSettings.fsr));
  const fsrSharpnessRef = useRef(normalizeFsrSharpness(defaultSettings.fsr_sharpness));
  const fsrFrameRenderedRef = useRef(false);

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
  const scheduledAudioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
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
  const gamepadMappingRef = useRef({ ...DEFAULT_GAMEPAD_BUTTON_MAPPING });
  const controllerInputKernelRef = useRef<ControllerInputKernel>(
    resolveControllerInputKernel(defaultSettings as Record<string, any>)
  );
  const nativeBinaryTransportRef = useRef(false);
  const nativeVideoFrameRenderedAckPendingCountRef = useRef(0);
  const controlTransportReadyRef = useRef(false);
  const controllerPollingIntervalMsRef = useRef(
    resolveControllerPollingIntervalMs(defaultSettings.polling_rate)
  );
  const controllerSendIntervalMsRef = useRef(
    resolveControllerSendIntervalMs(defaultSettings.polling_rate)
  );
  const touchpadStateRef = useRef<StreamTouchState>(createIdleTouchState());
  const touchpadButtonPressedRef = useRef(false);
  const touchpadButtonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUserInputAtRef = useRef(0);
  const actionBarDrawerOpenRef = useRef(false);
  const lastSentControllerStateRef = useRef<ControllerStatePayload>(createIdleControllerState());
  const lastControllerSendAtRef = useRef(0);
  const pollAndSendControllerStateRef = useRef<() => void>(() => undefined);

  const isSessionConnected = connectState === "connected";
  const shouldShowVideo = isSessionConnected && videoReady;
  const isFsrEnabled = !!settings?.fsr;
  const videoDisplayFormat = normalizeVideoDisplayFormat(settings?.video_format);
  const videoCanvasSizingClass = getVideoCanvasSizingClass(videoDisplayFormat);
  const brightnessRatio = Math.max(BRIGHTNESS_MIN, Math.min(BRIGHTNESS_MAX, brightness)) / 100;
  const shouldShowFsrCanvas = shouldShowVideo && isFsrEnabled && fsrFrameRendered;
  const shouldShowSdrCanvas =
    shouldShowVideo && !isHdrVideoFormat(videoFormat) && (!isFsrEnabled || !fsrFrameRendered);
  const shouldShowHdrCanvas =
    shouldShowVideo && isHdrVideoFormat(videoFormat) && (!isFsrEnabled || !fsrFrameRendered);
  const shouldShowTouchpads = shouldShowVideo && showTouchpadOverlay && !sessionAlert;
  const disconnectAndStandbyOnExit = !!settings?.stream_disconnect_standby;
  const persistedBrightness = normalizeBrightnessSetting(settings?.stream_brightness);
  const touchpadVerticalPosition = normalizeTouchpadVerticalPosition(
    settings?.stream_touchpad_position
  );
  const touchpadVerticalClass =
    touchpadVerticalPosition === "top"
      ? "top-4"
      : touchpadVerticalPosition === "bottom"
        ? "bottom-4"
        : "top-1/2 -translate-y-1/2";
  const touchpadScale = normalizeTouchpadScale(settings?.stream_touchpad_scale);
  const touchpadOpacity = normalizeTouchpadOpacity(settings?.stream_touchpad_opacity);

  const markUserActivity = useCallback(() => {
    lastUserInputAtRef.current = Date.now();
    setShowActionbar(true);
    setShowTouchpadOverlay(true);
  }, []);

  const handleActionBarDrawerOpenChange = useCallback(
    (open: boolean) => {
      actionBarDrawerOpenRef.current = open;
      if (open) {
        markUserActivity();
      }
    },
    [markUserActivity]
  );

  const updateTouchpadState = useCallback(
    (nextTouchState: StreamTouchState) => {
      touchpadStateRef.current = {
        touchIdNext: normalizeTouchIdNext(nextTouchState.touchIdNext),
        touches: [
          normalizeTouchPoint(nextTouchState.touches[0]),
          normalizeTouchPoint(nextTouchState.touches[1]),
        ],
      };
      markUserActivity();
      pollAndSendControllerStateRef.current();
    },
    [markUserActivity]
  );

  const triggerTouchpadButtonTap = useCallback(() => {
    markUserActivity();
    touchpadButtonPressedRef.current = true;
    pollAndSendControllerStateRef.current();

    if (touchpadButtonTimerRef.current) {
      clearTimeout(touchpadButtonTimerRef.current);
    }

    touchpadButtonTimerRef.current = setTimeout(() => {
      touchpadButtonPressedRef.current = false;
      pollAndSendControllerStateRef.current();
    }, TOUCHPAD_BUTTON_TAP_MS);
  }, [markUserActivity]);

  const handleDisconnectWithCurrentMode = () => {
    if (disconnectAndStandbyOnExit) {
      void handleDisconnectAndStandby();
      return;
    }

    void handleDisconnect();
  };

  const handleDisconnectStandbySwitchChange = (enabled: boolean) => {
    setSettings({
      ...settings,
      stream_disconnect_standby: enabled,
    });
  };

  const handleTouchpadPositionChange = (position: TouchpadVerticalPosition) => {
    setSettings({
      ...settings,
      stream_touchpad_position: position,
    });
  };

  const handleTouchpadScaleChange = (value: number | number[]) => {
    const raw = Array.isArray(value) ? Number(value[0]) : Number(value);
    if (!Number.isFinite(raw)) {
      return;
    }

    const nextScale = Number(
      Math.max(TOUCHPAD_SCALE_MIN, Math.min(TOUCHPAD_SCALE_MAX, raw)).toFixed(2)
    );

    setSettings({
      ...settings,
      stream_touchpad_scale: nextScale,
    });
  };

  const handleTouchpadOpacityChange = (value: number | number[]) => {
    const raw = Array.isArray(value) ? Number(value[0]) : Number(value);
    if (!Number.isFinite(raw)) {
      return;
    }

    const nextOpacity = Number(
      Math.max(TOUCHPAD_OPACITY_MIN, Math.min(TOUCHPAD_OPACITY_MAX, raw)).toFixed(2)
    );

    setSettings({
      ...settings,
      stream_touchpad_opacity: nextOpacity,
    });
  };

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
    setBrightness(persistedBrightness);
  }, [persistedBrightness]);

  useEffect(() => {
    keyboardMappingRef.current = normalizeKeyboardMapping(
      settings?.input_mousekeyboard_maping
    );
    gamepadMappingRef.current = normalizeGamepadButtonMapping(settings?.gamepad_maping);
    controllerInputKernelRef.current = resolveControllerInputKernel({
      gamepad_kernel: settings?.gamepad_kernel,
    });

    controllerPollingIntervalMsRef.current = resolveControllerPollingIntervalMs(
      settings?.polling_rate
    );
    controllerSendIntervalMsRef.current = resolveControllerSendIntervalMs(
      settings?.polling_rate
    );

    const activityEvent = () => {
      markUserActivity();
    };
    window.addEventListener("mousemove", activityEvent);
    window.addEventListener("mousedown", activityEvent);

    window.addEventListener("touchstart", activityEvent);
    window.addEventListener("touchmove", activityEvent);

    const escEvent = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        Ipc.send("app", "exitFullscreen");
      }
    };
    window.addEventListener("keydown", escEvent);

    const visibilityInterval = setInterval(() => {
      const hasTouchpadInteraction = touchpadStateRef.current.touches.some(
        (touch) => touch.id >= 0
      );
      const shouldKeepActionbarVisible = actionBarDrawerOpenRef.current;
      const isActive = hasTouchpadInteraction || Date.now() - lastUserInputAtRef.current < 2000;
      setShowActionbar(shouldKeepActionbarVisible || isActive);
      setShowTouchpadOverlay(isActive);
    }, 100);

    return () => {
      if (visibilityInterval) clearInterval(visibilityInterval);
      window.removeEventListener("mousemove", activityEvent);
      window.removeEventListener("mousedown", activityEvent);
      window.removeEventListener("touchstart", activityEvent);
      window.removeEventListener("touchmove", activityEvent);
      window.removeEventListener("keydown", escEvent);
    };
  }, [
    settings?.polling_rate,
    settings?.input_mousekeyboard_maping,
    settings?.gamepad_maping,
    settings?.gamepad_kernel,
    markUserActivity,
  ]);

  useEffect(() => {
    fsrEnabledRef.current = !!settings?.fsr;
    if (!settings?.fsr) {
      setShowFsrModal(false);
    }
  }, [settings?.fsr]);

  useEffect(() => {
    const nextSharpness = normalizeFsrSharpness(settings?.fsr_sharpness);
    setFsrSharpness(nextSharpness);
  }, [settings?.fsr_sharpness]);

  useEffect(() => {
    const renderer = String(settings?.stream_renderer || "ffmpeg").trim().toLowerCase();
    const linuxAutoVulkan = isLinuxRuntime() && renderer === "webcodec";
    forceSdrCpuRenderingRef.current = isSteamOsRuntime() && linuxAutoVulkan;
  }, [settings?.stream_renderer]);

  useEffect(() => {
    fsrSharpnessRef.current = fsrSharpness;
  }, [fsrSharpness]);

  const updateFsrFrameRendered = (nextValue: boolean) => {
    if (fsrFrameRenderedRef.current === nextValue) {
      return;
    }
    fsrFrameRenderedRef.current = nextValue;
    setFsrFrameRendered(nextValue);
  };

  const updateSessionActivityStatus = () => {
    if (sessionConnectedRef.current) {
      return;
    }
    setStatus(t("Session_activity"));
  };

  const clearPressedKeyboardKeys = () => {
    keyboardPressedKeysRef.current.clear();
  };

  const applyVideoConfig = (config: any) => {
    const width = Number(config?.width || widthRef.current);
    const height = Number(config?.height || heightRef.current);
    const fps = Number(config?.fps || fpsRef.current);
    const format =
      config?.format === "I010"
        ? "I010"
        : config?.format === "P010"
          ? "P010"
          : config?.format === "NV12"
            ? "NV12"
            : "I420";
    const frameSize =
      Number(config?.frameSize) ||
      (isHdrVideoFormat(format) ? width * height * 3 : Math.floor((width * height * 3) / 2));

    widthRef.current = width;
    heightRef.current = height;
    fpsRef.current = fps;
    frameSizeRef.current = frameSize;
    videoFormatRef.current = format;
    videoConfigReceivedRef.current = true;
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

    const fsrCanvas = fsrCanvasRef.current;
    if (fsrCanvas) {
      fsrCanvas.width = width;
      fsrCanvas.height = height;
    }

    updateFsrFrameRendered(false);
    destroyFsrRenderer();
    fsrGpuRenderingDisabledRef.current = false;

    if (!isHdrVideoFormat(format)) {
      destroyHdrRenderer();
    } else {
      destroySdrRenderer();
    }

    if (isHdrVideoFormat(format) && !window.WebGL2RenderingContext) {
      openSessionAlert(t("HdrWebgl2Required"));
    }

    const pendingFrame = pendingNativeVideoFrameBeforeConfigRef.current;
    if (pendingFrame && pendingFrame.byteLength === frameSize) {
      pendingNativeVideoFrameBeforeConfigRef.current = null;
      latestFrameRef.current = pendingFrame;
      if (!renderLoopScheduledRef.current) {
        renderLoopScheduledRef.current = true;
        rafRef.current = requestAnimationFrame(renderLoop);
      }
    } else if (pendingFrame) {
      pendingNativeVideoFrameBeforeConfigRef.current = null;
      ackRenderedNativeVideoFrame();
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
      clearScheduledAudioSources();
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

  const drawNv12Cpu = (frameBytes: Uint8Array) => {
    const renderingContext = ensure2dContext();
    if (!renderingContext) {
      return;
    }

    const width = widthRef.current;
    const height = heightRef.current;
    const yPlaneSize = width * height;
    const output = renderingContext.imageData.data;

    let outIndex = 0;
    for (let y = 0; y < height; y += 1) {
      const yRow = y * width;
      const uvRow = yPlaneSize + (y >> 1) * width;
      for (let x = 0; x < width; x += 1) {
        const yVal = frameBytes[yRow + x];
        const uvIndex = uvRow + (x & ~1);
        const uVal = frameBytes[uvIndex];
        const vVal = frameBytes[uvIndex + 1];

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
    if (renderer.uTexture) gl.deleteTexture(renderer.uTexture);
    if (renderer.vTexture) gl.deleteTexture(renderer.vTexture);
    if (renderer.uvTexture) gl.deleteTexture(renderer.uvTexture);
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
    if (renderer.uTexture) gl.deleteTexture(renderer.uTexture);
    if (renderer.vTexture) gl.deleteTexture(renderer.vTexture);
    if (renderer.uvTexture) gl.deleteTexture(renderer.uvTexture);
    gl.deleteBuffer(renderer.vertexBuffer);
    gl.deleteVertexArray(renderer.vertexArray);
    gl.deleteProgram(renderer.program);
    hdrRendererRef.current = null;
  };

  const destroyFsrRenderer = () => {
    const renderer = fsrRendererRef.current;
    if (!renderer) {
      return;
    }

    const { gl } = renderer;
    gl.deleteTexture(renderer.sourceTexture);
    gl.deleteBuffer(renderer.vertexBuffer);
    gl.deleteVertexArray(renderer.vertexArray);
    gl.deleteProgram(renderer.program);
    fsrRendererRef.current = null;
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

  const createSdrPlaneTexture = (
    gl: WebGL2RenderingContext,
    textureUnit: number,
    width: number,
    height: number,
    internalFormat: number,
    format: number
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
      internalFormat,
      width,
      height,
      0,
      format,
      gl.UNSIGNED_BYTE,
      null
    );

    return texture;
  };

  const createHdrTexture = (
    gl: WebGL2RenderingContext,
    textureUnit: number,
    width: number,
    height: number,
    internalFormat: number = gl.R16UI,
    format: number = gl.RED_INTEGER
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
      internalFormat,
      width,
      height,
      0,
      format,
      gl.UNSIGNED_SHORT,
      null
    );

    return texture;
  };

  const createSdrRenderer = (
    width: number,
    height: number,
    format: "I420" | "NV12"
  ) => {
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
      powerPreference: "high-performance",
      desynchronized: true,
    });
    if (!gl) {
      return null;
    }

    const vertexShader = compileWebglShader(gl, gl.VERTEX_SHADER, SDR_VERTEX_SHADER_SOURCE);
    const fragmentShader = compileWebglShader(
      gl,
      gl.FRAGMENT_SHADER,
      format === "NV12" ? SDR_NV12_FRAGMENT_SHADER_SOURCE : SDR_FRAGMENT_SHADER_SOURCE
    );
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

    const yTexture = createSdrPlaneTexture(gl, gl.TEXTURE0, width, height, gl.R8, gl.RED);
    const uTexture =
      format === "NV12"
        ? null
        : createSdrPlaneTexture(gl, gl.TEXTURE1, width >> 1, height >> 1, gl.R8, gl.RED);
    const vTexture =
      format === "NV12"
        ? null
        : createSdrPlaneTexture(gl, gl.TEXTURE2, width >> 1, height >> 1, gl.R8, gl.RED);
    const uvTexture =
      format === "NV12"
        ? createSdrPlaneTexture(gl, gl.TEXTURE1, width >> 1, height >> 1, gl.RG8, gl.RG)
        : null;

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "u_texY"), 0);
    if (format === "NV12") {
      gl.uniform1i(gl.getUniformLocation(program, "u_texUV"), 1);
    } else {
      gl.uniform1i(gl.getUniformLocation(program, "u_texU"), 1);
      gl.uniform1i(gl.getUniformLocation(program, "u_texV"), 2);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.viewport(0, 0, width, height);

    return {
      gl,
      program,
      vertexArray,
      vertexBuffer,
      format,
      yTexture,
      uTexture,
      vTexture,
      uvTexture,
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
      powerPreference: "high-performance",
      desynchronized: isLinuxRuntime(),
    });
    if (!gl) {
      throw new Error("WebGL2 is unavailable.");
    }

    const format: "I010" | "P010" = videoFormatRef.current === "P010" ? "P010" : "I010";
    const vertexShader = compileWebglShader(gl, gl.VERTEX_SHADER, HDR_VERTEX_SHADER_SOURCE);
    const fragmentShader = compileWebglShader(
      gl,
      gl.FRAGMENT_SHADER,
      format === "P010" ? HDR_P010_FRAGMENT_SHADER_SOURCE : HDR_FRAGMENT_SHADER_SOURCE
    );
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
    const uTexture =
      format === "P010" ? null : createHdrTexture(gl, gl.TEXTURE1, width >> 1, height >> 1);
    const vTexture =
      format === "P010" ? null : createHdrTexture(gl, gl.TEXTURE2, width >> 1, height >> 1);
    const uvTexture =
      format === "P010"
        ? createHdrTexture(gl, gl.TEXTURE1, width >> 1, height >> 1, gl.RG16UI, gl.RG_INTEGER)
        : null;

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "u_texY"), 0);
    if (format === "P010") {
      gl.uniform1i(gl.getUniformLocation(program, "u_texUV"), 1);
    } else {
      gl.uniform1i(gl.getUniformLocation(program, "u_texU"), 1);
      gl.uniform1i(gl.getUniformLocation(program, "u_texV"), 2);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.viewport(0, 0, width, height);

    return {
      gl,
      program,
      vertexArray,
      vertexBuffer,
      format,
      yTexture,
      uTexture,
      vTexture,
      uvTexture,
      width,
      height,
    };
  };

  const createFsrRenderer = (width: number, height: number) => {
    const canvas = fsrCanvasRef.current;
    if (!canvas) {
      return null;
    }

    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
      desynchronized: true,
    });
    if (!gl) {
      return null;
    }

    const vertexShader = compileWebglShader(gl, gl.VERTEX_SHADER, FSR_VERTEX_SHADER_SOURCE);
    const fragmentShader = compileWebglShader(gl, gl.FRAGMENT_SHADER, FSR_FRAGMENT_SHADER_SOURCE);
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      throw new Error("Failed to create FSR program.");
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(program) || "Unknown FSR shader link error.";
      gl.deleteProgram(program);
      throw new Error(error);
    }

    const vertexArray = gl.createVertexArray();
    const vertexBuffer = gl.createBuffer();
    if (!vertexArray || !vertexBuffer) {
      if (vertexArray) gl.deleteVertexArray(vertexArray);
      if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
      gl.deleteProgram(program);
      throw new Error("Failed to create FSR vertex buffers.");
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

    const sourceTexture = createSdrPlaneTexture(gl, gl.TEXTURE0, width, height, gl.RGBA, gl.RGBA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "u_source"), 0);
    const resolutionLocation = gl.getUniformLocation(program, "u_resolution");
    const sharpnessLocation = gl.getUniformLocation(program, "u_sharpness");
    if (resolutionLocation) {
      gl.uniform2f(resolutionLocation, width, height);
    }
    if (sharpnessLocation) {
      gl.uniform1f(sharpnessLocation, toFsrShaderSharpness(fsrSharpnessRef.current));
    }
    gl.viewport(0, 0, width, height);

    return {
      gl,
      program,
      vertexArray,
      vertexBuffer,
      sourceTexture,
      resolutionLocation,
      sharpnessLocation,
      width,
      height,
    };
  };

  const ensureHdrRenderer = () => {
    const width = widthRef.current;
    const height = heightRef.current;
    const format: "I010" | "P010" = videoFormatRef.current === "P010" ? "P010" : "I010";
    const renderer = hdrRendererRef.current;

    if (renderer && renderer.width === width && renderer.height === height && renderer.format === format) {
      return renderer;
    }

    destroyHdrRenderer();
    const nextRenderer = createHdrRenderer(width, height);
    hdrRendererRef.current = nextRenderer;
    return nextRenderer;
  };

  const ensureSdrRenderer = () => {
    if (forceSdrCpuRenderingRef.current) {
      destroySdrRenderer();
      return null;
    }

    if (sdrGpuRenderingDisabledRef.current) {
      return null;
    }

    const width = widthRef.current;
    const height = heightRef.current;
    const format = videoFormatRef.current === "NV12" ? "NV12" : "I420";
    const renderer = sdrRendererRef.current;

    if (
      renderer &&
      renderer.width === width &&
      renderer.height === height &&
      renderer.format === format
    ) {
      return renderer;
    }

    destroySdrRenderer();

    try {
      const nextRenderer = createSdrRenderer(width, height, format);
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

  const ensureFsrRenderer = () => {
    if (fsrGpuRenderingDisabledRef.current) {
      return null;
    }

    const width = widthRef.current;
    const height = heightRef.current;
    const renderer = fsrRendererRef.current;
    if (renderer && renderer.width === width && renderer.height === height) {
      return renderer;
    }

    destroyFsrRenderer();

    try {
      const nextRenderer = createFsrRenderer(width, height);
      if (!nextRenderer) {
        fsrGpuRenderingDisabledRef.current = true;
        return null;
      }
      fsrRendererRef.current = nextRenderer;
      return nextRenderer;
    } catch (error) {
      destroyFsrRenderer();
      fsrGpuRenderingDisabledRef.current = true;
      console.warn("[stream] Failed to initialize FSR renderer, fallback to original:", error);
      return null;
    }
  };

  const drawFsrFrame = () => {
    if (!fsrEnabledRef.current) {
      updateFsrFrameRendered(false);
      if (fsrRendererRef.current) {
        destroyFsrRenderer();
      }
      return;
    }

    const sourceCanvas =
      isHdrVideoFormat(videoFormatRef.current) ? hdrCanvasRef.current : canvasRef.current;
    if (!sourceCanvas) {
      updateFsrFrameRendered(false);
      return;
    }

    const renderer = ensureFsrRenderer();
    if (!renderer) {
      updateFsrFrameRendered(false);
      return;
    }

    const width = widthRef.current;
    const height = heightRef.current;
    const { gl } = renderer;
    const sourceRenderer = isHdrVideoFormat(videoFormatRef.current)
      ? hdrRendererRef.current
      : sdrRendererRef.current;

    try {
      if (sourceRenderer?.gl) {
        sourceRenderer.gl.flush();
      }
      gl.viewport(0, 0, width, height);
      gl.useProgram(renderer.program);
      gl.bindVertexArray(renderer.vertexArray);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, renderer.sourceTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        sourceCanvas
      );
      if (renderer.resolutionLocation) {
        gl.uniform2f(renderer.resolutionLocation, width, height);
      }
      if (renderer.sharpnessLocation) {
        gl.uniform1f(renderer.sharpnessLocation, toFsrShaderSharpness(fsrSharpnessRef.current));
      }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      updateFsrFrameRendered(true);
    } catch (error) {
      console.warn("[stream] FSR frame render failed, fallback to original:", error);
      fsrGpuRenderingDisabledRef.current = true;
      destroyFsrRenderer();
      updateFsrFrameRendered(false);
    }
  };

  const drawI420Gpu = (frameBytes: Uint8Array) => {
    const renderer = ensureSdrRenderer();
    if (!renderer || renderer.format !== "I420" || !renderer.uTexture || !renderer.vTexture) {
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

  const drawNv12Gpu = (frameBytes: Uint8Array) => {
    const renderer = ensureSdrRenderer();
    if (!renderer || renderer.format !== "NV12" || !renderer.uvTexture) {
      return false;
    }

    const width = widthRef.current;
    const height = heightRef.current;
    const yPlaneSize = width * height;
    const uvWidth = width >> 1;
    const uvHeight = height >> 1;
    const uvPlaneSize = width * (height >> 1);

    if (frameBytes.byteLength < yPlaneSize + uvPlaneSize) {
      return false;
    }

    const yPlane = frameBytes.subarray(0, yPlaneSize);
    const uvPlane = frameBytes.subarray(yPlaneSize, yPlaneSize + uvPlaneSize);

    const { gl } = renderer;
    gl.viewport(0, 0, width, height);
    gl.useProgram(renderer.program);
    gl.bindVertexArray(renderer.vertexArray);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, renderer.yTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.UNSIGNED_BYTE, yPlane);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, renderer.uvTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      uvWidth,
      uvHeight,
      gl.RG,
      gl.UNSIGNED_BYTE,
      uvPlane
    );

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return true;
  };

  const drawI010HdrFrame = (frameBytes: Uint8Array) => {
    const renderer = ensureHdrRenderer();
    if (!renderer || renderer.format !== "I010" || !renderer.uTexture || !renderer.vTexture) {
      return;
    }
    const width = widthRef.current;
    const height = heightRef.current;
    const yPlaneBytes = width * height * 2;
    const uvWidth = width >> 1;
    const uvHeight = height >> 1;
    const uvPlaneBytes = uvWidth * uvHeight * 2;

    if (frameBytes.byteLength < yPlaneBytes + uvPlaneBytes * 2) {
      return;
    }

    let alignedFrameBytes = frameBytes;
    if ((alignedFrameBytes.byteOffset & 1) !== 0) {
      const copied = new Uint8Array(alignedFrameBytes.byteLength);
      copied.set(alignedFrameBytes);
      alignedFrameBytes = copied;
    }

    const baseOffset = alignedFrameBytes.byteOffset;
    const yPlane = new Uint16Array(
      alignedFrameBytes.buffer,
      baseOffset,
      yPlaneBytes >> 1
    );
    const uPlane = new Uint16Array(
      alignedFrameBytes.buffer,
      baseOffset + yPlaneBytes,
      uvPlaneBytes >> 1
    );
    const vPlane = new Uint16Array(
      alignedFrameBytes.buffer,
      baseOffset + yPlaneBytes + uvPlaneBytes,
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

  const drawP010HdrFrame = (frameBytes: Uint8Array) => {
    const renderer = ensureHdrRenderer();
    if (!renderer || renderer.format !== "P010" || !renderer.uvTexture) {
      return;
    }

    const width = widthRef.current;
    const height = heightRef.current;
    const yPlaneBytes = width * height * 2;
    const uvPlaneBytes = width * (height >> 1) * 2;

    if (frameBytes.byteLength < yPlaneBytes + uvPlaneBytes) {
      return;
    }

    let alignedFrameBytes = frameBytes;
    if ((alignedFrameBytes.byteOffset & 1) !== 0) {
      const copied = new Uint8Array(alignedFrameBytes.byteLength);
      copied.set(alignedFrameBytes);
      alignedFrameBytes = copied;
    }

    const baseOffset = alignedFrameBytes.byteOffset;
    const yPlane = new Uint16Array(
      alignedFrameBytes.buffer,
      baseOffset,
      yPlaneBytes >> 1
    );
    const uvPlane = new Uint16Array(
      alignedFrameBytes.buffer,
      baseOffset + yPlaneBytes,
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
    gl.bindTexture(gl.TEXTURE_2D, renderer.uvTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      width >> 1,
      height >> 1,
      gl.RG_INTEGER,
      gl.UNSIGNED_SHORT,
      uvPlane
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

  const clearScheduledAudioSources = () => {
    const sources = Array.from(scheduledAudioSourcesRef.current);
    scheduledAudioSourcesRef.current.clear();

    for (const source of sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // ignore stop race
      }
      try {
        source.disconnect();
      } catch {
        // ignore disconnect race
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
      clearScheduledAudioSources();
      nextAudioTimeRef.current = targetStartTime;
      return false;
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    scheduledAudioSourcesRef.current.add(source);
    source.connect(audioGainNodeRef.current || audioContext.destination);
    source.onended = () => {
      scheduledAudioSourcesRef.current.delete(source);
      try {
        source.disconnect();
      } catch {
        // ignore disconnect race
      }
    };

    source.start(nextAudioTimeRef.current);
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

  const queueNativeVideoFrameRenderedAck = (count = 1) => {
    if (!nativeBinaryTransportRef.current) {
      return;
    }

    const nextCount = Math.max(0, Math.trunc(count));
    if (nextCount < 1) {
      return;
    }

    nativeVideoFrameRenderedAckPendingCountRef.current += nextCount;
  };

  const ackRenderedNativeVideoFrame = (count = 1) => {
    let remaining = Math.max(0, Math.trunc(count));
    while (remaining > 0 && nativeVideoFrameRenderedAckPendingCountRef.current > 0) {
      nativeVideoFrameRenderedAckPendingCountRef.current -= 1;
      Ipc.sendStreamVideoFrameRendered();
      remaining -= 1;
    }
  };

  const handleVideoFrameBytes = (frameBytes: Uint8Array) => {
    if (!videoConfigReceivedRef.current) {
      if (pendingNativeVideoFrameBeforeConfigRef.current) {
        droppedFramesRef.current += 1;
        ackRenderedNativeVideoFrame();
      }
      pendingNativeVideoFrameBeforeConfigRef.current = new Uint8Array(frameBytes);
      queueNativeVideoFrameRenderedAck();
      return;
    }

    if (frameBytes.byteLength !== frameSizeRef.current) {
      if (nativeBinaryTransportRef.current) {
        Ipc.sendStreamVideoFrameRendered();
      }
      return;
    }

    if (!sessionConnectedRef.current) {
      sessionConnectedRef.current = true;
      setConnectState("connected");
      setStatus(t("Connected"));
    }

    receivedFramesRef.current += 1;
    if (latestFrameRef.current) {
      droppedFramesRef.current += 1;
      ackRenderedNativeVideoFrame();
    }

    latestFrameRef.current = frameBytes;
    queueNativeVideoFrameRenderedAck();
    if (!renderLoopScheduledRef.current) {
      renderLoopScheduledRef.current = true;
      rafRef.current = requestAnimationFrame(renderLoop);
    }
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

  const resolveRawBinaryMessageToPacket = (message: any): Uint8Array | null => {
    if (message instanceof ArrayBuffer) {
      return message.byteLength > 1 ? new Uint8Array(message) : null;
    }

    if (ArrayBuffer.isView(message)) {
      const view = message as ArrayBufferView;
      return view.byteLength > 1
        ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
        : null;
    }

    const kind = Number(message?.kind || 0) & 0xff;
    const buffer = message?.buffer;
    const byteOffset = Number(message?.byteOffset || 0);
    const byteLength = Number(message?.byteLength || 0);
    if (kind < 1 || byteLength < 1) {
      return null;
    }

    let payloadBytes: Uint8Array | null = null;
    if (buffer instanceof ArrayBuffer) {
      const start = Math.max(0, Math.min(byteOffset, buffer.byteLength));
      const available = Math.max(0, buffer.byteLength - start);
      const length = Math.max(0, Math.min(byteLength, available));
      if (length > 0) {
        payloadBytes = new Uint8Array(buffer, start, length);
      }
    } else if (ArrayBuffer.isView(buffer)) {
      const view = buffer as ArrayBufferView;
      const start = Math.max(0, Math.min(byteOffset, view.byteLength));
      const available = Math.max(0, view.byteLength - start);
      const length = Math.max(0, Math.min(byteLength, available));
      if (length > 0) {
        payloadBytes = new Uint8Array(view.buffer, view.byteOffset + start, length);
      }
    }

    if (!payloadBytes || payloadBytes.byteLength < 1) {
      return null;
    }

    const packet = new Uint8Array(1 + payloadBytes.byteLength);
    packet[0] = kind;
    packet.set(payloadBytes, 1);
    return packet;
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
    const configuredDeadZone = Number(settings?.dead_zone);
    const deadZone =
      Number.isFinite(configuredDeadZone) && configuredDeadZone >= 0 && configuredDeadZone < 1
        ? configuredDeadZone
        : GAMEPAD_DEADZONE;
    if (Math.abs(clamped) < deadZone) {
      return 0;
    }
    return quantizeSignedUnitValue(clamped, GAMEPAD_AXIS_QUANTIZATION);
  };

  const normalizeTriggerValue = (value: number) => {
    return quantizeTriggerUnitValue(value);
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
    if (!controlTransportReadyRef.current || disconnectingRef.current) {
      return;
    }

    const stateKey = buildControllerStateKey(state);
    if (stateKey === lastControlStateKeyRef.current) {
      return;
    }

    const now = performance.now();
    if (
      !isPriorityControllerStateChange(state, lastSentControllerStateRef.current) &&
      now - lastControllerSendAtRef.current < controllerSendIntervalMsRef.current
    ) {
      return;
    }

    if (Ipc.sendStreamControllerState(state)) {
      lastControlStateKeyRef.current = stateKey;
      lastSentControllerStateRef.current = cloneControllerState(state);
      lastControllerSendAtRef.current = now;
      controlSendCountRef.current += 1;
      return;
    }

    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
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
      lastSentControllerStateRef.current = cloneControllerState(state);
      lastControllerSendAtRef.current = now;
      controlSendCountRef.current += 1;
    } catch {
      controlSendErrorCountRef.current += 1;
    }
  };

  const buildMergedControllerState = () => {
    const useWebGamepadKernel = controllerInputKernelRef.current === "web";
    const gamepads =
      useWebGamepadKernel && navigator.getGamepads ? navigator.getGamepads() : [];
    let validCount = 0;
    const mergedState: ControllerStatePayload = createIdleControllerState();

    let leftXNorm = 0;
    let leftYNorm = 0;
    let rightXNorm = 0;
    let rightYNorm = 0;

    const validGamepads = Array.from(gamepads).filter((gamepad): gamepad is Gamepad => {
      return !!gamepad && gamepad.connected && Array.isArray(gamepad.axes) && gamepad.axes.length === 4;
    });
    const configuredGamepadIndex = useWebGamepadKernel
      ? Number(settings?.gamepad_index)
      : -1;
    const shouldMixGamepads = useWebGamepadKernel && !!settings?.gamepad_mix;
    let activeGamepads = validGamepads;

    if (!shouldMixGamepads) {
      if (Number.isInteger(configuredGamepadIndex) && configuredGamepadIndex >= 0) {
        const specifiedGamepad = validGamepads.find(
          (gamepad) => gamepad.index === configuredGamepadIndex
        );
        activeGamepads = specifiedGamepad ? [specifiedGamepad] : [];
      }

      if (activeGamepads.length < 1 && validGamepads.length > 0) {
        activeGamepads = [validGamepads[0]];
      }
    }

    validCount = activeGamepads.length;

    for (const gamepad of activeGamepads) {

      const getMappedButtonIndex = (action: GamepadMappingAction) => {
        return gamepadMappingRef.current[action];
      };

      if (isButtonPressed(gamepad, getMappedButtonIndex("A"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.CROSS;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("B"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.MOON;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("X"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.BOX;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("Y"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.PYRAMID;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("LeftShoulder"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.L1;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("RightShoulder"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.R1;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("View"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.SHARE;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("Menu"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.OPTIONS;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("LeftThumb"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.L3;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("RightThumb"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.R3;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("DPadUp"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_UP;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("DPadDown"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_DOWN;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("DPadLeft"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_LEFT;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("DPadRight"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_RIGHT;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("Nexus"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.PS;
      }
      if (isButtonPressed(gamepad, getMappedButtonIndex("Touchpad"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.TOUCHPAD;
      }

      const l2Value = normalizeTriggerValue(
        getButtonValue(gamepad, getMappedButtonIndex("LeftTrigger"))
      );
      const r2Value = normalizeTriggerValue(
        getButtonValue(gamepad, getMappedButtonIndex("RightTrigger"))
      );
      mergedState.l2State = Math.max(mergedState.l2State, Math.round(l2Value * 255));
      mergedState.r2State = Math.max(mergedState.r2State, Math.round(r2Value * 255));
      if (mergedState.l2State > 0) mergedState.buttons |= CONTROLLER_ANALOG_BUTTONS.L2;
      if (mergedState.r2State > 0) mergedState.buttons |= CONTROLLER_ANALOG_BUTTONS.R2;

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
    mergedState.touchIdNext = touchpadStateRef.current.touchIdNext;
    mergedState.touches = [
      cloneTouchPoint(touchpadStateRef.current.touches[0]),
      cloneTouchPoint(touchpadStateRef.current.touches[1]),
    ];

    if (touchpadButtonPressedRef.current) {
      mergedState.buttons |= CONTROLLER_BUTTONS.TOUCHPAD;
    }

    validGamepadCountRef.current = validCount;
    return mergedState;
  };

  pollAndSendControllerStateRef.current = () => {
    sendControllerState(buildMergedControllerState());
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
    rafRef.current = null;
    renderLoopScheduledRef.current = false;

    const frame = latestFrameRef.current;
    if (frame) {
      latestFrameRef.current = null;
      try {
        if (videoFormatRef.current === "I010") {
          drawI010HdrFrame(frame);
        } else if (videoFormatRef.current === "P010") {
          drawP010HdrFrame(frame);
        } else if (videoFormatRef.current === "NV12") {
          const renderedWithGpu = drawNv12Gpu(frame);
          if (!renderedWithGpu) {
            drawNv12Cpu(frame);
          }
        } else {
          const renderedWithGpu = drawI420Gpu(frame);
          if (!renderedWithGpu) {
            drawI420Cpu(frame);
          }
        }

        if (fsrEnabledRef.current) {
          drawFsrFrame();
        }
        renderedFramesRef.current += 1;

        if (!videoReadyRef.current) {
          videoReadyRef.current = true;
          setVideoReady(true);
          showConnectedToastThenEnableAudio();
        }

        ackRenderedNativeVideoFrame();
      } catch (error) {
        ackRenderedNativeVideoFrame();
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

    if (latestFrameRef.current && !renderLoopScheduledRef.current) {
      renderLoopScheduledRef.current = true;
      rafRef.current = requestAnimationFrame(renderLoop);
    }
  };

  useEffect(() => {
    let active = true;

    const start = async () => {
      let rawStreamListener: any = null;
      try {
        if (isLinuxRuntime()) {
          await router.replace({
            pathname: `/${String(router.locale || "en")}/webStream`,
            query: router.query,
          });
          return;
        }

        disconnectingRef.current = false;
        connectedToastShownRef.current = false;
        sessionConnectedRef.current = false;
        videoReadyRef.current = false;
        videoConfigReceivedRef.current = false;
        sessionErrorHandledRef.current = false;
        audioPlaybackEnabledRef.current = false;
        nextAudioTimeRef.current = 0;
        pendingAudioQueueRef.current = [];
        pendingAudioBytesRef.current = 0;
        sdrGpuRenderingDisabledRef.current = false;
        fsrGpuRenderingDisabledRef.current = false;
        fsrFrameRenderedRef.current = false;
        nativeBinaryTransportRef.current = false;
        nativeVideoFrameRenderedAckPendingCountRef.current = 0;
        controlTransportReadyRef.current = false;
        lastSentControllerStateRef.current = createIdleControllerState();
        lastControllerSendAtRef.current = 0;
        lastControlStateKeyRef.current = "";
        touchpadStateRef.current = createIdleTouchState();
        touchpadButtonPressedRef.current = false;
        if (touchpadButtonTimerRef.current) {
          clearTimeout(touchpadButtonTimerRef.current);
          touchpadButtonTimerRef.current = null;
        }
        setShowActionbar(false);
        setShowTouchpadOverlay(false);
        setIsPs5Console(true);
        clearConnectedFeedbackTimers();
        setFsrFrameRendered(false);
        setVideoReady(false);
        setAudioMutedState(false);
        setAudioAvailable(false);
        audioAvailableRef.current = false;
        latestFrameRef.current = null;
        pendingNativeVideoFrameBeforeConfigRef.current = null;
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

        const apName = String(pendingConfig?.consoleInfo?.apName || "");
        setIsPs5Console(apName ? apName.toUpperCase().includes("PS5") : true);

        setStatus(t("Connecting..."));
        setConnectState("starting");
        rawStreamListener = Ipc.onRaw?.("stream-binary", (_event, message) => {
          if (!active) {
            return;
          }

          const packet = resolveRawBinaryMessageToPacket(message);
          if (!packet || packet.byteLength < 2) {
            return;
          }

          const kind = packet[0];
          if (kind === WS_BINARY_VIDEO) {
            nativeBinaryTransportRef.current = true;
          } else if (!nativeBinaryTransportRef.current) {
            return;
          }

          handleBinaryPacket(packet);
        });

        const currentLoginInfo = await Ipc.send("app", "getCachedPsnLoginInfo").catch(
          () => null
        );
        const serverInfo: any = await Ipc.send("app", "startStreamSession", {
          streamHost,
          isRemote: !!pendingConfig?.isRemote,
          consoleInfo: pendingConfig?.consoleInfo || {},
          loginInfo: currentLoginInfo || undefined,
          sessionType: "ffmpeg",
        });
        if (!active) {
          if (rawStreamListener) {
            Ipc.removeListener("stream-binary", rawStreamListener);
          }
          return;
        }

        controlTransportReadyRef.current = true;

        const url = `ws://${serverInfo.host}:${serverInfo.port}${serverInfo.path}`;
        wsUrlRef.current = url;
        setStatus(t("Connecting..."));

        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;

        socket.onopen = () => {
          if (!active) return;
          lastControlStateKeyRef.current = "";
          lastSentControllerStateRef.current = createIdleControllerState();
          lastControllerSendAtRef.current = 0;
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
                  updateSessionActivityStatus();
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
                  updateSessionActivityStatus();
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
            if (nativeBinaryTransportRef.current) {
              return;
            }
            handleBinaryPacket(new Uint8Array(event.data));
            return;
          }

          if (event.data instanceof Blob) {
            if (nativeBinaryTransportRef.current) {
              return;
            }
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
          controlTransportReadyRef.current = false;
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

        return () => {
          if (rawStreamListener) {
            Ipc.removeListener("stream-binary", rawStreamListener);
          }
        };
      } catch (error: any) {
        if (rawStreamListener) {
          Ipc.removeListener("stream-binary", rawStreamListener);
        }
        setStatus(
          t("StartSessionFailedWithReason", {
            reason: error?.message || String(error),
          })
        );
        setConnectState("error");
      }
    };

    let cleanupRawListener: null | (() => void) = null;
    start().then((cleanup) => {
      if (typeof cleanup === "function") {
        if (!active) {
          cleanup();
        } else {
          cleanupRawListener = cleanup;
        }
      }
    });
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
      renderLoopScheduledRef.current = false;

      if (socketRef.current && socketRef.current.readyState < WebSocket.CLOSING) {
        socketRef.current.close();
      }
      socketRef.current = null;
      lastControlStateKeyRef.current = "";
      controlTransportReadyRef.current = false;
      lastSentControllerStateRef.current = createIdleControllerState();
      lastControllerSendAtRef.current = 0;
      touchpadStateRef.current = createIdleTouchState();
      touchpadButtonPressedRef.current = false;
      if (touchpadButtonTimerRef.current) {
        clearTimeout(touchpadButtonTimerRef.current);
        touchpadButtonTimerRef.current = null;
      }
      setShowActionbar(false);
      setShowTouchpadOverlay(false);
      clearConnectedFeedbackTimers();
      nativeBinaryTransportRef.current = false;
      nativeVideoFrameRenderedAckPendingCountRef.current = 0;
      if (cleanupRawListener) {
        cleanupRawListener();
        cleanupRawListener = null;
      }

      clearScheduledAudioSources();
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
      fsrGpuRenderingDisabledRef.current = false;
      fsrFrameRenderedRef.current = false;
      clearPressedKeyboardKeys();
      sessionConnectedRef.current = false;
      videoReadyRef.current = false;
      videoConfigReceivedRef.current = false;
      sessionErrorHandledRef.current = false;
      latestFrameRef.current = null;
      pendingNativeVideoFrameBeforeConfigRef.current = null;
      videoFormatRef.current = "NV12";
      setVideoFormat("NV12");
      setFsrFrameRendered(false);
      destroySdrRenderer();
      destroyHdrRenderer();
      destroyFsrRenderer();
      setVideoReady(false);

      Ipc.send("app", "stopStreamSession").catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  useEffect(() => {
    let active = true;
    let nextTickAt = performance.now();

    const runTick = () => {
      if (!active) {
        return;
      }

      pollAndSendControllerStateRef.current();

      const intervalMs = controllerPollingIntervalMsRef.current;
      const now = performance.now();
      nextTickAt = Math.max(nextTickAt + intervalMs, now);
      const delayMs = Math.max(0, nextTickAt - now);
      inputLoopTimerRef.current = window.setTimeout(runTick, delayMs);
    };

    runTick();

    return () => {
      active = false;
      if (inputLoopTimerRef.current !== null) {
        window.clearTimeout(inputLoopTimerRef.current);
        inputLoopTimerRef.current = null;
      }
    };
  }, []);

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

      pollAndSendControllerStateRef.current();
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
      pollAndSendControllerStateRef.current();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearKeyboardState);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearKeyboardState);
      clearPressedKeyboardKeys();
      pollAndSendControllerStateRef.current();
    };
  }, []);

  const handleDisconnect = async () => {
    if (disconnectingRef.current) {
      return;
    }

    disconnectingRef.current = true;
    audioPlaybackEnabledRef.current = false;
    clearScheduledAudioSources();
    clearPressedKeyboardKeys();
    touchpadStateRef.current = createIdleTouchState();
    touchpadButtonPressedRef.current = false;
    if (touchpadButtonTimerRef.current) {
      clearTimeout(touchpadButtonTimerRef.current);
      touchpadButtonTimerRef.current = null;
    }
    setShowTouchpadOverlay(false);
    pollAndSendControllerStateRef.current();
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

    setTimeout(() => {
      const localeParam = Array.isArray(router.query.locale)
        ? router.query.locale[0]
        : router.query.locale || "en";
      router.push(`/${localeParam}/home`);
    }, 2000);
    
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
    clearScheduledAudioSources();
    clearPressedKeyboardKeys();
    touchpadStateRef.current = createIdleTouchState();
    touchpadButtonPressedRef.current = false;
    if (touchpadButtonTimerRef.current) {
      clearTimeout(touchpadButtonTimerRef.current);
      touchpadButtonTimerRef.current = null;
    }
    setShowTouchpadOverlay(false);
    pollAndSendControllerStateRef.current();
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

  const handleBrightnessChange = (value: number | number[]) => {
    const nextValue = Array.isArray(value) ? Number(value[0]) : Number(value);
    if (!Number.isFinite(nextValue)) {
      return;
    }
    const clampedValue = Math.max(BRIGHTNESS_MIN, Math.min(BRIGHTNESS_MAX, Math.round(nextValue)));
    setBrightness(clampedValue);
  };

  const handleBrightnessModalClose = () => {
    setBrightness(persistedBrightness);
    setShowBrightnessModal(false);
  };

  const handleBrightnessModalConfirm = () => {
    setSettings({
      ...settings,
      stream_brightness: brightness,
    });
    setShowBrightnessModal(false);
  };

  const handleFsrSharpnessChange = (value: number | number[]) => {
    const nextValue = Array.isArray(value) ? Number(value[0]) : Number(value);
    if (!Number.isFinite(nextValue)) {
      return;
    }

    const rounded = Math.round(nextValue / FSR_SHARPNESS_STEP) * FSR_SHARPNESS_STEP;
    const clampedValue = Math.max(FSR_SHARPNESS_MIN, Math.min(FSR_SHARPNESS_MAX, rounded));
    setFsrSharpness(Number(clampedValue.toFixed(2)));
  };

  const handleFsrModalConfirm = () => {
    setSettings({
      ...settings,
      fsr_sharpness: fsrSharpness,
    });
    setShowFsrModal(false);
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

      {
        showActionbar && (
          <ActionBar
            type="remoteplay"
            connectState={connectState}
            audioMuted={audioMuted}
            onAudio={audioAvailable ? toggleAudioMuted : undefined}
            onPressPs={handlePressPs}
            onLongPressPs={handleLongPressPs}
            onDisconnect={handleDisconnectWithCurrentMode}
            disconnectAndStandby={disconnectAndStandbyOnExit}
            onDisconnectAndStandbyChange={handleDisconnectStandbySwitchChange}
            onTogglePerformance={() => setShowPerformance((prev) => !prev)}
            onAdjustBrightness={() => setShowBrightnessModal(true)}
            brightnessLabel={t("Brightness")}
            onAdjustFsr={isFsrEnabled ? () => setShowFsrModal(true) : undefined}
            fsrLabel={t("FSR")}
            touchpadPosition={touchpadVerticalPosition}
            onTouchpadPositionChange={handleTouchpadPositionChange}
            touchpadScale={touchpadScale}
            onTouchpadScaleChange={handleTouchpadScaleChange}
            touchpadOpacity={touchpadOpacity}
            onTouchpadOpacityChange={handleTouchpadOpacityChange}
            onDrawerOpenChange={handleActionBarDrawerOpenChange}
          />
        )
      }

      {showPerformance && <Perform connectState={connectState} />}

      <div
        className="absolute inset-0 flex items-center justify-center bg-black"
        style={brightnessRatio === 1 ? undefined : { filter: `brightness(${brightnessRatio})` }}
      >
        <canvas
          ref={canvasRef}
          width={1280}
          height={720}
          className={`block ${videoCanvasSizingClass} ${
            shouldShowSdrCanvas ? "opacity-100" : "opacity-0"
          }`}
        />
        <canvas
          ref={hdrCanvasRef}
          width={1280}
          height={720}
          className={`absolute inset-0 block ${videoCanvasSizingClass} ${
            shouldShowHdrCanvas ? "opacity-100" : "opacity-0"
          }`}
        />
        <canvas
          ref={fsrCanvasRef}
          width={1280}
          height={720}
          className={`absolute inset-0 block ${videoCanvasSizingClass} ${
            shouldShowFsrCanvas ? "opacity-100" : "opacity-0"
          }`}
        />
      </div>

      <div className="pointer-events-none absolute inset-0 z-20">
        <Touchpad
          className={`absolute left-4 ${touchpadVerticalClass}`}
          isPs5={isPs5Console}
          scale={touchpadScale}
          opacity={touchpadOpacity}
          visible={shouldShowTouchpads}
          onActivity={markUserActivity}
          onTap={triggerTouchpadButtonTap}
          onTouchStateChange={updateTouchpadState}
        />
        <Touchpad
          className={`absolute right-4 ${touchpadVerticalClass}`}
          isPs5={isPs5Console}
          scale={touchpadScale}
          opacity={touchpadOpacity}
          visible={shouldShowTouchpads}
          onActivity={markUserActivity}
          onTap={triggerTouchpadButtonTap}
          onTouchStateChange={updateTouchpadState}
        />
      </div>

      <BrightnessModal
        show={showBrightnessModal}
        brightness={brightness}
        min={BRIGHTNESS_MIN}
        max={BRIGHTNESS_MAX}
        onBrightnessChange={handleBrightnessChange}
        onClose={handleBrightnessModalClose}
        onConfirm={handleBrightnessModalConfirm}
        onReset={() => setBrightness(BRIGHTNESS_DEFAULT)}
      />

      <FsrModal
        show={showFsrModal}
        sharpness={fsrSharpness}
        min={FSR_SHARPNESS_MIN}
        max={FSR_SHARPNESS_MAX}
        step={FSR_SHARPNESS_STEP}
        onSharpnessChange={handleFsrSharpnessChange}
        onClose={() => setShowFsrModal(false)}
        onConfirm={handleFsrModalConfirm}
        onReset={() => setFsrSharpness(normalizeFsrSharpness(defaultSettings.fsr_sharpness))}
      />

      {!shouldShowVideo && !sessionAlert ? (
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

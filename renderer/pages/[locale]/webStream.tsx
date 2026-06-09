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
import {
  getDualSenseHidInputStates,
  hasActiveDualSenseTouchState,
  isDualSenseHidManagedGamepad,
  requestDualSenseHidAccessIfNeeded,
  retainDualSenseHidBridge,
  subscribeDualSenseHidChanges,
  syncDualSenseHidGamepads,
} from "../../lib/dualsenseHid";
import { handleGamepadLedColorFromPeasyo } from "../../lib/gamepadLedColor";
import {
  canUseDualSenseGamepadHaptics,
  triggerGamepadHapticsFromPeasyo,
} from "../../lib/gamepadHaptics";
import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";
import {
  triggerGamepadRumbleFromPeasyo,
  triggerNativeGamepadRumbleFromPeasyo,
} from "../../lib/gamepadRumble";
import { handleGamepadTriggerEffectsFromPeasyo } from "../../lib/gamepadTriggerEffects";
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
const WS_BINARY_VIDEO_ENCODED = 3;
const WS_BINARY_HAPTIC = 4;
const HAPTIC_PACKET_HEADER_BYTES = 4;
const ENCODED_VIDEO_SAMPLE_PACKET_HEADER_BYTES = 5;
const DISPLAY_REFRESH_INTERVAL_DEFAULT_US = Math.round(1000000 / 60);
const MAX_PENDING_AUDIO_BYTES = 4 * 1024 * 1024;
const AUDIO_CONTEXT_LATENCY_SEC = 0.02;
const AUDIO_SCHEDULE_LEAD_SEC = 0.01;
const AUDIO_START_BUFFER_SEC = 0.06;
const AUDIO_MAX_BUFFER_SEC = 0.18;
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
const WEBCODECS_H264_CODEC_FALLBACK = "avc1.42E01E";
const WEBCODECS_H264_CODEC_CANDIDATES = [
  "avc1.640033",
  "avc1.640032",
  "avc1.64002A",
  "avc1.640028",
  "avc1.4d4033",
  "avc1.4d402a",
  "avc1.4d4028",
  "avc1.4d401f",
  "avc1.42E01E",
  "avc1.42001E",
  "avc3.640028",
  "avc3.4d4028",
  "avc3.42E01E",
];
const WEBCODECS_HEVC_CODEC_CANDIDATES = [
  "hvc1.1.6.L186.B0",
  "hev1.1.6.L186.B0",
  "hvc1.1.6.L150.B0",
  "hev1.1.6.L150.B0",
  "hvc1.1.6.L120.B0",
  "hev1.1.6.L120.B0",
  "hvc1.1.6.L93.B0",
  "hev1.1.6.L93.B0",
  "hvc1.2.4.L120.B0",
  "hev1.2.4.L120.B0",
];
const MAX_WEBCODECS_DECODE_QUEUE_SIZE = 24;
const MAX_WEBCODECS_RENDER_QUEUE_DEFAULT = 1;
type SteamOsWebCodecsProfile = "balanced" | "stable" | "ultra-stable";
type SteamOsWebCodecsTuning = {
  decodeQueueLimit: number;
  renderQueueLimit: number;
  minBufferFrames: number;
  clockDelayFrames: number;
  rebufferLowFrames: number;
  rebufferResumeFrames: number;
  renderedFrameRetireKeep: number;
  rebufferProtectionIncrementFrames: number;
  rebufferProtectionMaxExtraFrames: number;
  rebufferProtectionDecayRenderedFrames: number;
  rebufferProtectionDecayStepFrames: number;
};
const STEAMOS_WEBCODECS_PROFILE_DEFAULT: SteamOsWebCodecsProfile = "stable";
const STEAMOS_WEBCODECS_PROFILE_TUNING: Record<SteamOsWebCodecsProfile, SteamOsWebCodecsTuning> = {
  balanced: {
    decodeQueueLimit: 24,
    renderQueueLimit: 8,
    minBufferFrames: 4,
    clockDelayFrames: 5,
    rebufferLowFrames: 2,
    rebufferResumeFrames: 5,
    renderedFrameRetireKeep: 3,
    rebufferProtectionIncrementFrames: 0,
    rebufferProtectionMaxExtraFrames: 0,
    rebufferProtectionDecayRenderedFrames: 0,
    rebufferProtectionDecayStepFrames: 0,
  },
  stable: {
    decodeQueueLimit: 36,
    renderQueueLimit: 10,
    minBufferFrames: 6,
    clockDelayFrames: 8,
    rebufferLowFrames: 3,
    rebufferResumeFrames: 8,
    renderedFrameRetireKeep: 4,
    rebufferProtectionIncrementFrames: 1,
    rebufferProtectionMaxExtraFrames: 3,
    rebufferProtectionDecayRenderedFrames: 180,
    rebufferProtectionDecayStepFrames: 1,
  },
  "ultra-stable": {
    decodeQueueLimit: 48,
    renderQueueLimit: 12,
    minBufferFrames: 8,
    clockDelayFrames: 10,
    rebufferLowFrames: 4,
    rebufferResumeFrames: 10,
    renderedFrameRetireKeep: 5,
    rebufferProtectionIncrementFrames: 1,
    rebufferProtectionMaxExtraFrames: 5,
    rebufferProtectionDecayRenderedFrames: 240,
    rebufferProtectionDecayStepFrames: 1,
  },
};

const resolveSteamOsWebCodecsProfile = (value: unknown): SteamOsWebCodecsProfile => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "balanced" || normalized === "stable" || normalized === "ultra-stable") {
    return normalized;
  }
  return STEAMOS_WEBCODECS_PROFILE_DEFAULT;
};

const getWebCodecsHardwareAccelerationModes = (): VideoDecoderConfig["hardwareAcceleration"][] => {
  if (isSteamOsRuntime()) {
    return ["prefer-software", "no-preference", "prefer-hardware"];
  }
  if (isLinuxRuntime()) {
    return ["no-preference", "prefer-hardware", "prefer-software"];
  }
  return ["prefer-hardware", "no-preference", "prefer-software"];
};

type PendingStreamConfig = {
  streamHost?: string;
  isRemote?: boolean;
  autoRemote?: boolean;
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

const shouldDeferEncodedAckUntilFrameConsumed = () => {
  return isSteamOsRuntime();
};

const isHdrVideoFormat = (format: VideoFrameFormat) => {
  return format === "I010" || format === "P010";
};

const isWebCodecsVideoDecoderAvailable = () => {
  return typeof VideoDecoder === "function";
};

const checkWebCodecsCodecSupport = async (codecCandidates: string[]) => {
  if (!isWebCodecsVideoDecoderAvailable()) {
    return null;
  }

  const hardwareAccelerationModes = getWebCodecsHardwareAccelerationModes();

  for (const codec of codecCandidates) {
    for (const hardwareAcceleration of hardwareAccelerationModes) {
      try {
        let support = await VideoDecoder.isConfigSupported({
          codec,
          codedWidth: 1280,
          codedHeight: 720,
          hardwareAcceleration,
          optimizeForLatency: true,
        });
        if (!support?.supported) {
          support = await VideoDecoder.isConfigSupported({
            codec,
            hardwareAcceleration,
            optimizeForLatency: true,
          });
        }
        if (support?.supported) {
          return codec;
        }
      } catch {
        // Ignore unsupported codec probes.
      }
    }
  }

  return null;
};

const resolveRequestedStreamCodecFamily = (
  settings: Record<string, any> | null | undefined,
  isRemote: boolean
): StreamCodecFamily => {
  const rawCodec = String(isRemote ? settings?.remote_codec : settings?.codec || "H265")
    .trim()
    .toUpperCase();
  return rawCodec.includes("264") ? "h264" : "hevc";
};

const resolveNegotiatedStreamCodec = (
  requestedCodecFamily: StreamCodecFamily,
  capabilities: ClientVideoCapabilities
) => {
  if (!capabilities.webCodecs) {
    return null;
  }

  if (requestedCodecFamily === "hevc") {
    if (capabilities.hevc) {
      return "H265";
    }
    if (capabilities.h264) {
      return "H264";
    }
    return null;
  }

  if (capabilities.h264) {
    return "H264";
  }
  if (capabilities.hevc) {
    return "H265";
  }
  return null;
};

const detectClientVideoCapabilities = async (
  codecFamily: StreamCodecFamily
): Promise<ClientVideoCapabilities> => {
  if (!isWebCodecsVideoDecoderAvailable()) {
    return {
      webCodecs: false,
      preferCompressedVideo: false,
      h264: false,
      hevc: false,
      isSteamOs: isSteamOsRuntime(),
    };
  }

  const [h264Codec, hevcCodec] = await Promise.all([
    checkWebCodecsCodecSupport(WEBCODECS_H264_CODEC_CANDIDATES),
    checkWebCodecsCodecSupport(WEBCODECS_HEVC_CODEC_CANDIDATES),
  ]);
  const canUseSteamOsOptimisticH264 = isSteamOsRuntime() && !h264Codec;
  const resolvedH264Codec = h264Codec || (canUseSteamOsOptimisticH264 ? WEBCODECS_H264_CODEC_FALLBACK : null);

  return {
    webCodecs: true,
    preferCompressedVideo: codecFamily === "hevc" ? !!hevcCodec || !!resolvedH264Codec : !!resolvedH264Codec,
    h264: !!resolvedH264Codec,
    hevc: !!hevcCodec,
    isSteamOs: isSteamOsRuntime(),
    ...(resolvedH264Codec ? { h264Codec: resolvedH264Codec } : {}),
    ...(hevcCodec ? { hevcCodec } : {}),
  };
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

const CONTROLLER_DEBUG_LOG_INTERVAL_MS = 1000;

const formatControllerDebugTouch = (touch: TouchPoint) => {
  if (touch.id < 0) return "-1";
  return `${touch.id}:${touch.x ?? 0}:${touch.y ?? 0}`;
};

const formatControllerDebugState = (state: ControllerStatePayload) => {
  return `buttons=0x${(state.buttons >>> 0).toString(16)} l2=${state.l2State} r2=${state.r2State} axes=${state.leftX},${state.leftY},${state.rightX},${state.rightY} touchNext=${state.touchIdNext} touches=[${formatControllerDebugTouch(state.touches[0])};${formatControllerDebugTouch(state.touches[1])}]`;
};

const hasControllerDebugActivity = (state: ControllerStatePayload) => {
  return (
    state.buttons !== 0 ||
    state.l2State !== 0 ||
    state.r2State !== 0 ||
    state.leftX !== 0 ||
    state.leftY !== 0 ||
    state.rightX !== 0 ||
    state.rightY !== 0 ||
    state.touches.some((touch) => touch.id >= 0)
  );
};

type ControllerInputButtonLike = {
  pressed?: boolean;
  value?: number;
} | null | undefined;

type ControllerInputSource = {
  axes: ArrayLike<number>;
  buttons: ArrayLike<ControllerInputButtonLike>;
};

type VideoDisplayFormat = "default" | "stretch" | "zoom";
type ControllerInputKernel = "web" | "node";
type TouchpadVerticalPosition = "top" | "center" | "bottom";
type StreamCodecFamily = "h264" | "hevc";
type StreamVideoTransportMode = "ffmpeg-rawvideo" | "compressed-webcodecs";

type ClientVideoCapabilities = {
  webCodecs: boolean;
  preferCompressedVideo: boolean;
  h264: boolean;
  hevc: boolean;
  isSteamOs?: boolean;
  h264Codec?: string;
  hevcCodec?: string;
};

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
  "remote_progress",
]);

const formatProgressStatus = (
  t: (key: string, options?: Record<string, any>) => string,
  stage: unknown,
  progress: unknown
) => {
  const stageKey = typeof stage === "string" ? stage : "";
  if (stageKey === "psnTokenExpired") {
    return t("psnTokenExpired");
  }
  const text = stageKey ? t(stageKey) : t("Connecting...");
  const numericProgress = Number(progress);
  return Number.isFinite(numericProgress) && numericProgress >= 0
    ? `${text} ${Math.round(numericProgress)}%`
    : text;
};

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
  const [disconnectAndStandbyOnExit, setDisconnectAndStandbyOnExit] = useState(false);
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
  const videoTransportRef = useRef<StreamVideoTransportMode>("ffmpeg-rawvideo");
  const videoInputFormatRef = useRef<StreamCodecFamily>("hevc");
  const latestFrameRef = useRef<Uint8Array | null>(null);
  const decodedVideoFrameQueueRef = useRef<VideoFrame[]>([]);
  const renderedDecodedVideoFrameRetireQueueRef = useRef<VideoFrame[]>([]);
  const decodedVideoFrameClockWallStartUsRef = useRef(0);
  const decodedVideoFrameClockMediaStartUsRef = useRef(0);
  const decodedVideoFrameClockPrimedRef = useRef(false);
  const decodedVideoFrameDisplayIntervalUsRef = useRef(DISPLAY_REFRESH_INTERVAL_DEFAULT_US);
  const decodedVideoFrameLastRenderLoopAtUsRef = useRef(0);
  const decodedVideoFrameRebufferingRef = useRef(false);
  const decodedVideoFrameDynamicDelayFramesRef = useRef(0);
  const decodedVideoFrameStableRenderFramesRef = useRef(0);
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
  const nativeVideoFrameRenderedAckPendingQueueRef = useRef<Array<number | null>>([]);
  const webCodecsCapabilitiesRef = useRef<ClientVideoCapabilities | null>(null);
  const webCodecsVideoDecoderRef = useRef<VideoDecoder | null>(null);
  const webCodecsAwaitingKeyFrameRef = useRef(false);
  const webCodecsTimestampUsRef = useRef(0);
  const webCodecsLastSampleIdRef = useRef(0);
  const webCodecsCodecStringRef = useRef("");
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
  const lastControllerDebugLogAtRef = useRef(0);
  const pollAndSendControllerStateRef = useRef<() => void>(() => undefined);
  const rumbleEnabledRef = useRef(settings?.rumble !== false);
  const rumbleIntensityRef = useRef(settings?.rumble_intensity);
  const hapticEnabledRef = useRef(settings?.haptic === true);
  const hapticIntensityRef = useRef(settings?.haptic_feedback_intensity);
  const hapticSuppressedFrameSeqRef = useRef<Set<number>>(new Set());

  const steamOsRuntime = isSteamOsRuntime();
  const steamOsWebCodecsProfile = resolveSteamOsWebCodecsProfile(
    settings?.stream_webcodec_steamos_profile
  );
  const steamOsWebCodecsTuning = STEAMOS_WEBCODECS_PROFILE_TUNING[steamOsWebCodecsProfile];

  const getWebCodecsDecodeQueueLimit = () => {
    return steamOsRuntime
      ? steamOsWebCodecsTuning.decodeQueueLimit
      : MAX_WEBCODECS_DECODE_QUEUE_SIZE;
  };

  const getWebCodecsRenderQueueLimit = () => {
    return steamOsRuntime
      ? steamOsWebCodecsTuning.renderQueueLimit
      : MAX_WEBCODECS_RENDER_QUEUE_DEFAULT;
  };

  const shouldUseTimestampDrivenWebCodecsRender = () => {
    return steamOsRuntime;
  };

  const getSteamOsWebCodecsMinBufferFrames = () => {
    return steamOsWebCodecsTuning.minBufferFrames;
  };

  const getSteamOsWebCodecsClockDelayFrames = () => {
    return steamOsWebCodecsTuning.clockDelayFrames;
  };

  const getSteamOsWebCodecsRebufferLowFrames = () => {
    return steamOsWebCodecsTuning.rebufferLowFrames;
  };

  const getSteamOsWebCodecsRebufferResumeFrames = () => {
    return steamOsWebCodecsTuning.rebufferResumeFrames;
  };

  const getSteamOsRenderedFrameRetireKeepCount = () => {
    return steamOsWebCodecsTuning.renderedFrameRetireKeep;
  };

  const getSteamOsRebufferProtectionIncrementFrames = () => {
    return steamOsWebCodecsTuning.rebufferProtectionIncrementFrames;
  };

  const getSteamOsRebufferProtectionMaxExtraFrames = () => {
    return steamOsWebCodecsTuning.rebufferProtectionMaxExtraFrames;
  };

  const getSteamOsRebufferProtectionDecayRenderedFrames = () => {
    return steamOsWebCodecsTuning.rebufferProtectionDecayRenderedFrames;
  };

  const getSteamOsRebufferProtectionDecayStepFrames = () => {
    return steamOsWebCodecsTuning.rebufferProtectionDecayStepFrames;
  };

  useEffect(() => {
    // Reset dynamic rebuffer delay when SteamOS profile changes.
    decodedVideoFrameDynamicDelayFramesRef.current = 0;
    decodedVideoFrameStableRenderFramesRef.current = 0;
  }, [steamOsRuntime, steamOsWebCodecsProfile]);

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
    setDisconnectAndStandbyOnExit(enabled);
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
    const release = retainDualSenseHidBridge();
    const unsubscribe = subscribeDualSenseHidChanges(() => {
      pollAndSendControllerStateRef.current();
    });

    return () => {
      unsubscribe();
      release();
    };
  }, []);

  useEffect(() => {
    keyboardMappingRef.current = normalizeKeyboardMapping(
      settings?.input_mousekeyboard_maping
    );
    gamepadMappingRef.current = normalizeGamepadButtonMapping(settings?.gamepad_maping);
    controllerInputKernelRef.current = resolveControllerInputKernel({
      gamepad_kernel: settings?.gamepad_kernel,
    });
    rumbleEnabledRef.current = settings?.rumble !== false;
    rumbleIntensityRef.current = settings?.rumble_intensity;
    hapticEnabledRef.current = settings?.haptic === true;
    hapticIntensityRef.current = settings?.haptic_feedback_intensity;

    controllerPollingIntervalMsRef.current = resolveControllerPollingIntervalMs(
      settings?.polling_rate
    );
    controllerSendIntervalMsRef.current = resolveControllerSendIntervalMs(
      settings?.polling_rate
    );

    const ensureDualSenseHidAccess = () => {
      if (controllerInputKernelRef.current !== "web") {
        return;
      }
      void requestDualSenseHidAccessIfNeeded();
    };

    const activityEvent = () => {
      markUserActivity();
    };
    window.addEventListener("mousemove", activityEvent);
    window.addEventListener("mousedown", activityEvent);

    window.addEventListener("touchstart", activityEvent);
    window.addEventListener("touchmove", activityEvent);
    window.addEventListener("mousedown", ensureDualSenseHidAccess);
    window.addEventListener("touchstart", ensureDualSenseHidAccess);

    const escEvent = (event: KeyboardEvent) => {
      ensureDualSenseHidAccess();
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
      window.removeEventListener("mousedown", ensureDualSenseHidAccess);
      window.removeEventListener("touchstart", ensureDualSenseHidAccess);
      window.removeEventListener("keydown", escEvent);
    };
  }, [
    settings?.polling_rate,
    settings?.input_mousekeyboard_maping,
    settings?.gamepad_maping,
    settings?.gamepad_kernel,
    settings?.rumble,
    settings?.rumble_intensity,
    settings?.haptic,
    settings?.haptic_feedback_intensity,
    markUserActivity,
  ]);

  useEffect(() => {
    const shouldEnableFsr = !!settings?.fsr;
    fsrEnabledRef.current = shouldEnableFsr;
    if (!shouldEnableFsr) {
      setShowFsrModal(false);
    }
  }, [settings?.fsr]);

  useEffect(() => {
    const nextSharpness = normalizeFsrSharpness(settings?.fsr_sharpness);
    setFsrSharpness(nextSharpness);
  }, [settings?.fsr_sharpness]);

  useEffect(() => {
    const linuxVulkanEnabled = isLinuxRuntime() && !!settings?.use_vulkan;
    forceSdrCpuRenderingRef.current = isSteamOsRuntime() && linuxVulkanEnabled;
  }, [settings?.use_vulkan]);

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
    const transport: StreamVideoTransportMode =
      config?.transport === "compressed-webcodecs"
        ? "compressed-webcodecs"
        : "ffmpeg-rawvideo";
    const inputFormat = String(config?.inputFormat || "h264")
      .trim()
      .toLowerCase();
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
    videoTransportRef.current = transport;
    videoInputFormatRef.current = inputFormat === "hevc" ? "hevc" : "h264";
    setVideoFormat(format);
    imageDataRef.current = null;
    ctxRef.current = null;
    clearDecodedVideoFrameQueue();

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

    if (transport === "compressed-webcodecs") {
      destroyHdrRenderer();
      destroySdrRenderer();
      try {
        ensureWebCodecsDecoder(inputFormat);
      } catch (error) {
        openSessionAlert(
          [
            "WebCodecs video decoder initialization failed.",
            getErrorMessage(error, "Linux native video decoder initialization failed."),
          ].join("\n"),
          t("HdrRendererErrorStatus")
        );
      }
      return;
    }

    destroyWebCodecsVideoDecoder();

    if (!isHdrVideoFormat(format)) {
      destroyHdrRenderer();
    } else {
      destroySdrRenderer();
    }

    if (isHdrVideoFormat(format) && !window.WebGL2RenderingContext) {
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

  const resetDecodedVideoFrameClock = () => {
    decodedVideoFrameClockWallStartUsRef.current = 0;
    decodedVideoFrameClockMediaStartUsRef.current = 0;
    decodedVideoFrameClockPrimedRef.current = false;
    decodedVideoFrameDisplayIntervalUsRef.current = DISPLAY_REFRESH_INTERVAL_DEFAULT_US;
    decodedVideoFrameLastRenderLoopAtUsRef.current = 0;
    decodedVideoFrameRebufferingRef.current = false;
  };

  const getSteamOsEffectiveWebCodecsClockDelayFrames = () => {
    if (!shouldUseTimestampDrivenWebCodecsRender()) {
      return 0;
    }
    const baseFrames = Math.max(
      getSteamOsWebCodecsMinBufferFrames(),
      getSteamOsWebCodecsClockDelayFrames()
    );
    return baseFrames + decodedVideoFrameDynamicDelayFramesRef.current;
  };

  const increaseSteamOsDynamicRebufferProtection = () => {
    if (!shouldUseTimestampDrivenWebCodecsRender()) {
      return;
    }

    const incrementFrames = Math.max(0, getSteamOsRebufferProtectionIncrementFrames());
    const maxExtraFrames = Math.max(0, getSteamOsRebufferProtectionMaxExtraFrames());
    if (incrementFrames < 1 || maxExtraFrames < 1) {
      return;
    }

    decodedVideoFrameDynamicDelayFramesRef.current = Math.min(
      maxExtraFrames,
      decodedVideoFrameDynamicDelayFramesRef.current + incrementFrames
    );
    decodedVideoFrameStableRenderFramesRef.current = 0;
  };

  const relaxSteamOsDynamicRebufferProtectionAfterRender = () => {
    if (!shouldUseTimestampDrivenWebCodecsRender() || decodedVideoFrameRebufferingRef.current) {
      return;
    }

    const currentExtraFrames = decodedVideoFrameDynamicDelayFramesRef.current;
    if (currentExtraFrames < 1) {
      return;
    }

    const decayRenderedFrames = Math.max(0, getSteamOsRebufferProtectionDecayRenderedFrames());
    const decayStepFrames = Math.max(0, getSteamOsRebufferProtectionDecayStepFrames());
    if (decayRenderedFrames < 1 || decayStepFrames < 1) {
      return;
    }

    decodedVideoFrameStableRenderFramesRef.current += 1;
    if (decodedVideoFrameStableRenderFramesRef.current < decayRenderedFrames) {
      return;
    }

    decodedVideoFrameStableRenderFramesRef.current = 0;
    decodedVideoFrameDynamicDelayFramesRef.current = Math.max(
      0,
      currentExtraFrames - decayStepFrames
    );
  };

  const parseEncodedVideoSamplePacket = (packetBytes: Uint8Array) => {
    if (packetBytes.byteLength < 1) {
      return null;
    }

    const flags = packetBytes[0];
    if (packetBytes.byteLength < ENCODED_VIDEO_SAMPLE_PACKET_HEADER_BYTES) {
      return {
        flags,
        sampleId: null,
        sampleBytes: packetBytes.subarray(1),
      };
    }

    const sampleId = new DataView(
      packetBytes.buffer,
      packetBytes.byteOffset + 1,
      4
    ).getUint32(0, true);
    return {
      flags,
      sampleId,
      sampleBytes: packetBytes.subarray(ENCODED_VIDEO_SAMPLE_PACKET_HEADER_BYTES),
    };
  };

  const clearDecodedVideoFrameQueue = (ackDroppedFrames = true) => {
    const queue = decodedVideoFrameQueueRef.current;
    if (queue.length < 1) {
      resetDecodedVideoFrameClock();
      return;
    }

    while (queue.length > 0) {
      const frame = queue.shift();
      if (!frame) {
        continue;
      }
      if (ackDroppedFrames) {
        ackRenderedNativeVideoFrame();
      }
      try {
        frame.close();
      } catch {
        // Ignore stale frame cleanup errors.
      }
    }

    resetDecodedVideoFrameClock();
  };

  const pauseDecodedVideoFrameClockForRebuffer = () => {
    decodedVideoFrameClockWallStartUsRef.current = 0;
    decodedVideoFrameClockMediaStartUsRef.current = 0;
    decodedVideoFrameClockPrimedRef.current = false;
    decodedVideoFrameRebufferingRef.current = true;
  };

  const syncDecodedVideoFrameClockToHead = (delayFrames = 0) => {
    if (decodedVideoFrameQueueRef.current.length < 1) {
      resetDecodedVideoFrameClock();
      return;
    }

    const startupBufferFrames = Math.max(0, delayFrames);
    const frameIntervalUs = Math.max(1, Math.round(1000000 / Math.max(1, fpsRef.current)));
    const nowUs = performance.now() * 1000;
    decodedVideoFrameClockWallStartUsRef.current = nowUs;
    decodedVideoFrameClockMediaStartUsRef.current =
      nowUs - frameIntervalUs * Math.min(1, startupBufferFrames);
    decodedVideoFrameClockPrimedRef.current = true;
  };

  const updateDecodedVideoFrameDisplayIntervalEstimate = (nowUs: number) => {
    const lastNowUs = decodedVideoFrameLastRenderLoopAtUsRef.current;
    decodedVideoFrameLastRenderLoopAtUsRef.current = nowUs;
    if (lastNowUs < 1) {
      return;
    }

    const deltaUs = nowUs - lastNowUs;
    if (deltaUs < 4_000 || deltaUs > 40_000) {
      return;
    }

    const previousEstimateUs = decodedVideoFrameDisplayIntervalUsRef.current;
    decodedVideoFrameDisplayIntervalUsRef.current = Math.round(
      previousEstimateUs * 0.85 + deltaUs * 0.15
    );
  };

  const getDecodedVideoFramePacingIntervalUs = (frameIntervalUs: number) => {
    const displayIntervalUs = Math.max(
      1,
      Math.round(decodedVideoFrameDisplayIntervalUsRef.current || DISPLAY_REFRESH_INTERVAL_DEFAULT_US)
    );
    if (shouldUseTimestampDrivenWebCodecsRender()) {
      const clampedDisplayIntervalUs = Math.max(
        Math.round(frameIntervalUs * 0.9),
        Math.min(Math.round(frameIntervalUs * 1.1), displayIntervalUs)
      );
      return Math.max(frameIntervalUs, clampedDisplayIntervalUs);
    }
    return frameIntervalUs;
  };

  const trimDecodedVideoFramesForSteadyPacing = () => {
    const queue = decodedVideoFrameQueueRef.current;
    const maxQueuedFramesToKeep = shouldUseTimestampDrivenWebCodecsRender()
      ? Math.max(
          getSteamOsWebCodecsRebufferResumeFrames(),
          getSteamOsEffectiveWebCodecsClockDelayFrames()
        )
      : 1;
    while (queue.length > maxQueuedFramesToKeep) {
      const staleFrame = queue.shift();
      if (!staleFrame) {
        break;
      }

      droppedFramesRef.current += 1;
      ackRenderedNativeVideoFrame();
      closeDecodedVideoFrame(staleFrame);
    }
  };

  const closeDecodedVideoFrame = (frame: VideoFrame) => {
    try {
      frame.close();
    } catch {
      // Ignore stale frame cleanup errors.
    }
  };

  const flushRenderedDecodedVideoFrameRetireQueue = (force = false) => {
    const queue = renderedDecodedVideoFrameRetireQueueRef.current;
    const keepCount = force
      ? 0
      : shouldUseTimestampDrivenWebCodecsRender()
        ? getSteamOsRenderedFrameRetireKeepCount()
        : 2;
    while (queue.length > keepCount) {
      const frame = queue.shift();
      if (!frame) {
        continue;
      }
      closeDecodedVideoFrame(frame);
    }
  };

  const retireRenderedDecodedVideoFrame = (frame: VideoFrame) => {
    renderedDecodedVideoFrameRetireQueueRef.current.push(frame);
    flushRenderedDecodedVideoFrameRetireQueue(false);
  };

  const scheduleRenderLoop = () => {
    if (renderLoopScheduledRef.current) {
      return;
    }

    renderLoopScheduledRef.current = true;
    rafRef.current = requestAnimationFrame(renderLoop);
  };

  const queueNativeVideoFrameRenderedAck = (sampleId: number | null = null) => {
    if (!nativeBinaryTransportRef.current) {
      return;
    }

    const queue = nativeVideoFrameRenderedAckPendingQueueRef.current;
    const maxPendingAcks =
      videoTransportRef.current === "compressed-webcodecs" && shouldDeferEncodedAckUntilFrameConsumed()
        ? getWebCodecsDecodeQueueLimit()
        : 2048;
    if (queue.length >= maxPendingAcks) {
      return;
    }

    queue.push(sampleId);
  };

  const ackRenderedNativeVideoFrame = (count = 1) => {
    const queue = nativeVideoFrameRenderedAckPendingQueueRef.current;
    while (count > 0 && queue.length > 0) {
      const sampleId = queue.shift();
      Ipc.sendStreamVideoFrameRendered(
        typeof sampleId === "number" && Number.isFinite(sampleId) ? sampleId : undefined
      );
      count -= 1;
    }
  };

  const ackAllRenderedNativeVideoFrames = () => {
    ackRenderedNativeVideoFrame(nativeVideoFrameRenderedAckPendingQueueRef.current.length);
  };

  const destroyWebCodecsVideoDecoder = () => {
    clearDecodedVideoFrameQueue();
    flushRenderedDecodedVideoFrameRetireQueue(true);
    webCodecsAwaitingKeyFrameRef.current = false;
    webCodecsTimestampUsRef.current = 0;
    webCodecsLastSampleIdRef.current = 0;
    webCodecsCodecStringRef.current = "";

    const decoder = webCodecsVideoDecoderRef.current;
    webCodecsVideoDecoderRef.current = null;
    if (!decoder) {
      return;
    }

    try {
      decoder.close();
    } catch {
      // Ignore teardown failures from partially initialized decoders.
    }
  };

  const recoverWebCodecsDecoder = (reason: string) => {
    console.warn(`[webStream] resetting WebCodecs decoder: ${reason}`);
    destroyWebCodecsVideoDecoder();
    webCodecsAwaitingKeyFrameRef.current = true;
    ackAllRenderedNativeVideoFrames();
  };

  const enqueueDecodedVideoFrame = (frame: VideoFrame) => {
    receivedFramesRef.current += 1;
    if (!sessionConnectedRef.current) {
      sessionConnectedRef.current = true;
      setConnectState("connected");
      setStatus(t("Connected"));
    }

    const queue = decodedVideoFrameQueueRef.current;
    queue.push(frame);

    const renderQueueLimit = getWebCodecsRenderQueueLimit();
    while (queue.length > renderQueueLimit) {
      const droppedFrame = queue.shift();
      if (!droppedFrame) {
        break;
      }
      droppedFramesRef.current += 1;
      ackRenderedNativeVideoFrame();
      closeDecodedVideoFrame(droppedFrame);
    }

    if (!shouldUseTimestampDrivenWebCodecsRender()) {
      if (queue.length === 1) {
        resetDecodedVideoFrameClock();
      }
    } else {
      const minBufferFrames = getSteamOsEffectiveWebCodecsClockDelayFrames();
      if (
        !decodedVideoFrameClockPrimedRef.current &&
        !decodedVideoFrameRebufferingRef.current &&
        queue.length >= minBufferFrames
      ) {
        syncDecodedVideoFrameClockToHead(minBufferFrames);
      }
    }

    scheduleRenderLoop();
  };

  const resolveWebCodecsCodecString = (inputFormat: string) => {
    const capabilities = webCodecsCapabilitiesRef.current;
    if (!capabilities) {
      return "";
    }

    if (inputFormat === "hevc") {
      return capabilities.hevcCodec || "";
    }

    return capabilities.h264Codec || "";
  };

  const createWebCodecsDecoder = (inputFormat: string) => {
    if (!isWebCodecsVideoDecoderAvailable()) {
      throw new Error("WebCodecs VideoDecoder is not available.");
    }

    const codec = resolveWebCodecsCodecString(inputFormat);
    if (!codec) {
      throw new Error(`No supported WebCodecs codec was detected for ${inputFormat}.`);
    }

    const hardwareAccelerationModes = getWebCodecsHardwareAccelerationModes();
    let lastError: unknown = null;
    // Linux + optimizeForLatency has a higher chance to trigger compositor tearing on SteamOS.
    const optimizeForLatency = !isLinuxRuntime();

    for (const hardwareAcceleration of hardwareAccelerationModes) {
      const decoder = new VideoDecoder({
        output: (frame) => {
          enqueueDecodedVideoFrame(frame);
        },
        error: (error) => {
          recoverWebCodecsDecoder(getErrorMessage(error, "WebCodecs decoder error."));
        },
      });

      try {
        decoder.configure({
          codec,
          codedWidth: widthRef.current,
          codedHeight: heightRef.current,
          hardwareAcceleration,
          optimizeForLatency,
        });

        webCodecsCodecStringRef.current = codec;
        webCodecsVideoDecoderRef.current = decoder;
        return decoder;
      } catch (error) {
        lastError = error;
        try {
          decoder.close();
        } catch {
          // Ignore configure teardown failures.
        }
      }
    }

    throw (
      lastError instanceof Error
        ? lastError
        : new Error(`Failed to configure WebCodecs decoder for codec ${codec}.`)
    );
  };

  const ensureWebCodecsDecoder = (inputFormat: string) => {
    const codec = resolveWebCodecsCodecString(inputFormat);
    const currentDecoder = webCodecsVideoDecoderRef.current;
    if (currentDecoder && webCodecsCodecStringRef.current === codec) {
      return currentDecoder;
    }

    destroyWebCodecsVideoDecoder();
    return createWebCodecsDecoder(inputFormat);
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

    const bytesPerSecond =
      Math.max(1, audioRateRef.current) * Math.max(1, audioChannelsRef.current) * 4;
    const startupQueueByteLimit = Math.max(
      Math.floor(bytesPerSecond * AUDIO_START_BUFFER_SEC),
      Math.max(1, audioFrameSamplesRef.current) * Math.max(1, audioChannelsRef.current) * 4
    );
    const queueByteLimit =
      !audioUnlockedRef.current || !videoReadyRef.current || !audioPlaybackEnabledRef.current
        ? Math.min(MAX_PENDING_AUDIO_BYTES, startupQueueByteLimit)
        : MAX_PENDING_AUDIO_BYTES;

    while (pendingAudioBytesRef.current > queueByteLimit && pendingAudioQueueRef.current.length > 0) {
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
    const bytesPerSecond =
      Math.max(1, audioRateRef.current) * Math.max(1, audioChannelsRef.current) * 4;
    const startupQueueByteLimit = Math.max(
      Math.floor(bytesPerSecond * AUDIO_START_BUFFER_SEC),
      Math.max(1, audioFrameSamplesRef.current) * Math.max(1, audioChannelsRef.current) * 4
    );

    while (
      pendingAudioBytesRef.current > startupQueueByteLimit &&
      pendingAudioQueueRef.current.length > 0
    ) {
      const dropped = pendingAudioQueueRef.current.shift();
      if (dropped) {
        pendingAudioBytesRef.current -= dropped.byteLength;
        audioDroppedChunksRef.current += 1;
      }
    }

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

  const handleEncodedVideoSampleBytes = (packetBytes: Uint8Array) => {
    const encodedSamplePacket = parseEncodedVideoSamplePacket(packetBytes);
    queueNativeVideoFrameRenderedAck(encodedSamplePacket?.sampleId ?? null);

    if (!encodedSamplePacket) {
      ackRenderedNativeVideoFrame();
      return;
    }

    const { flags, sampleId, sampleBytes } = encodedSamplePacket;
    const isKeyFrame = (flags & 1) !== 0;
    const canStartDecode = isKeyFrame;
    const inputFormat = videoInputFormatRef.current;

    if (sampleBytes.byteLength < 1) {
      ackRenderedNativeVideoFrame();
      return;
    }

    if (webCodecsAwaitingKeyFrameRef.current && !canStartDecode) {
      ackRenderedNativeVideoFrame();
      return;
    }

    try {
      let decoder = webCodecsVideoDecoderRef.current;
      if (!decoder || webCodecsCodecStringRef.current !== resolveWebCodecsCodecString(inputFormat)) {
        decoder = ensureWebCodecsDecoder(inputFormat);
      }

      const decodeQueueSize = decoder.decodeQueueSize;
      if (decodeQueueSize >= getWebCodecsDecodeQueueLimit() && !canStartDecode) {
        // Keep decoder stable under transient burst by dropping overflow delta chunks.
        droppedFramesRef.current += 1;
        ackRenderedNativeVideoFrame();
        return;
      }

      if (webCodecsAwaitingKeyFrameRef.current && canStartDecode) {
        webCodecsAwaitingKeyFrameRef.current = false;
      }

      const duration = Math.max(1, Math.round(1000000 / Math.max(1, fpsRef.current)));
      const previousSampleId = webCodecsLastSampleIdRef.current;
      const sampleGap =
        sampleId !== null && previousSampleId > 0 ? Math.max(1, sampleId - previousSampleId) : 1;
      const timestamp = webCodecsTimestampUsRef.current;
      webCodecsTimestampUsRef.current += Math.max(1, duration * sampleGap);
      if (sampleId !== null) {
        webCodecsLastSampleIdRef.current = sampleId;
      } else if (previousSampleId > 0) {
        webCodecsLastSampleIdRef.current = previousSampleId + sampleGap;
      }

      decoder.decode(
        new EncodedVideoChunk({
          type: canStartDecode ? "key" : "delta",
          timestamp,
          duration,
          data: sampleBytes,
        })
      );
      if (!shouldDeferEncodedAckUntilFrameConsumed()) {
        ackRenderedNativeVideoFrame();
      }
    } catch (error) {
      recoverWebCodecsDecoder(getErrorMessage(error, "WebCodecs video decode failed."));
      ackRenderedNativeVideoFrame();
    }
  };

  const handleVideoFrameBytes = (frameBytes: Uint8Array) => {
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
    scheduleRenderLoop();
  };

  const handleBinaryPacket = (packetBytes: Uint8Array) => {
    if (packetBytes.byteLength < 2) {
      return;
    }

    const rememberHapticFrameSeq = (frameSeq: number) => {
      if (!Number.isFinite(frameSeq)) {
        return;
      }

      hapticSuppressedFrameSeqRef.current.add(Math.trunc(frameSeq));
      if (hapticSuppressedFrameSeqRef.current.size > 128) {
        const first = hapticSuppressedFrameSeqRef.current.values().next().value;
        if (first !== undefined) {
          hapticSuppressedFrameSeqRef.current.delete(first);
        }
      }
    };

    const handleHapticFrameBytes = (hapticPacketBytes: Uint8Array) => {
      if (
        hapticPacketBytes.byteLength <= HAPTIC_PACKET_HEADER_BYTES ||
        controllerInputKernelRef.current !== "web" ||
        !hapticEnabledRef.current
      ) {
        return;
      }

      const headerView = new DataView(
        hapticPacketBytes.buffer,
        hapticPacketBytes.byteOffset,
        HAPTIC_PACKET_HEADER_BYTES
      );
      const hapticFrameSeq = headerView.getUint32(0, true);
      const played = triggerGamepadHapticsFromPeasyo(
        {
          data: hapticPacketBytes.subarray(HAPTIC_PACKET_HEADER_BYTES),
          hapticFrameSeq,
        },
        {
          enabled: true,
          gain: hapticIntensityRef.current,
        }
      );
      if (played) {
        rememberHapticFrameSeq(hapticFrameSeq);
      }
    };

    const kind = packetBytes[0];
    const payload = packetBytes.subarray(1);
    if (kind === WS_BINARY_VIDEO) {
      handleVideoFrameBytes(payload);
      return;
    }
    if (kind === WS_BINARY_VIDEO_ENCODED) {
      handleEncodedVideoSampleBytes(payload);
      return;
    }
    if (kind === WS_BINARY_AUDIO) {
      handleAudioFrameBytes(payload);
      return;
    }
    if (kind === WS_BINARY_HAPTIC) {
      handleHapticFrameBytes(payload);
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

          audioPlaybackEnabledRef.current = true;
          if (audioAvailableRef.current) {
            void ensureAudioContext(true);
          }
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

  const getButtonValue = (inputSource: ControllerInputSource, index: number) => {
    const btn = inputSource.buttons[index];
    if (!btn) {
      return 0;
    }
    const raw = typeof btn.value === "number" ? btn.value : btn.pressed ? 1 : 0;
    return Math.max(0, Math.min(1, raw));
  };

  const isButtonPressed = (inputSource: ControllerInputSource, index: number, threshold = 0.5) => {
    const btn = inputSource.buttons[index];
    if (!btn) {
      return false;
    }
    return !!btn.pressed || getButtonValue(inputSource, index) >= threshold;
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
      if (
        hasControllerDebugActivity(state) ||
        controlSendCountRef.current < 10 ||
        now - lastControllerDebugLogAtRef.current >= CONTROLLER_DEBUG_LOG_INTERVAL_MS
      ) {
        console.log("[stream-controller] renderer ipc send", formatControllerDebugState(state));
        lastControllerDebugLogAtRef.current = now;
      }
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

    const connectedGamepads = Array.from(gamepads).filter((gamepad): gamepad is Gamepad => {
      return !!gamepad && gamepad.connected;
    });
    if (useWebGamepadKernel) {
      syncDualSenseHidGamepads(connectedGamepads);
    }

    const dualSenseHidInputStates = useWebGamepadKernel ? getDualSenseHidInputStates() : [];
    const webGamepadCandidates = connectedGamepads.filter((gamepad) => {
      return !useWebGamepadKernel || !isDualSenseHidManagedGamepad(gamepad);
    });
    const configuredGamepadIndex = useWebGamepadKernel
      ? Number(settings?.gamepad_index)
      : -1;
    const shouldMixGamepads = useWebGamepadKernel && !!settings?.gamepad_mix;
    let selectedGamepads = webGamepadCandidates;

    if (!shouldMixGamepads) {
      if (Number.isInteger(configuredGamepadIndex) && configuredGamepadIndex >= 0) {
        const specifiedGamepad = webGamepadCandidates.find(
          (gamepad) => gamepad.index === configuredGamepadIndex
        );
        selectedGamepads = specifiedGamepad ? [specifiedGamepad] : [];
      }

      if (selectedGamepads.length < 1 && webGamepadCandidates.length > 0) {
        selectedGamepads = [webGamepadCandidates[0]];
      }
    }

    const activeGamepads = selectedGamepads.filter((gamepad) => {
      return Array.isArray(gamepad.axes) && gamepad.axes.length === 4;
    });
    const activeDualSenseInputs =
      useWebGamepadKernel && (shouldMixGamepads || activeGamepads.length < 1)
        ? shouldMixGamepads
          ? dualSenseHidInputStates
          : dualSenseHidInputStates.slice(0, 1)
        : [];

    validCount = activeGamepads.length + activeDualSenseInputs.length;
    let dualSenseTouchState = createIdleTouchState();

    const applyControllerInputSource = (
      inputSource: ControllerInputSource,
      currentDualSenseTouchState: StreamTouchState | null
    ) => {
      if (
        !hasActiveDualSenseTouchState(dualSenseTouchState) &&
        hasActiveDualSenseTouchState(currentDualSenseTouchState)
      ) {
        dualSenseTouchState = currentDualSenseTouchState!;
      }

      const getMappedButtonIndex = (action: GamepadMappingAction) => {
        return gamepadMappingRef.current[action];
      };

      if (isButtonPressed(inputSource, getMappedButtonIndex("A"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.CROSS;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("B"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.MOON;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("X"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.BOX;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("Y"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.PYRAMID;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("LeftShoulder"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.L1;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("RightShoulder"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.R1;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("View"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.SHARE;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("Menu"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.OPTIONS;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("LeftThumb"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.L3;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("RightThumb"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.R3;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("DPadUp"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_UP;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("DPadDown"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_DOWN;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("DPadLeft"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_LEFT;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("DPadRight"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.DPAD_RIGHT;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("Nexus"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.PS;
      }
      if (isButtonPressed(inputSource, getMappedButtonIndex("Touchpad"))) {
        mergedState.buttons |= CONTROLLER_BUTTONS.TOUCHPAD;
      }

      const l2Value = normalizeTriggerValue(
        getButtonValue(inputSource, getMappedButtonIndex("LeftTrigger"))
      );
      const r2Value = normalizeTriggerValue(
        getButtonValue(inputSource, getMappedButtonIndex("RightTrigger"))
      );
      mergedState.l2State = Math.max(mergedState.l2State, Math.round(l2Value * 255));
      mergedState.r2State = Math.max(mergedState.r2State, Math.round(r2Value * 255));
      if (mergedState.l2State > 0) mergedState.buttons |= CONTROLLER_ANALOG_BUTTONS.L2;
      if (mergedState.r2State > 0) mergedState.buttons |= CONTROLLER_ANALOG_BUTTONS.R2;

      const leftX = normalizeAxis(Number(inputSource.axes[0]) || 0);
      const leftY = normalizeAxis(Number(inputSource.axes[1]) || 0);
      const rightX = normalizeAxis(Number(inputSource.axes[2]) || 0);
      const rightY = normalizeAxis(Number(inputSource.axes[3]) || 0);

      if (Math.abs(leftX) > Math.abs(leftXNorm)) leftXNorm = leftX;
      if (Math.abs(leftY) > Math.abs(leftYNorm)) leftYNorm = leftY;
      if (Math.abs(rightX) > Math.abs(rightXNorm)) rightXNorm = rightX;
      if (Math.abs(rightY) > Math.abs(rightYNorm)) rightYNorm = rightY;
    };

    for (const dualSenseInputState of activeDualSenseInputs) {
      applyControllerInputSource(dualSenseInputState, dualSenseInputState.touchState);
    }

    for (const gamepad of activeGamepads) {
      applyControllerInputSource(gamepad, null);
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
    const activeTouchState = hasActiveDualSenseTouchState(touchpadStateRef.current)
      ? touchpadStateRef.current
      : dualSenseTouchState;
    mergedState.touchIdNext = activeTouchState.touchIdNext;
    mergedState.touches = [
      cloneTouchPoint(activeTouchState.touches[0]),
      cloneTouchPoint(activeTouchState.touches[1]),
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
    flushRenderedDecodedVideoFrameRetireQueue(false);
    const renderNowUs = performance.now() * 1000;
    updateDecodedVideoFrameDisplayIntervalEstimate(renderNowUs);

    let decodedVideoFrame: VideoFrame | null = null;
    const decodedFrameQueue = decodedVideoFrameQueueRef.current;
    if (decodedFrameQueue.length > 0) {
      if (!shouldUseTimestampDrivenWebCodecsRender()) {
        while (decodedFrameQueue.length > 1) {
          const staleFrame = decodedFrameQueue.shift();
          if (!staleFrame) {
            break;
          }
          droppedFramesRef.current += 1;
          ackRenderedNativeVideoFrame();
          closeDecodedVideoFrame(staleFrame);
        }
        decodedVideoFrame = decodedFrameQueue.shift() || null;
      } else {
        const renderQueueLimit = getWebCodecsRenderQueueLimit();
        while (decodedFrameQueue.length > renderQueueLimit) {
          const overflowFrame = decodedFrameQueue.shift();
          if (!overflowFrame) {
            break;
          }
          droppedFramesRef.current += 1;
          ackRenderedNativeVideoFrame();
          closeDecodedVideoFrame(overflowFrame);
        }

        if (
          decodedVideoFrameClockPrimedRef.current &&
          !decodedVideoFrameRebufferingRef.current &&
          decodedFrameQueue.length <= getSteamOsWebCodecsRebufferLowFrames()
        ) {
          increaseSteamOsDynamicRebufferProtection();
          pauseDecodedVideoFrameClockForRebuffer();
        }

        if (decodedVideoFrameRebufferingRef.current) {
          const resumeFrames = Math.max(
            getSteamOsWebCodecsRebufferResumeFrames(),
            getSteamOsEffectiveWebCodecsClockDelayFrames()
          );
          if (decodedFrameQueue.length >= resumeFrames) {
            syncDecodedVideoFrameClockToHead(resumeFrames);
            decodedVideoFrameRebufferingRef.current = false;
          } else {
            decodedVideoFrame = null;
          }
        }

        if (!decodedVideoFrameClockPrimedRef.current && !decodedVideoFrameRebufferingRef.current) {
          const startupFrames = getSteamOsEffectiveWebCodecsClockDelayFrames();
          if (decodedFrameQueue.length >= startupFrames) {
            syncDecodedVideoFrameClockToHead(startupFrames);
          }
        }

        if (!decodedVideoFrameClockPrimedRef.current || decodedVideoFrameRebufferingRef.current) {
          // Keep buffering before first present to smooth frame pacing on SteamOS.
          decodedVideoFrame = null;
        } else {
          const frameIntervalUs = Math.max(1, Math.round(1000000 / Math.max(1, fpsRef.current)));
          const pacingIntervalUs = getDecodedVideoFramePacingIntervalUs(frameIntervalUs);
          trimDecodedVideoFramesForSteadyPacing();

          let nextRenderDueUs = decodedVideoFrameClockWallStartUsRef.current;
          if (nextRenderDueUs < 1) {
            nextRenderDueUs = renderNowUs;
          }
          if (renderNowUs - nextRenderDueUs > pacingIntervalUs * 2) {
            nextRenderDueUs = renderNowUs;
          }

          const renderSlackUs = Math.max(1_000, Math.round(pacingIntervalUs * 0.15));
          if (renderNowUs + renderSlackUs >= nextRenderDueUs) {
            decodedVideoFrame = decodedFrameQueue.shift() || null;
            if (decodedVideoFrame) {
              const renderAtUs = Math.max(renderNowUs, nextRenderDueUs);
              decodedVideoFrameClockMediaStartUsRef.current = renderAtUs;
              decodedVideoFrameClockWallStartUsRef.current = renderAtUs + pacingIntervalUs;
            }
          } else {
            decodedVideoFrameClockWallStartUsRef.current = nextRenderDueUs;
          }
        }
      }
    }
    if (
      shouldUseTimestampDrivenWebCodecsRender() &&
      decodedFrameQueue.length < 1 &&
      !decodedVideoFrame &&
      decodedVideoFrameClockPrimedRef.current
    ) {
      pauseDecodedVideoFrameClockForRebuffer();
    }

    if (decodedVideoFrame) {
      try {
        const canvas = canvasRef.current;
        if (!canvas) {
          throw new Error("Video canvas is not available.");
        }

        let ctx = ctxRef.current;
        if (!ctx) {
          ctx = canvas.getContext("2d", { alpha: false, desynchronized: false });
          if (!ctx) {
            throw new Error("Failed to acquire a 2D video context.");
          }
          // Force full-surface replace to avoid partial dirty-region artifacts on Linux compositors.
          ctx.globalCompositeOperation = "copy";
          ctx.imageSmoothingEnabled = false;
          ctxRef.current = ctx;
        }

        ctx.drawImage(decodedVideoFrame, 0, 0, canvas.width, canvas.height);

        if (fsrEnabledRef.current) {
          drawFsrFrame();
        }
        renderedFramesRef.current += 1;
        relaxSteamOsDynamicRebufferProtectionAfterRender();

        if (!videoReadyRef.current) {
          videoReadyRef.current = true;
          setVideoReady(true);
          showConnectedToastThenEnableAudio();
        }

        ackRenderedNativeVideoFrame();
      } catch (error) {
        recoverWebCodecsDecoder(getErrorMessage(error, "Failed to render the decoded video frame."));
        ackRenderedNativeVideoFrame();
        openSessionAlert(
          [
            "Linux native video rendering failed.",
            getErrorMessage(error, "Failed to render the decoded video frame."),
          ].join("\n"),
          t("HdrRendererErrorStatus")
        );
      } finally {
        retireRenderedDecodedVideoFrame(decodedVideoFrame);
      }
    }

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

    if (
      (latestFrameRef.current || decodedVideoFrameQueueRef.current.length > 0) &&
      !renderLoopScheduledRef.current
    ) {
      renderLoopScheduledRef.current = true;
      rafRef.current = requestAnimationFrame(renderLoop);
    }
  };

  useEffect(() => {
    let active = true;

    const start = async () => {
      let rawStreamListener: any = null;
      let streamProgressListener: any = null;
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
        fsrGpuRenderingDisabledRef.current = false;
        fsrFrameRenderedRef.current = false;
        nativeBinaryTransportRef.current = false;
        nativeVideoFrameRenderedAckPendingQueueRef.current = [];
        webCodecsCapabilitiesRef.current = null;
        videoTransportRef.current = "ffmpeg-rawvideo";
        videoInputFormatRef.current = "hevc";
        destroyWebCodecsVideoDecoder();
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
        setDisconnectAndStandbyOnExit(false);
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

        const apName = String(pendingConfig?.consoleInfo?.apName || "");
        setIsPs5Console(apName ? apName.toUpperCase().includes("PS5") : true);

        setStatus(t("Connecting..."));
        setConnectState("starting");
        streamProgressListener = Ipc.onRaw?.("stream-progress", (_event, message) => {
          if (!active || message?.type !== "remote_progress") {
            return;
          }
          setConnectState("starting");
          setStatus(formatProgressStatus(t, message.stage, message.progress));
        });
        const currentLoginInfo = await Ipc.send("app", "getCachedPsnLoginInfo").catch(
          () => null
        );
        const requestedCodecFamily = resolveRequestedStreamCodecFamily(
          settings as Record<string, any>,
          !!pendingConfig?.isRemote
        );
        const clientVideoCapabilities = await detectClientVideoCapabilities(requestedCodecFamily);
        console.log('clientVideoCapabilities:', clientVideoCapabilities)
        const negotiatedStreamCodec = resolveNegotiatedStreamCodec(
          requestedCodecFamily,
          clientVideoCapabilities
        );
        if (negotiatedStreamCodec) {
          videoInputFormatRef.current = negotiatedStreamCodec === "H264" ? "h264" : "hevc";
        }
        webCodecsCapabilitiesRef.current = clientVideoCapabilities;
        const serverInfo: any = await Ipc.send("app", "startStreamSession", {
          streamHost,
          isRemote: !!pendingConfig?.isRemote,
          autoRemote: !!pendingConfig?.autoRemote,
          consoleInfo: pendingConfig?.consoleInfo || {},
          loginInfo: currentLoginInfo || undefined,
          sessionType: "webcodec",
          clientVideoCapabilities,
          steamOsWebCodecsProfile: steamOsRuntime ? steamOsWebCodecsProfile : undefined,
          ...(negotiatedStreamCodec
            ? {
                videoProfile: {
                  codec: negotiatedStreamCodec,
                },
              }
            : {}),
        });
        if (!active) {
          if (streamProgressListener) {
            Ipc.removeListener("stream-progress", streamProgressListener);
          }
          return;
        }

        const prefersNativeBinary = serverInfo?.binaryTransport === "electron-ipc";
        nativeBinaryTransportRef.current = false;
        controlTransportReadyRef.current = true;

        const url = `ws://${serverInfo.host}:${serverInfo.port}${serverInfo.path}`;
        wsUrlRef.current = url;
        setStatus(t("Connecting..."));

        rawStreamListener = Ipc.onRaw?.("stream-binary", (_event, message) => {
          if (!active || !prefersNativeBinary) {
            return;
          }

          const packet = resolveRawBinaryMessageToPacket(message);
          if (!packet || packet.byteLength < 2) {
            return;
          }

          nativeBinaryTransportRef.current = true;
          handleBinaryPacket(packet);
        });

        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;

        socket.onopen = () => {
          if (!active) return;
          lastControlStateKeyRef.current = "";
          lastSentControllerStateRef.current = createIdleControllerState();
          lastControllerSendAtRef.current = 0;
          hapticSuppressedFrameSeqRef.current.clear();
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
                const hapticFrameSeq = Number(
                  (sessionEvent as { hapticFrameSeq?: unknown })?.hapticFrameSeq
                );

                if (eventName === "rumble") {
                  const rumbleSource = String(
                    (sessionEvent as { source?: unknown })?.source || ""
                  );
                  if (
                    rumbleSource === "haptic_audio" &&
                    controllerInputKernelRef.current === "web" &&
                    canUseDualSenseGamepadHaptics({ enabled: hapticEnabledRef.current })
                  ) {
                    // DS5 haptics path is active, so ignore the motor fallback
                    // derived from the same PCM frame.
                  } else if (
                    Number.isFinite(hapticFrameSeq) &&
                    hapticSuppressedFrameSeqRef.current.delete(Math.trunc(hapticFrameSeq))
                  ) {
                    // Haptic frame already sent through DS5 HID path.
                  } else if (controllerInputKernelRef.current === "node") {
                    void triggerNativeGamepadRumbleFromPeasyo(sessionEvent, {
                      enabled: rumbleEnabledRef.current,
                      intensity: rumbleIntensityRef.current,
                    });
                  } else {
                    triggerGamepadRumbleFromPeasyo(sessionEvent, {
                      enabled: rumbleEnabledRef.current,
                      intensity: rumbleIntensityRef.current,
                    });
                  }
                } else if (eventName === "haptic_audio") {
                  if (controllerInputKernelRef.current === "web" && hapticEnabledRef.current) {
                    const played = triggerGamepadHapticsFromPeasyo(sessionEvent, {
                      enabled: true,
                      gain: hapticIntensityRef.current,
                    });
                    if (played && Number.isFinite(hapticFrameSeq)) {
                      hapticSuppressedFrameSeqRef.current.add(Math.trunc(hapticFrameSeq));
                      if (hapticSuppressedFrameSeqRef.current.size > 128) {
                        const first = hapticSuppressedFrameSeqRef.current.values().next().value;
                        if (first !== undefined) {
                          hapticSuppressedFrameSeqRef.current.delete(first);
                        }
                      }
                    }
                  }
                } else if (eventName === "trigger_effects") {
                  handleGamepadTriggerEffectsFromPeasyo(sessionEvent);
                } else if (eventName === "led_color") {
                  handleGamepadLedColorFromPeasyo(sessionEvent);
                } else if (eventName === "connected") {
                  sessionConnectedRef.current = true;
                  setConnectState("connected");
                  setStatus(t("Connected"));
                  showConnectedToastThenEnableAudio();
                } else if (eventName === "holepunch" && sessionEvent?.finished) {
                  setConnectState("starting");
                  setStatus(formatProgressStatus(t, "holepunchDataEstablished", 100));
                } else if (!NON_ERROR_SESSION_EVENT_NAMES.has(eventName)) {
                  openSessionAlert(
                    buildSessionEventErrorMessage(sessionEvent, t),
                    `session: ${eventName}`
                  );
                } else if (typeof eventName === "string") {
                  updateSessionActivityStatus();
                }
              } else if (msg?.type === "remote_progress") {
                setConnectState("starting");
                setStatus(formatProgressStatus(t, msg.stage, msg.progress));
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
          if (streamProgressListener) {
            Ipc.removeListener("stream-progress", streamProgressListener);
          }
        };
      } catch (error: any) {
        if (rawStreamListener) {
          Ipc.removeListener("stream-binary", rawStreamListener);
        }
        if (streamProgressListener) {
          Ipc.removeListener("stream-progress", streamProgressListener);
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
      nativeVideoFrameRenderedAckPendingQueueRef.current = [];
      webCodecsCapabilitiesRef.current = null;
      videoTransportRef.current = "ffmpeg-rawvideo";
      videoInputFormatRef.current = "hevc";
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
      sessionErrorHandledRef.current = false;
      latestFrameRef.current = null;
      clearDecodedVideoFrameQueue(false);
      destroyWebCodecsVideoDecoder();
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
    setShowPerformance(false);
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

// Constants and types specific to webStream.tsx (WebCodecs compressed video path)

import {
  PENDING_STREAM_STORAGE_KEY,
  WS_BINARY_VIDEO,
  WS_BINARY_AUDIO,
  WS_BINARY_HAPTIC,
  HAPTIC_PACKET_HEADER_BYTES,
  MAX_PENDING_AUDIO_BYTES,
  AUDIO_CONTEXT_LATENCY_SEC,
  AUDIO_SCHEDULE_LEAD_SEC,
  AUDIO_START_BUFFER_SEC,
  AUDIO_MAX_BUFFER_SEC,
  SHORT_PS_PRESS_MS,
  LONG_PS_PRESS_MS,
  MIN_CONTROLLER_POLLING_RATE,
  MAX_CONTROLLER_POLLING_RATE,
  MAX_CONTROLLER_SEND_RATE,
  MAX_CONTROLLER_TOUCH_ID,
  TOUCHPAD_BUTTON_TAP_MS,
  TOUCHPAD_SCALE_MIN,
  TOUCHPAD_SCALE_MAX,
  TOUCHPAD_OPACITY_MIN,
  TOUCHPAD_OPACITY_MAX,
  TOUCHPAD_OPACITY_DEFAULT,
  GAMEPAD_AXIS_QUANTIZATION,
  GAMEPAD_TRIGGER_QUANTIZATION,
  GAMEPAD_TRIGGER_DEADZONE,
  BRIGHTNESS_MIN,
  BRIGHTNESS_MAX,
  BRIGHTNESS_DEFAULT,
  FSR_SHARPNESS_MIN,
  FSR_SHARPNESS_MAX,
  FSR_SHARPNESS_STEP,
  CONTROLLER_DEBUG_LOG_INTERVAL_MS,
} from "./streamConstants";

// Re-export shared constants for convenience (single import for consumers)
export {
  PENDING_STREAM_STORAGE_KEY,
  WS_BINARY_VIDEO,
  WS_BINARY_AUDIO,
  WS_BINARY_HAPTIC,
  HAPTIC_PACKET_HEADER_BYTES,
  MAX_PENDING_AUDIO_BYTES,
  AUDIO_CONTEXT_LATENCY_SEC,
  AUDIO_SCHEDULE_LEAD_SEC,
  AUDIO_START_BUFFER_SEC,
  AUDIO_MAX_BUFFER_SEC,
  SHORT_PS_PRESS_MS,
  LONG_PS_PRESS_MS,
  MIN_CONTROLLER_POLLING_RATE,
  MAX_CONTROLLER_POLLING_RATE,
  MAX_CONTROLLER_SEND_RATE,
  MAX_CONTROLLER_TOUCH_ID,
  TOUCHPAD_BUTTON_TAP_MS,
  TOUCHPAD_SCALE_MIN,
  TOUCHPAD_SCALE_MAX,
  TOUCHPAD_OPACITY_MIN,
  TOUCHPAD_OPACITY_MAX,
  TOUCHPAD_OPACITY_DEFAULT,
  GAMEPAD_AXIS_QUANTIZATION,
  GAMEPAD_TRIGGER_QUANTIZATION,
  GAMEPAD_TRIGGER_DEADZONE,
  BRIGHTNESS_MIN,
  BRIGHTNESS_MAX,
  BRIGHTNESS_DEFAULT,
  FSR_SHARPNESS_MIN,
  FSR_SHARPNESS_MAX,
  FSR_SHARPNESS_STEP,
  CONTROLLER_DEBUG_LOG_INTERVAL_MS,
};

// WebCodecs-specific binary message type
export const WS_BINARY_VIDEO_ENCODED = 3;

// Encoded video sample packet header size (bytes)
export const ENCODED_VIDEO_SAMPLE_PACKET_HEADER_BYTES = 5;

// Display refresh interval default (microseconds, ~60 Hz)
export const DISPLAY_REFRESH_INTERVAL_DEFAULT_US = Math.round(1000000 / 60);

// Pending native packet queue limit
export const MAX_PENDING_NATIVE_PACKETS = 64;

// Watchdog for receiving the first video frame (milliseconds)
export const FIRST_FRAME_WATCHDOG_MS = 8000;

// WebCodecs H.264 codec fallback (used on SteamOS when no supported codec is detected)
export const WEBCODECS_H264_CODEC_FALLBACK = "avc1.42E01E";

// H.264 codec candidates (ordered by preference, high to low profile)
export const WEBCODECS_H264_CODEC_CANDIDATES = [
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

// HEVC codec candidates (ordered by preference)
export const WEBCODECS_HEVC_CODEC_CANDIDATES = [
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

// WebCodecs queue limits
export const MAX_WEBCODECS_DECODE_QUEUE_SIZE = 24;
export const MAX_WEBCODECS_RENDER_QUEUE_DEFAULT = 1;

// --- SteamOS WebCodecs tuning profiles ---

export type SteamOsWebCodecsProfile = "balanced" | "stable" | "ultra-stable";

export type SteamOsWebCodecsTuning = {
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

export const STEAMOS_WEBCODECS_PROFILE_DEFAULT: SteamOsWebCodecsProfile = "stable";

export const STEAMOS_WEBCODECS_PROFILE_TUNING: Record<SteamOsWebCodecsProfile, SteamOsWebCodecsTuning> = {
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

// --- WebCodecs-specific types ---

export type StreamCodecFamily = "h264" | "hevc";
export type StreamVideoTransportMode = "ffmpeg-rawvideo" | "compressed-webcodecs";

export type ClientVideoCapabilities = {
  webCodecs: boolean;
  preferCompressedVideo: boolean;
  h264: boolean;
  hevc: boolean;
  isSteamOs?: boolean;
  h264Codec?: string;
  hevcCodec?: string;
};

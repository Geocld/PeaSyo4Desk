// Shared stream constants used by both stream.tsx and webStream.tsx

export const PENDING_STREAM_STORAGE_KEY = "pending-stream-config";

// WebSocket binary message type IDs
export const WS_BINARY_VIDEO = 1;
export const WS_BINARY_AUDIO = 2;
export const WS_BINARY_HAPTIC = 4;

// Packet header sizes (bytes)
export const HAPTIC_PACKET_HEADER_BYTES = 4;

// Audio buffer limits
export const MAX_PENDING_AUDIO_BYTES = 4 * 1024 * 1024;

// Audio timing (seconds)
export const AUDIO_CONTEXT_LATENCY_SEC = 0.02;
export const AUDIO_SCHEDULE_LEAD_SEC = 0.01;
export const AUDIO_START_BUFFER_SEC = 0.06;
export const AUDIO_MAX_BUFFER_SEC = 0.18;

// PS button press durations (milliseconds)
export const SHORT_PS_PRESS_MS = 150;
export const LONG_PS_PRESS_MS = 1000;

// Controller polling rates (Hz)
export const MIN_CONTROLLER_POLLING_RATE = 30;
export const MAX_CONTROLLER_POLLING_RATE = 1000;
export const MAX_CONTROLLER_SEND_RATE = 120;

// Controller touch input
export const MAX_CONTROLLER_TOUCH_ID = 127;
export const TOUCHPAD_BUTTON_TAP_MS = 90;

// Touchpad display
export const TOUCHPAD_SCALE_MIN = 0.5;
export const TOUCHPAD_SCALE_MAX = 2;
export const TOUCHPAD_OPACITY_MIN = 0;
export const TOUCHPAD_OPACITY_MAX = 0.8;
export const TOUCHPAD_OPACITY_DEFAULT = 0.6;
export const PERFORMANCE_OPACITY_MIN = 0.1;
export const PERFORMANCE_OPACITY_MAX = 0.8;
export const PERFORMANCE_OPACITY_DEFAULT = 0.8;

// Gamepad axis/trigger quantization
export const GAMEPAD_AXIS_QUANTIZATION = 128;
export const GAMEPAD_TRIGGER_QUANTIZATION = 64;
export const GAMEPAD_TRIGGER_DEADZONE = 0.02;

// Brightness
export const BRIGHTNESS_MIN = 50;
export const BRIGHTNESS_MAX = 150;
export const BRIGHTNESS_DEFAULT = 100;

// FSR sharpness
export const FSR_SHARPNESS_MIN = 0;
export const FSR_SHARPNESS_MAX = 2;
export const FSR_SHARPNESS_STEP = 0.05;

// Controller debug logging interval (milliseconds)
export const CONTROLLER_DEBUG_LOG_INTERVAL_MS = 1000;

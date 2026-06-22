// Shared stream enums, bitmasks, and action mappings used by both stream.tsx and webStream.tsx
//
// These values come from the PS Remote Play binary protocol:
//   - CONTROLLER_BUTTONS: bitmask positions for digital buttons (sent as a 16-bit field)
//   - CONTROLLER_ANALOG_BUTTONS: bitmask positions for analog triggers (upper 2 bits)
//   - KEYBOARD_BUTTON_ACTION_MASKS: maps keyboard-friendly action names to their bitmask values

export const GAMEPAD_DEADZONE = 0.12;

export const CONTROLLER_BUTTONS = {
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

export const CONTROLLER_ANALOG_BUTTONS = {
  L2: 1 << 16,
  R2: 1 << 17,
};

export const KEYBOARD_BUTTON_ACTION_MASKS = {
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

// DOM tags considered editable for keyboard interception
export const KEYBOARD_INPUT_TAGS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"]);

// Legacy keyboard mapping keys from pre-mapping era
export const LEGACY_TOUCHPAD_KEY = "t";
export const LEGACY_RIGHT_STICK_UP_KEY = "r";

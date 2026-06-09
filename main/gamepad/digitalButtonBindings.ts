export const NATIVE_DIGITAL_BUTTON_NAMES = [
  "dpadLeft",
  "dpadRight",
  "dpadUp",
  "dpadDown",
  "a",
  "b",
  "x",
  "y",
  "guide",
  "back",
  "start",
  "leftStick",
  "rightStick",
  "leftShoulder",
  "rightShoulder",
  "touchpad",
  "paddle1",
  "paddle2",
  "paddle3",
  "paddle4",
] as const;

export type NativeDigitalButtonName = (typeof NATIVE_DIGITAL_BUTTON_NAMES)[number];

export type NativeDigitalButtonBinding =
  | { kind: "unknown" }
  | { kind: "button"; buttonIndex: number }
  | { kind: "hat"; hatIndex: number; hatMask: number }
  | {
      kind: "axis";
      axisIndex: number;
      range: "full-axis" | "half-axis";
      direction: 1 | -1;
    };

const AXIS_PRESS_THRESHOLD = 0.5;

const DIGITAL_BUTTON_MAPPING_KEYS: Record<NativeDigitalButtonName, string[]> = {
  dpadLeft: ["dpleft", "dpadleft"],
  dpadRight: ["dpright", "dpadright"],
  dpadUp: ["dpup", "dpadup"],
  dpadDown: ["dpdown", "dpaddown"],
  a: ["a"],
  b: ["b"],
  x: ["x"],
  y: ["y"],
  guide: ["guide"],
  back: ["back"],
  start: ["start"],
  leftStick: ["leftstick"],
  rightStick: ["rightstick"],
  leftShoulder: ["leftshoulder"],
  rightShoulder: ["rightshoulder"],
  touchpad: ["touchpad", "misc1"],
  paddle1: ["paddle1"],
  paddle2: ["paddle2"],
  paddle3: ["paddle3"],
  paddle4: ["paddle4"],
};

const normalizeAxisUnit = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  if (numeric >= -1 && numeric <= 1) {
    return numeric;
  }

  if (numeric >= -32768 && numeric <= 32767) {
    if (numeric < 0) {
      return numeric / 32768;
    }
    return numeric / 32767;
  }

  if (numeric < 0) {
    return -1;
  }
  return 1;
};

const normalizeHatMask = (value: unknown) => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "centered") {
    return 0;
  }

  let mask = 0;
  if (normalized.includes("up")) {
    mask |= 1;
  }
  if (normalized.includes("right")) {
    mask |= 2;
  }
  if (normalized.includes("down")) {
    mask |= 4;
  }
  if (normalized.includes("left")) {
    mask |= 8;
  }
  return mask;
};

export const parseDigitalButtonBinding = (
  mapping: unknown,
  buttonName: NativeDigitalButtonName
): NativeDigitalButtonBinding => {
  if (typeof mapping !== "string" || !mapping.trim()) {
    return { kind: "unknown" };
  }

  const acceptedKeys = DIGITAL_BUTTON_MAPPING_KEYS[buttonName];
  const entries = mapping.split(",");
  for (const entry of entries) {
    const separatorIndex = entry.indexOf(":");
    if (separatorIndex < 1) {
      continue;
    }

    const key = entry.slice(0, separatorIndex).trim().toLowerCase();
    if (!acceptedKeys.includes(key)) {
      continue;
    }

    const token = entry
      .slice(separatorIndex + 1)
      .trim()
      .toLowerCase();
    if (!token) {
      return { kind: "unknown" };
    }

    const buttonMatch = token.match(/^b(\d+)$/);
    if (buttonMatch) {
      return {
        kind: "button",
        buttonIndex: Number(buttonMatch[1]),
      };
    }

    const hatMatch = token.match(/^h(\d+)\.(\d+)$/);
    if (hatMatch) {
      return {
        kind: "hat",
        hatIndex: Number(hatMatch[1]),
        hatMask: Number(hatMatch[2]),
      };
    }

    const axisMatch = token.match(/^([+-]?)[aA](\d+)(~?)$/);
    if (axisMatch) {
      const signToken = axisMatch[1];
      const axisIndex = Number(axisMatch[2]);
      const inverted = axisMatch[3] === "~";
      const baseDirection = signToken === "-" ? -1 : 1;
      return {
        kind: "axis",
        axisIndex,
        range: signToken ? "half-axis" : "full-axis",
        direction: (baseDirection * (inverted ? -1 : 1)) as 1 | -1,
      };
    }

    return { kind: "unknown" };
  }

  return { kind: "unknown" };
};

export const readDigitalButtonPressedFromJoystickBinding = (
  binding: NativeDigitalButtonBinding,
  joystick: any
) => {
  if (!joystick || binding.kind === "unknown") {
    return null;
  }

  if (binding.kind === "button") {
    const buttons = Array.isArray(joystick?.buttons) ? joystick.buttons : [];
    return !!buttons[binding.buttonIndex];
  }

  if (binding.kind === "hat") {
    const hats = Array.isArray(joystick?.hats) ? joystick.hats : [];
    const hatMask = normalizeHatMask(hats[binding.hatIndex]);
    return (hatMask & binding.hatMask) === binding.hatMask;
  }

  const axes = Array.isArray(joystick?.axes) ? joystick.axes : [];
  const axisValue = normalizeAxisUnit(axes[binding.axisIndex]);
  if (binding.range === "full-axis") {
    return Math.abs(axisValue) >= AXIS_PRESS_THRESHOLD;
  }

  return axisValue * binding.direction >= AXIS_PRESS_THRESHOLD;
};

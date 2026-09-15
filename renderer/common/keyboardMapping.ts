import { defaultSettings } from "../context/userContext.defaults";
import {
  LEGACY_RIGHT_STICK_UP_KEY,
  LEGACY_TOUCHPAD_KEY,
} from "./streamEnums";

export type KeyboardMapping = Record<string, string>;

export const DEFAULT_KEYBOARD_MAPPING =
  defaultSettings.input_mousekeyboard_maping as KeyboardMapping;

export const normalizeKeyboardMapping = (value: unknown): KeyboardMapping => {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_KEYBOARD_MAPPING };
  }

  const nextMapping: KeyboardMapping = {};
  const keysByAction = new Map<string, string>();
  for (const [key, action] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== "string" || typeof action !== "string") {
      continue;
    }

    const previousKey = keysByAction.get(action);
    if (previousKey) {
      delete nextMapping[previousKey];
    }

    nextMapping[key] = action;
    keysByAction.set(action, key);
  }

  if (Object.keys(nextMapping).length === 0) {
    return { ...DEFAULT_KEYBOARD_MAPPING };
  }

  // Migrate the old t=right-stick-up binding without restoring unrelated defaults.
  const rawTouchpadBinding = nextMapping[LEGACY_TOUCHPAD_KEY];
  const hasTouchpadBinding = Object.values(nextMapping).includes("Touchpad");
  const hasRightStickUpBindingOnOtherKey = Object.entries(nextMapping).some(
    ([key, action]) =>
      key !== LEGACY_TOUCHPAD_KEY && action === "RightThumbYAxisPlus"
  );

  if (
    !hasTouchpadBinding &&
    rawTouchpadBinding === "RightThumbYAxisPlus" &&
    !hasRightStickUpBindingOnOtherKey
  ) {
    nextMapping[LEGACY_RIGHT_STICK_UP_KEY] = "RightThumbYAxisPlus";
    nextMapping[LEGACY_TOUCHPAD_KEY] = "Touchpad";
  }

  return nextMapping;
};

export const invertKeyboardMapping = (mapping: KeyboardMapping) => {
  const result: KeyboardMapping = {};
  for (const [key, action] of Object.entries(mapping)) {
    result[action] = key;
  }
  return result;
};

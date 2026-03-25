export const GAMEPAD_MAPPING_ACTIONS = [
  "A",
  "B",
  "X",
  "Y",
  "DPadUp",
  "DPadDown",
  "DPadLeft",
  "DPadRight",
  "LeftShoulder",
  "RightShoulder",
  "LeftThumb",
  "RightThumb",
  "LeftTrigger",
  "RightTrigger",
  "Menu",
  "View",
  "Nexus",
  "Touchpad",
] as const;

export type GamepadMappingAction = (typeof GAMEPAD_MAPPING_ACTIONS)[number];

export type GamepadButtonMapping = Record<GamepadMappingAction, number>;

export const DEFAULT_GAMEPAD_BUTTON_MAPPING: GamepadButtonMapping = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  DPadUp: 12,
  DPadDown: 13,
  DPadLeft: 14,
  DPadRight: 15,
  LeftShoulder: 4,
  RightShoulder: 5,
  LeftThumb: 10,
  RightThumb: 11,
  LeftTrigger: 6,
  RightTrigger: 7,
  Menu: 9,
  View: 8,
  Nexus: 16,
  Touchpad: 17,
};

export const normalizeGamepadButtonMapping = (value: unknown): GamepadButtonMapping => {
  const nextMapping: GamepadButtonMapping = { ...DEFAULT_GAMEPAD_BUTTON_MAPPING };

  if (!value || typeof value !== "object") {
    return nextMapping;
  }

  const raw = value as Record<string, unknown>;
  for (const action of GAMEPAD_MAPPING_ACTIONS) {
    const nextValue = Number(raw[action]);
    if (Number.isFinite(nextValue)) {
      const normalizedValue = Math.trunc(nextValue);
      if (normalizedValue === -1 || normalizedValue >= 0) {
        nextMapping[action] = normalizedValue;
      }
    }
  }

  return nextMapping;
};

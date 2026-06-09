import {
  createTriggerNormalizerState,
  normalizeTriggerUnit,
  parseTriggerBinding,
  readTriggerUnitFromJoystickBinding,
  resetTriggerNormalizerState,
  type NativeTriggerBinding,
  type NativeTriggerAxisName,
  type TriggerNormalizerState,
} from "../gamepad/triggerNormalization";
import {
  parseDigitalButtonBinding,
  readDigitalButtonPressedFromJoystickBinding,
  type NativeDigitalButtonBinding,
} from "../gamepad/digitalButtonBindings";

declare const __non_webpack_require__: undefined | ((id: string) => any);
const runtimeRequire =
  typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__
    : // eslint-disable-next-line no-eval
      (0, eval)("require");

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
const TRIGGER_DEADZONE = 0.03;
const TRIGGER_DIGITAL_PRESS_STATE = 8;
const STARTUP_DEVICE_RESCAN_INTERVAL_MS = 250;
const STARTUP_DEVICE_RESCAN_WINDOW_MS = 5000;
const STATE_RECONCILE_INTERVAL_MS = 60;

type ControllerStateSnapshot = {
  buttons: number;
  l2State: number;
  r2State: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
};

type NodeGamepadDriverOptions = {
  onStateChange: (state: ControllerStateSnapshot) => void;
  onError?: (error: Error) => void;
  onLog?: (message: string) => void;
  buttonMapping?: unknown;
};

type MutableControllerState = ControllerStateSnapshot;
type DeviceTriggerNormalizers = Record<NativeTriggerAxisName, TriggerNormalizerState>;
type DeviceTriggerBindings = Record<NativeTriggerAxisName, NativeTriggerBinding>;
type DeviceDigitalButtonBindings = Record<DeviceDigitalButtonBindingName, NativeDigitalButtonBinding>;

type NodeGamepadDriverRumbleRequest = {
  low?: unknown;
  high?: unknown;
  durationMs?: unknown;
};

const createIdleState = (): MutableControllerState => ({
  buttons: 0,
  l2State: 0,
  r2State: 0,
  leftX: 0,
  leftY: 0,
  rightX: 0,
  rightY: 0,
});

const cloneState = (state: MutableControllerState): ControllerStateSnapshot => ({
  buttons: state.buttons,
  l2State: state.l2State,
  r2State: state.r2State,
  leftX: state.leftX,
  leftY: state.leftY,
  rightX: state.rightX,
  rightY: state.rightY,
});

const copyState = (target: MutableControllerState, source: MutableControllerState) => {
  target.buttons = source.buttons;
  target.l2State = source.l2State;
  target.r2State = source.r2State;
  target.leftX = source.leftX;
  target.leftY = source.leftY;
  target.rightX = source.rightX;
  target.rightY = source.rightY;
};

const isSameState = (left: MutableControllerState, right: MutableControllerState) => {
  return (
    left.buttons === right.buttons &&
    left.l2State === right.l2State &&
    left.r2State === right.r2State &&
    left.leftX === right.leftX &&
    left.leftY === right.leftY &&
    left.rightX === right.rightX &&
    left.rightY === right.rightY
  );
};

const toSignedAxisValue = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  const clamped = Math.max(-1, Math.min(1, numeric));
  if (clamped === -1) {
    return -32768;
  }
  return Math.trunc(clamped * 32767);
};

const toTriggerStateFromUnit = (value: number) => {
  const normalized = Math.max(0, Math.min(1, value));
  if (normalized <= TRIGGER_DEADZONE) {
    return 0;
  }

  return Math.max(0, Math.min(255, Math.round(normalized * 255)));
};

const toTriggerState = (value: unknown, normalizer: TriggerNormalizerState) => {
  const normalized = normalizeTriggerUnit(value, normalizer);
  return toTriggerStateFromUnit(normalized);
};

const isTriggerPressed = (value: unknown) => {
  if (typeof value === "boolean") {
    return value;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return false;
  }

  if (numeric <= 1) {
    return numeric > TRIGGER_DEADZONE;
  }

  return numeric >= TRIGGER_DIGITAL_PRESS_STATE;
};

const DIGITAL_BUTTON_BINDING_NAMES = [
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
] as const;

type DeviceDigitalButtonBindingName = (typeof DIGITAL_BUTTON_BINDING_NAMES)[number];

const GAMEPAD_MAPPING_ACTIONS = [
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

type GamepadMappingAction = (typeof GAMEPAD_MAPPING_ACTIONS)[number];

type GamepadButtonMapping = Record<GamepadMappingAction, number>;

type NativeButtonSource = {
  pressed: boolean;
  value: number;
};

const DEFAULT_GAMEPAD_BUTTON_MAPPING: GamepadButtonMapping = {
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

const GAMEPAD_MAPPING_ACTION_TO_MASK: Partial<Record<GamepadMappingAction, number>> = {
  A: CONTROLLER_BUTTONS.CROSS,
  B: CONTROLLER_BUTTONS.MOON,
  X: CONTROLLER_BUTTONS.BOX,
  Y: CONTROLLER_BUTTONS.PYRAMID,
  DPadUp: CONTROLLER_BUTTONS.DPAD_UP,
  DPadDown: CONTROLLER_BUTTONS.DPAD_DOWN,
  DPadLeft: CONTROLLER_BUTTONS.DPAD_LEFT,
  DPadRight: CONTROLLER_BUTTONS.DPAD_RIGHT,
  LeftShoulder: CONTROLLER_BUTTONS.L1,
  RightShoulder: CONTROLLER_BUTTONS.R1,
  LeftThumb: CONTROLLER_BUTTONS.L3,
  RightThumb: CONTROLLER_BUTTONS.R3,
  Menu: CONTROLLER_BUTTONS.OPTIONS,
  View: CONTROLLER_BUTTONS.SHARE,
  Nexus: CONTROLLER_BUTTONS.PS,
  Touchpad: CONTROLLER_BUTTONS.TOUCHPAD,
};

const normalizeGamepadButtonMapping = (value: unknown): GamepadButtonMapping => {
  const nextMapping: GamepadButtonMapping = { ...DEFAULT_GAMEPAD_BUTTON_MAPPING };

  if (value && typeof value === "object") {
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
  }

  const usedButtons = new Set<number>();
  for (const action of GAMEPAD_MAPPING_ACTIONS) {
    const buttonIndex = nextMapping[action];
    if (buttonIndex < 0) {
      continue;
    }

    if (usedButtons.has(buttonIndex)) {
      nextMapping[action] = -1;
      continue;
    }

    usedButtons.add(buttonIndex);
  }

  return nextMapping;
};

const DIGITAL_BUTTON_BINDING_TO_INDEX: Record<DeviceDigitalButtonBindingName, number> = {
  dpadLeft: 14,
  dpadRight: 15,
  dpadUp: 12,
  dpadDown: 13,
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  guide: 16,
  back: 8,
  start: 9,
  leftStick: 10,
  rightStick: 11,
  leftShoulder: 4,
  rightShoulder: 5,
  touchpad: 17,
};

const toButtonSourceValue = (value: unknown) => {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  if (numeric <= 1) {
    return numeric;
  }

  return Math.min(1, numeric / 255);
};

const setNativeButtonSource = (
  sources: Record<number, NativeButtonSource>,
  index: number,
  value: unknown
) => {
  const sourceValue = toButtonSourceValue(value);
  sources[index] = {
    pressed: sourceValue > 0,
    value: sourceValue,
  };
};

const setNativeTriggerButtonSource = (
  sources: Record<number, NativeButtonSource>,
  index: number,
  triggerState: number,
  buttonValue: unknown
) => {
  const triggerValue = Math.max(0, Math.min(1, triggerState / 255));
  const buttonSourceValue = isTriggerPressed(buttonValue) ? 1 : toButtonSourceValue(buttonValue);
  const sourceValue = Math.max(triggerValue, buttonSourceValue);
  sources[index] = {
    pressed: sourceValue > TRIGGER_DEADZONE,
    value: sourceValue,
  };
};

const getAxisValue = (axes: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    if (key in axes) {
      return axes[key];
    }
  }
  return 0;
};

const getButtonValue = (buttons: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    if (key in buttons) {
      return buttons[key];
    }
  }
  return false;
};

const buildNativeButtonSources = (
  buttons: Record<string, unknown>,
  l2State: number,
  r2State: number
) => {
  const sources: Record<number, NativeButtonSource> = {};

  setNativeButtonSource(sources, 0, getButtonValue(buttons, ["a", "cross", "0"]));
  setNativeButtonSource(sources, 1, getButtonValue(buttons, ["b", "circle", "1"]));
  setNativeButtonSource(sources, 2, getButtonValue(buttons, ["x", "square", "2"]));
  setNativeButtonSource(sources, 3, getButtonValue(buttons, ["y", "triangle", "3"]));
  setNativeButtonSource(sources, 4, getButtonValue(buttons, ["leftShoulder", "leftBumper", "l1", "4"]));
  setNativeButtonSource(sources, 5, getButtonValue(buttons, ["rightShoulder", "rightBumper", "r1", "5"]));
  setNativeTriggerButtonSource(
    sources,
    6,
    l2State,
    getButtonValue(buttons, ["leftTriggerButton", "leftTrigger", "6"])
  );
  setNativeTriggerButtonSource(
    sources,
    7,
    r2State,
    getButtonValue(buttons, ["rightTriggerButton", "rightTrigger", "7"])
  );
  setNativeButtonSource(sources, 8, getButtonValue(buttons, ["back", "share", "view", "8"]));
  setNativeButtonSource(sources, 9, getButtonValue(buttons, ["start", "menu", "options", "9"]));
  setNativeButtonSource(sources, 10, getButtonValue(buttons, ["leftStick", "leftThumb", "l3", "10"]));
  setNativeButtonSource(sources, 11, getButtonValue(buttons, ["rightStick", "rightThumb", "r3", "11"]));
  setNativeButtonSource(sources, 12, getButtonValue(buttons, ["dpadUp", "up", "12"]));
  setNativeButtonSource(sources, 13, getButtonValue(buttons, ["dpadDown", "down", "13"]));
  setNativeButtonSource(sources, 14, getButtonValue(buttons, ["dpadLeft", "left", "14"]));
  setNativeButtonSource(sources, 15, getButtonValue(buttons, ["dpadRight", "right", "15"]));
  setNativeButtonSource(sources, 16, getButtonValue(buttons, ["guide", "ps", "home", "16"]));
  setNativeButtonSource(sources, 17, getButtonValue(buttons, ["touchpad", "misc1", "17"]));

  return sources;
};

const resolveDeviceId = (device: any) => {
  const rawId = device?.id;
  if (rawId === null || rawId === undefined) {
    return "";
  }
  return String(rawId);
};

const clampUnit = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(1, numeric));
};

const clampDurationMs = (value: unknown) => {
  const numeric = Math.round(Number(value) || 0);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.max(0, Math.min(5000, numeric));
};

const getControllerMapping = (controller: any, device?: any) => {
  return controller?.device?.mapping ?? device?.mapping ?? null;
};

const createDeviceTriggerNormalizers = (mapping: unknown): DeviceTriggerNormalizers => ({
  leftTrigger: createTriggerNormalizerState(mapping, "leftTrigger"),
  rightTrigger: createTriggerNormalizerState(mapping, "rightTrigger"),
});

const createDeviceTriggerBindings = (mapping: unknown): DeviceTriggerBindings => ({
  leftTrigger: parseTriggerBinding(mapping, "leftTrigger"),
  rightTrigger: parseTriggerBinding(mapping, "rightTrigger"),
});

const createDeviceDigitalButtonBindings = (mapping: unknown): DeviceDigitalButtonBindings => ({
  dpadLeft: parseDigitalButtonBinding(mapping, "dpadLeft"),
  dpadRight: parseDigitalButtonBinding(mapping, "dpadRight"),
  dpadUp: parseDigitalButtonBinding(mapping, "dpadUp"),
  dpadDown: parseDigitalButtonBinding(mapping, "dpadDown"),
  a: parseDigitalButtonBinding(mapping, "a"),
  b: parseDigitalButtonBinding(mapping, "b"),
  x: parseDigitalButtonBinding(mapping, "x"),
  y: parseDigitalButtonBinding(mapping, "y"),
  guide: parseDigitalButtonBinding(mapping, "guide"),
  back: parseDigitalButtonBinding(mapping, "back"),
  start: parseDigitalButtonBinding(mapping, "start"),
  leftStick: parseDigitalButtonBinding(mapping, "leftStick"),
  rightStick: parseDigitalButtonBinding(mapping, "rightStick"),
  leftShoulder: parseDigitalButtonBinding(mapping, "leftShoulder"),
  rightShoulder: parseDigitalButtonBinding(mapping, "rightShoulder"),
  touchpad: parseDigitalButtonBinding(mapping, "touchpad"),
});

const resetDeviceTriggerNormalizers = (
  normalizers: DeviceTriggerNormalizers,
  mapping: unknown
) => {
  resetTriggerNormalizerState(normalizers.leftTrigger, mapping, "leftTrigger");
  resetTriggerNormalizerState(normalizers.rightTrigger, mapping, "rightTrigger");
};

const resetDeviceTriggerBindings = (
  bindings: DeviceTriggerBindings,
  mapping: unknown
) => {
  bindings.leftTrigger = parseTriggerBinding(mapping, "leftTrigger");
  bindings.rightTrigger = parseTriggerBinding(mapping, "rightTrigger");
};

const resetDeviceDigitalButtonBindings = (
  bindings: DeviceDigitalButtonBindings,
  mapping: unknown
) => {
  for (const buttonName of DIGITAL_BUTTON_BINDING_NAMES) {
    bindings[buttonName] = parseDigitalButtonBinding(mapping, buttonName);
  }
};

export const createNodeGamepadDriver = (options: NodeGamepadDriverOptions) => {
  const onStateChange = options.onStateChange;
  const onError = options.onError;
  const onLog = options.onLog;
  const userButtonMapping = normalizeGamepadButtonMapping(options.buttonMapping);

  let started = false;
  let sdl: any = null;
  const controllerInstances = new Map<string, any>();
  const joystickInstances = new Map<string, any>();
  const deviceStates = new Map<string, MutableControllerState>();
  const deviceTriggerNormalizers = new Map<string, DeviceTriggerNormalizers>();
  const deviceTriggerBindings = new Map<string, DeviceTriggerBindings>();
  const deviceDigitalButtonBindings = new Map<string, DeviceDigitalButtonBindings>();
  const lastEmittedState = createIdleState();
  const idleState = createIdleState();
  let hasLastEmittedState = false;
  let activeDeviceId: string | null = null;
  let startupRescanTimer: ReturnType<typeof setTimeout> | null = null;
  let startupRescanDeadline = 0;
  let stateReconcileTimer: ReturnType<typeof setInterval> | null = null;

  const findJoystickDevice = (deviceId: string) => {
    const devices = Array.isArray(sdl?.joystick?.devices) ? sdl.joystick.devices : [];
    return devices.find((device: any) => resolveDeviceId(device) === deviceId) ?? null;
  };

  const openJoystick = (deviceId: string) => {
    const joystickDevice = findJoystickDevice(deviceId);
    if (!joystickDevice || !sdl?.joystick?.openDevice) {
      return null;
    }

    try {
      return sdl.joystick.openDevice(joystickDevice);
    } catch (error: any) {
      onLog?.(
        `node-sdl joystick sidecar open failed: ${deviceId} (${error?.message || String(error)})`
      );
      return null;
    }
  };

  const resolveTriggerState = (
    controllerValue: unknown,
    joystick: any,
    binding: NativeTriggerBinding,
    normalizer: TriggerNormalizerState
  ) => {
    const joystickValue = readTriggerUnitFromJoystickBinding(binding, joystick);
    if (joystickValue !== null) {
      return toTriggerStateFromUnit(joystickValue);
    }

    return toTriggerState(controllerValue, normalizer);
  };

  const applyJoystickDigitalButtonSources = (
    sources: Record<number, NativeButtonSource>,
    joystick: any,
    digitalButtonBindings: DeviceDigitalButtonBindings
  ) => {
    if (!joystick) {
      return;
    }

    for (const buttonName of DIGITAL_BUTTON_BINDING_NAMES) {
      const pressed = readDigitalButtonPressedFromJoystickBinding(
        digitalButtonBindings[buttonName],
        joystick
      );
      if (pressed === null) {
        continue;
      }

      setNativeButtonSource(sources, DIGITAL_BUTTON_BINDING_TO_INDEX[buttonName], pressed);
    }
  };

  const applyUserButtonMapping = (
    state: MutableControllerState,
    sources: Record<number, NativeButtonSource>
  ) => {
    state.buttons = 0;
    state.l2State = 0;
    state.r2State = 0;

    for (const action of GAMEPAD_MAPPING_ACTIONS) {
      const sourceIndex = userButtonMapping[action];
      if (sourceIndex < 0) {
        continue;
      }

      const source = sources[sourceIndex];
      if (!source?.pressed) {
        continue;
      }

      if (action === "LeftTrigger") {
        state.l2State = Math.max(state.l2State, Math.round(source.value * 255));
        state.buttons |= CONTROLLER_ANALOG_BUTTONS.L2;
        continue;
      }

      if (action === "RightTrigger") {
        state.r2State = Math.max(state.r2State, Math.round(source.value * 255));
        state.buttons |= CONTROLLER_ANALOG_BUTTONS.R2;
        continue;
      }

      const mask = GAMEPAD_MAPPING_ACTION_TO_MASK[action];
      if (mask) {
        state.buttons |= mask;
      }
    }
  };

  const emitState = (sourceState: MutableControllerState) => {
    const nextState = cloneState(sourceState);

    if (nextState.l2State > 0) {
      nextState.buttons |= CONTROLLER_ANALOG_BUTTONS.L2;
    }
    if (nextState.r2State > 0) {
      nextState.buttons |= CONTROLLER_ANALOG_BUTTONS.R2;
    }

    if (hasLastEmittedState && isSameState(nextState, lastEmittedState)) {
      return;
    }

    copyState(lastEmittedState, nextState);
    hasLastEmittedState = true;
    onStateChange(nextState);
  };

  const emitActiveDeviceState = () => {
    if (activeDeviceId) {
      const activeState = deviceStates.get(activeDeviceId);
      if (activeState) {
        emitState(activeState);
        return;
      }
    }

    const firstEntry = deviceStates.entries().next().value as [string, MutableControllerState] | undefined;
    if (firstEntry) {
      activeDeviceId = firstEntry[0];
      emitState(firstEntry[1]);
      return;
    }

    emitState(idleState);
  };

  const syncStateFromControllerInstance = (
    controller: any,
    joystick: any,
    state: MutableControllerState,
    triggerBindings: DeviceTriggerBindings,
    triggerNormalizers: DeviceTriggerNormalizers,
    digitalButtonBindings: DeviceDigitalButtonBindings
  ) => {
    state.buttons = 0;
    state.l2State = 0;
    state.r2State = 0;
    state.leftX = 0;
    state.leftY = 0;
    state.rightX = 0;
    state.rightY = 0;

    const rawAxes = controller?.axes;
    const axes = rawAxes && typeof rawAxes === "object"
      ? (rawAxes as Record<string, unknown>)
      : {};
    const rawButtons = controller?.buttons;
    const buttons = rawButtons && typeof rawButtons === "object"
      ? (rawButtons as Record<string, unknown>)
      : {};

    state.leftX = toSignedAxisValue(getAxisValue(axes, ["leftStickX", "leftX", "0"]));
    state.leftY = toSignedAxisValue(getAxisValue(axes, ["leftStickY", "leftY", "1"]));
    state.rightX = toSignedAxisValue(getAxisValue(axes, ["rightStickX", "rightX", "2"]));
    state.rightY = toSignedAxisValue(getAxisValue(axes, ["rightStickY", "rightY", "3"]));

    state.l2State = resolveTriggerState(
      getAxisValue(axes, ["leftTrigger", "lt", "4"]),
      joystick,
      triggerBindings.leftTrigger,
      triggerNormalizers.leftTrigger
    );
    state.r2State = resolveTriggerState(
      getAxisValue(axes, ["rightTrigger", "rt", "5"]),
      joystick,
      triggerBindings.rightTrigger,
      triggerNormalizers.rightTrigger
    );

    // Rebuild mapped digital buttons from the raw joystick sidecar when
    // available. This avoids relying solely on controller button edge events,
    // which can miss D-Pad hat transitions on some SDL backends.
    const nativeButtonSources = buildNativeButtonSources(buttons, state.l2State, state.r2State);
    applyJoystickDigitalButtonSources(nativeButtonSources, joystick, digitalButtonBindings);
    applyUserButtonMapping(state, nativeButtonSources);
  };

  const closeController = (deviceId: string) => {
    const controller = controllerInstances.get(deviceId);
    const joystick = joystickInstances.get(deviceId);
    onLog?.(`node-sdl controller disconnected: ${deviceId}`);
    if (controller && !controller.closed) {
      try {
        controller.close();
      } catch {
        // ignore close failures
      }
    }
    if (joystick && !joystick.closed) {
      try {
        joystick.close();
      } catch {
        // ignore close failures
      }
    }
    controllerInstances.delete(deviceId);
    joystickInstances.delete(deviceId);
    deviceStates.delete(deviceId);
    deviceTriggerNormalizers.delete(deviceId);
    deviceTriggerBindings.delete(deviceId);
    deviceDigitalButtonBindings.delete(deviceId);
    if (activeDeviceId === deviceId) {
      activeDeviceId = null;
    }
    emitActiveDeviceState();
  };

  const clearStartupRescanTimer = () => {
    if (!startupRescanTimer) {
      return;
    }

    clearTimeout(startupRescanTimer);
    startupRescanTimer = null;
  };

  const openController = (device: any) => {
    const deviceId = resolveDeviceId(device);
    if (!deviceId || controllerInstances.has(deviceId) || !sdl?.controller?.openDevice) {
      return;
    }

    try {
      const controller = sdl.controller.openDevice(device);
      onLog?.(`node-sdl controller connected: ${deviceId} (${String(device?.name || "unknown")})`);
      controllerInstances.set(deviceId, controller);
      const joystick = openJoystick(deviceId);
      if (joystick) {
        joystickInstances.set(deviceId, joystick);
      }
      const triggerNormalizers = createDeviceTriggerNormalizers(
        getControllerMapping(controller, device)
      );
      const triggerBindings = createDeviceTriggerBindings(getControllerMapping(controller, device));
      const digitalButtonBindings = createDeviceDigitalButtonBindings(
        getControllerMapping(controller, device)
      );
      deviceTriggerNormalizers.set(deviceId, triggerNormalizers);
      deviceTriggerBindings.set(deviceId, triggerBindings);
      deviceDigitalButtonBindings.set(deviceId, digitalButtonBindings);
      const controllerState = createIdleState();
      deviceStates.set(deviceId, controllerState);
      syncStateFromControllerInstance(
        controller,
        joystick,
        controllerState,
        triggerBindings,
        triggerNormalizers,
        digitalButtonBindings
      );
      if (!activeDeviceId) {
        activeDeviceId = deviceId;
      }
      emitActiveDeviceState();

      controller.on("axisMotion", () => {
        const state = deviceStates.get(deviceId);
        const joystick = joystickInstances.get(deviceId) ?? null;
        const triggerBindings = deviceTriggerBindings.get(deviceId);
        const triggerNormalizers = deviceTriggerNormalizers.get(deviceId);
        const digitalButtonBindings = deviceDigitalButtonBindings.get(deviceId);
        if (!state || !triggerBindings || !triggerNormalizers || !digitalButtonBindings) return;
        syncStateFromControllerInstance(
          controller,
          joystick,
          state,
          triggerBindings,
          triggerNormalizers,
          digitalButtonBindings
        );
        activeDeviceId = deviceId;
        emitState(state);
      });

      controller.on("buttonDown", () => {
        const state = deviceStates.get(deviceId);
        const joystick = joystickInstances.get(deviceId) ?? null;
        const triggerBindings = deviceTriggerBindings.get(deviceId);
        const triggerNormalizers = deviceTriggerNormalizers.get(deviceId);
        const digitalButtonBindings = deviceDigitalButtonBindings.get(deviceId);
        if (!state || !triggerBindings || !triggerNormalizers || !digitalButtonBindings) return;
        syncStateFromControllerInstance(
          controller,
          joystick,
          state,
          triggerBindings,
          triggerNormalizers,
          digitalButtonBindings
        );
        activeDeviceId = deviceId;
        emitState(state);
      });

      controller.on("buttonUp", () => {
        const state = deviceStates.get(deviceId);
        const joystick = joystickInstances.get(deviceId) ?? null;
        const triggerBindings = deviceTriggerBindings.get(deviceId);
        const triggerNormalizers = deviceTriggerNormalizers.get(deviceId);
        const digitalButtonBindings = deviceDigitalButtonBindings.get(deviceId);
        if (!state || !triggerBindings || !triggerNormalizers || !digitalButtonBindings) return;
        syncStateFromControllerInstance(
          controller,
          joystick,
          state,
          triggerBindings,
          triggerNormalizers,
          digitalButtonBindings
        );
        activeDeviceId = deviceId;
        emitState(state);
      });

      controller.on("remap", () => {
        const state = deviceStates.get(deviceId);
        const joystick = joystickInstances.get(deviceId) ?? null;
        const triggerBindings = deviceTriggerBindings.get(deviceId);
        const triggerNormalizers = deviceTriggerNormalizers.get(deviceId);
        const digitalButtonBindings = deviceDigitalButtonBindings.get(deviceId);
        if (!state || !triggerBindings || !triggerNormalizers || !digitalButtonBindings) {
          return;
        }

        const mapping = getControllerMapping(controller, device);
        resetDeviceTriggerNormalizers(
          triggerNormalizers,
          mapping
        );
        resetDeviceTriggerBindings(triggerBindings, mapping);
        resetDeviceDigitalButtonBindings(digitalButtonBindings, mapping);
        syncStateFromControllerInstance(
          controller,
          joystick,
          state,
          triggerBindings,
          triggerNormalizers,
          digitalButtonBindings
        );
        activeDeviceId = deviceId;
        onLog?.(`node-sdl controller remapped: ${deviceId}`);
        emitState(state);
      });

      controller.on("close", () => {
        controllerInstances.delete(deviceId);
        const joystick = joystickInstances.get(deviceId);
        if (joystick && !joystick.closed) {
          try {
            joystick.close();
          } catch {
            // ignore close failures
          }
        }
        joystickInstances.delete(deviceId);
        deviceStates.delete(deviceId);
        deviceTriggerNormalizers.delete(deviceId);
        deviceTriggerBindings.delete(deviceId);
        deviceDigitalButtonBindings.delete(deviceId);
        if (activeDeviceId === deviceId) {
          activeDeviceId = null;
        }
        emitActiveDeviceState();
      });

      joystick?.on("axisMotion", () => {
        const state = deviceStates.get(deviceId);
        const triggerBindings = deviceTriggerBindings.get(deviceId);
        const triggerNormalizers = deviceTriggerNormalizers.get(deviceId);
        const digitalButtonBindings = deviceDigitalButtonBindings.get(deviceId);
        const joystick = joystickInstances.get(deviceId) ?? null;
        if (!state || !triggerBindings || !triggerNormalizers || !digitalButtonBindings) {
          return;
        }

        syncStateFromControllerInstance(
          controller,
          joystick,
          state,
          triggerBindings,
          triggerNormalizers,
          digitalButtonBindings
        );
        activeDeviceId = deviceId;
        emitState(state);
      });

      joystick?.on("buttonDown", () => {
        const state = deviceStates.get(deviceId);
        const triggerBindings = deviceTriggerBindings.get(deviceId);
        const triggerNormalizers = deviceTriggerNormalizers.get(deviceId);
        const digitalButtonBindings = deviceDigitalButtonBindings.get(deviceId);
        const joystick = joystickInstances.get(deviceId) ?? null;
        if (!state || !triggerBindings || !triggerNormalizers || !digitalButtonBindings) {
          return;
        }

        syncStateFromControllerInstance(
          controller,
          joystick,
          state,
          triggerBindings,
          triggerNormalizers,
          digitalButtonBindings
        );
        activeDeviceId = deviceId;
        emitState(state);
      });

      joystick?.on("buttonUp", () => {
        const state = deviceStates.get(deviceId);
        const triggerBindings = deviceTriggerBindings.get(deviceId);
        const triggerNormalizers = deviceTriggerNormalizers.get(deviceId);
        const digitalButtonBindings = deviceDigitalButtonBindings.get(deviceId);
        const joystick = joystickInstances.get(deviceId) ?? null;
        if (!state || !triggerBindings || !triggerNormalizers || !digitalButtonBindings) {
          return;
        }

        syncStateFromControllerInstance(
          controller,
          joystick,
          state,
          triggerBindings,
          triggerNormalizers,
          digitalButtonBindings
        );
        activeDeviceId = deviceId;
        emitState(state);
      });

      joystick?.on("hatMotion", () => {
        const state = deviceStates.get(deviceId);
        const triggerBindings = deviceTriggerBindings.get(deviceId);
        const triggerNormalizers = deviceTriggerNormalizers.get(deviceId);
        const digitalButtonBindings = deviceDigitalButtonBindings.get(deviceId);
        const joystick = joystickInstances.get(deviceId) ?? null;
        if (!state || !triggerBindings || !triggerNormalizers || !digitalButtonBindings) {
          return;
        }

        syncStateFromControllerInstance(
          controller,
          joystick,
          state,
          triggerBindings,
          triggerNormalizers,
          digitalButtonBindings
        );
        activeDeviceId = deviceId;
        emitState(state);
      });

      joystick?.on("close", () => {
        const state = deviceStates.get(deviceId);
        const triggerBindings = deviceTriggerBindings.get(deviceId);
        const triggerNormalizers = deviceTriggerNormalizers.get(deviceId);
        const digitalButtonBindings = deviceDigitalButtonBindings.get(deviceId);
        joystickInstances.delete(deviceId);
        if (!state || !triggerBindings || !triggerNormalizers || !digitalButtonBindings) {
          return;
        }

        syncStateFromControllerInstance(
          controller,
          null,
          state,
          triggerBindings,
          triggerNormalizers,
          digitalButtonBindings
        );
        emitState(state);
      });
    } catch (error: any) {
      onError?.(
        error instanceof Error
          ? error
          : new Error(String(error || "Failed to open node-sdl controller device."))
      );
    }
  };

  const handleDeviceAdd = (event: any) => {
    openController(event?.device);
  };

  const handleDeviceRemove = (event: any) => {
    closeController(resolveDeviceId(event?.device));
  };

  const getDiscoveredDevices = () => {
    return Array.isArray(sdl?.controller?.devices) ? sdl.controller.devices : [];
  };

  const syncDiscoveredDevices = () => {
    for (const device of getDiscoveredDevices()) {
      openController(device);
    }
  };

  const scheduleStartupDeviceRescan = () => {
    clearStartupRescanTimer();

    if (!started) {
      return;
    }

    startupRescanDeadline = Date.now() + STARTUP_DEVICE_RESCAN_WINDOW_MS;

    const run = () => {
      startupRescanTimer = null;

      if (!started) {
        return;
      }

      syncDiscoveredDevices();

      if (controllerInstances.size > 0 || Date.now() >= startupRescanDeadline) {
        if (controllerInstances.size > 0) {
          onLog?.(
            `node-sdl controller startup rescan resolved ${controllerInstances.size} controller(s)`
          );
        }
        return;
      }

      startupRescanTimer = setTimeout(run, STARTUP_DEVICE_RESCAN_INTERVAL_MS);
    };

    startupRescanTimer = setTimeout(run, STARTUP_DEVICE_RESCAN_INTERVAL_MS);
  };

  const clearStateReconcileTimer = () => {
    if (!stateReconcileTimer) {
      return;
    }
    clearInterval(stateReconcileTimer);
    stateReconcileTimer = null;
  };

  const reconcileActiveDeviceStateFromSnapshot = () => {
    if (!started) {
      return;
    }

    const entry = getActiveControllerEntry();
    if (!entry) {
      return;
    }

    const state = deviceStates.get(entry.deviceId);
    const triggerBindings = deviceTriggerBindings.get(entry.deviceId);
    const triggerNormalizers = deviceTriggerNormalizers.get(entry.deviceId);
    const digitalButtonBindings = deviceDigitalButtonBindings.get(entry.deviceId);
    const joystick = joystickInstances.get(entry.deviceId) ?? null;
    if (!state || !triggerBindings || !triggerNormalizers || !digitalButtonBindings) {
      return;
    }

    // Periodic full snapshot reconciliation reduces sticky inputs when a
    // buttonUp event is occasionally missed by the native event stream.
    syncStateFromControllerInstance(
      entry.controller,
      joystick,
      state,
      triggerBindings,
      triggerNormalizers,
      digitalButtonBindings
    );
    activeDeviceId = entry.deviceId;
    emitState(state);
  };

  const getActiveControllerEntry = () => {
    if (activeDeviceId) {
      const controller = controllerInstances.get(activeDeviceId);
      if (controller) {
        return {
          deviceId: activeDeviceId,
          controller,
        };
      }
    }

    const firstEntry = controllerInstances.entries().next().value as [string, any] | undefined;
    if (!firstEntry) {
      return null;
    }

    activeDeviceId = firstEntry[0];
    return {
      deviceId: firstEntry[0],
      controller: firstEntry[1],
    };
  };

  const start = () => {
    if (started) {
      syncDiscoveredDevices();
      emitActiveDeviceState();
      return true;
    }

    try {
      sdl = runtimeRequire("peasyo-sdl-lib");
    } catch (error: any) {
      onError?.(
        error instanceof Error
          ? error
          : new Error(String(error || "Failed to load peasyo-sdl-lib."))
      );
      return false;
    }

    if (!sdl?.controller) {
      onError?.(new Error("Invalid peasyo-sdl-lib controller module."));
      return false;
    }

    sdl.controller.on("deviceAdd", handleDeviceAdd);
    sdl.controller.on("deviceRemove", handleDeviceRemove);

    started = true;

    const devices = getDiscoveredDevices();
    onLog?.(`node-sdl detected controller devices: ${devices.length}`);
    for (const device of devices) {
      openController(device);
    }

    clearStateReconcileTimer();
    stateReconcileTimer = setInterval(
      reconcileActiveDeviceStateFromSnapshot,
      STATE_RECONCILE_INTERVAL_MS
    );

    scheduleStartupDeviceRescan();
    emitActiveDeviceState();
    return true;
  };

  const stop = () => {
    if (!started) {
      return;
    }

    sdl?.controller?.removeListener?.("deviceAdd", handleDeviceAdd);
    sdl?.controller?.removeListener?.("deviceRemove", handleDeviceRemove);
    clearStartupRescanTimer();
    clearStateReconcileTimer();

    for (const deviceId of Array.from(controllerInstances.keys())) {
      closeController(deviceId);
    }
    controllerInstances.clear();
    joystickInstances.clear();
    deviceStates.clear();
    deviceTriggerNormalizers.clear();
    deviceTriggerBindings.clear();
    deviceDigitalButtonBindings.clear();
    activeDeviceId = null;
    sdl = null;
    started = false;

    hasLastEmittedState = false;
    copyState(lastEmittedState, idleState);
    onStateChange(cloneState(idleState));
  };

  const rumble = (data: NodeGamepadDriverRumbleRequest) => {
    const entry = getActiveControllerEntry();
    if (!entry) {
      return {
        ok: false,
        reason: "no-native-controller",
      };
    }
    if (!entry.controller?.hasRumble || typeof entry.controller?.rumble !== "function") {
      return {
        ok: false,
        reason: "native-controller-rumble-unsupported",
        deviceId: entry.deviceId,
      };
    }

    const low = clampUnit(data?.low ?? 0);
    const high = clampUnit(data?.high ?? 0);
    const durationMs = clampDurationMs(data?.durationMs);

    entry.controller.rumble(low, high, durationMs);
    onLog?.(
      `node-sdl controller rumble: ${entry.deviceId} low=${low.toFixed(2)} high=${high.toFixed(
        2
      )} duration=${durationMs}ms`
    );

    return {
      ok: true,
      deviceId: entry.deviceId,
      low,
      high,
      durationMs,
    };
  };

  return {
    start,
    stop,
    rumble,
  };
};

export type { ControllerStateSnapshot };

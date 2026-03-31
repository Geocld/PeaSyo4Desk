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
};

type MutableControllerState = ControllerStateSnapshot;

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

const toTriggerState = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  let normalized = 0;
  if (numeric >= 0 && numeric <= 1) {
    normalized = numeric;
  } else if (numeric >= -1 && numeric <= 1) {
    normalized = (numeric + 1) / 2;
  } else if (numeric >= 0 && numeric <= 255) {
    normalized = numeric / 255;
  } else if (numeric >= -32768 && numeric <= 32767) {
    normalized = (numeric + 32768) / 65535;
  } else {
    normalized = Math.max(0, Math.min(1, numeric));
  }

  if (normalized <= TRIGGER_DEADZONE) {
    return 0;
  }

  return Math.max(0, Math.min(255, Math.round(normalized * 255)));
};

const isTriggerPressed = (value: unknown) => {
  return toTriggerState(value) >= TRIGGER_DIGITAL_PRESS_STATE;
};

const normalizeInputToken = (value: unknown) => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
};

const BUTTON_TOKEN_TO_MASK: Record<string, number> = {
  "0": CONTROLLER_BUTTONS.CROSS,
  "1": CONTROLLER_BUTTONS.MOON,
  "2": CONTROLLER_BUTTONS.BOX,
  "3": CONTROLLER_BUTTONS.PYRAMID,
  "4": CONTROLLER_BUTTONS.L1,
  "5": CONTROLLER_BUTTONS.R1,
  "6": CONTROLLER_ANALOG_BUTTONS.L2,
  "7": CONTROLLER_ANALOG_BUTTONS.R2,
  "8": CONTROLLER_BUTTONS.SHARE,
  "9": CONTROLLER_BUTTONS.OPTIONS,
  "10": CONTROLLER_BUTTONS.L3,
  "11": CONTROLLER_BUTTONS.R3,
  "12": CONTROLLER_BUTTONS.DPAD_UP,
  "13": CONTROLLER_BUTTONS.DPAD_DOWN,
  "14": CONTROLLER_BUTTONS.DPAD_LEFT,
  "15": CONTROLLER_BUTTONS.DPAD_RIGHT,
  "16": CONTROLLER_BUTTONS.PS,
  a: CONTROLLER_BUTTONS.CROSS,
  b: CONTROLLER_BUTTONS.MOON,
  x: CONTROLLER_BUTTONS.BOX,
  y: CONTROLLER_BUTTONS.PYRAMID,
  cross: CONTROLLER_BUTTONS.CROSS,
  circle: CONTROLLER_BUTTONS.MOON,
  square: CONTROLLER_BUTTONS.BOX,
  triangle: CONTROLLER_BUTTONS.PYRAMID,
  south: CONTROLLER_BUTTONS.CROSS,
  east: CONTROLLER_BUTTONS.MOON,
  west: CONTROLLER_BUTTONS.BOX,
  north: CONTROLLER_BUTTONS.PYRAMID,
  leftshoulder: CONTROLLER_BUTTONS.L1,
  leftbumper: CONTROLLER_BUTTONS.L1,
  lb: CONTROLLER_BUTTONS.L1,
  l1: CONTROLLER_BUTTONS.L1,
  rightshoulder: CONTROLLER_BUTTONS.R1,
  rightbumper: CONTROLLER_BUTTONS.R1,
  rb: CONTROLLER_BUTTONS.R1,
  r1: CONTROLLER_BUTTONS.R1,
  back: CONTROLLER_BUTTONS.SHARE,
  share: CONTROLLER_BUTTONS.SHARE,
  view: CONTROLLER_BUTTONS.SHARE,
  select: CONTROLLER_BUTTONS.SHARE,
  start: CONTROLLER_BUTTONS.OPTIONS,
  options: CONTROLLER_BUTTONS.OPTIONS,
  menu: CONTROLLER_BUTTONS.OPTIONS,
  leftstick: CONTROLLER_BUTTONS.L3,
  leftthumb: CONTROLLER_BUTTONS.L3,
  l3: CONTROLLER_BUTTONS.L3,
  rightstick: CONTROLLER_BUTTONS.R3,
  rightthumb: CONTROLLER_BUTTONS.R3,
  r3: CONTROLLER_BUTTONS.R3,
  dpadup: CONTROLLER_BUTTONS.DPAD_UP,
  dpup: CONTROLLER_BUTTONS.DPAD_UP,
  up: CONTROLLER_BUTTONS.DPAD_UP,
  dpaddown: CONTROLLER_BUTTONS.DPAD_DOWN,
  dpdown: CONTROLLER_BUTTONS.DPAD_DOWN,
  down: CONTROLLER_BUTTONS.DPAD_DOWN,
  dpadleft: CONTROLLER_BUTTONS.DPAD_LEFT,
  dpleft: CONTROLLER_BUTTONS.DPAD_LEFT,
  left: CONTROLLER_BUTTONS.DPAD_LEFT,
  dpadright: CONTROLLER_BUTTONS.DPAD_RIGHT,
  dpright: CONTROLLER_BUTTONS.DPAD_RIGHT,
  right: CONTROLLER_BUTTONS.DPAD_RIGHT,
  guide: CONTROLLER_BUTTONS.PS,
  nexus: CONTROLLER_BUTTONS.PS,
  home: CONTROLLER_BUTTONS.PS,
  ps: CONTROLLER_BUTTONS.PS,
  touchpad: CONTROLLER_BUTTONS.TOUCHPAD,
  misc1: CONTROLLER_BUTTONS.TOUCHPAD,
  lefttrigger: CONTROLLER_ANALOG_BUTTONS.L2,
  triggerleft: CONTROLLER_ANALOG_BUTTONS.L2,
  lt: CONTROLLER_ANALOG_BUTTONS.L2,
  l2: CONTROLLER_ANALOG_BUTTONS.L2,
  righttrigger: CONTROLLER_ANALOG_BUTTONS.R2,
  triggerright: CONTROLLER_ANALOG_BUTTONS.R2,
  rt: CONTROLLER_ANALOG_BUTTONS.R2,
  r2: CONTROLLER_ANALOG_BUTTONS.R2,
};

const AXIS_TOKEN_TO_NAME: Record<string, string> = {
  "0": "leftX",
  "1": "leftY",
  "2": "rightX",
  "3": "rightY",
  "4": "leftTrigger",
  "5": "rightTrigger",
  leftstickx: "leftX",
  leftsticky: "leftY",
  rightstickx: "rightX",
  rightsticky: "rightY",
  leftx: "leftX",
  lefty: "leftY",
  rightx: "rightX",
  righty: "rightY",
  lefttrigger: "leftTrigger",
  triggerleft: "leftTrigger",
  righttrigger: "rightTrigger",
  triggerright: "rightTrigger",
  lt: "leftTrigger",
  rt: "rightTrigger",
};

const isPressed = (value: unknown) => {
  if (typeof value === "boolean") return value;
  return Number(value) > 0;
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

export const createNodeGamepadDriver = (options: NodeGamepadDriverOptions) => {
  const onStateChange = options.onStateChange;
  const onError = options.onError;
  const onLog = options.onLog;

  let started = false;
  let sdl: any = null;
  const controllerInstances = new Map<string, any>();
  const deviceStates = new Map<string, MutableControllerState>();
  const lastEmittedState = createIdleState();
  const idleState = createIdleState();
  let hasLastEmittedState = false;
  let activeDeviceId: string | null = null;

  const setButtonState = (state: MutableControllerState, token: string, pressed: boolean) => {
    const mask = BUTTON_TOKEN_TO_MASK[token];
    if (!mask) {
      return false;
    }

    if (pressed) {
      state.buttons |= mask;
    } else {
      state.buttons &= ~mask;
    }

    if (mask === CONTROLLER_ANALOG_BUTTONS.L2) {
      state.l2State = pressed ? 255 : 0;
    } else if (mask === CONTROLLER_ANALOG_BUTTONS.R2) {
      state.r2State = pressed ? 255 : 0;
    }

    return true;
  };

  const setAxisState = (state: MutableControllerState, axisToken: string, rawValue: unknown) => {
    const axisName = AXIS_TOKEN_TO_NAME[axisToken];
    if (!axisName) {
      return false;
    }

    if (axisName === "leftX") {
      state.leftX = toSignedAxisValue(rawValue);
      return true;
    }
    if (axisName === "leftY") {
      state.leftY = toSignedAxisValue(rawValue);
      return true;
    }
    if (axisName === "rightX") {
      state.rightX = toSignedAxisValue(rawValue);
      return true;
    }
    if (axisName === "rightY") {
      state.rightY = toSignedAxisValue(rawValue);
      return true;
    }

    const triggerValue = toTriggerState(rawValue);
    if (axisName === "leftTrigger") {
      state.l2State = triggerValue;
      if (triggerValue > 0) {
        state.buttons |= CONTROLLER_ANALOG_BUTTONS.L2;
      } else {
        state.buttons &= ~CONTROLLER_ANALOG_BUTTONS.L2;
      }
      return true;
    }

    state.r2State = triggerValue;
    if (triggerValue > 0) {
      state.buttons |= CONTROLLER_ANALOG_BUTTONS.R2;
    } else {
      state.buttons &= ~CONTROLLER_ANALOG_BUTTONS.R2;
    }
    return true;
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

  const syncStateFromControllerInstance = (controller: any, state: MutableControllerState) => {
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

    state.l2State = toTriggerState(getAxisValue(axes, ["leftTrigger", "lt", "4"]));
    state.r2State = toTriggerState(getAxisValue(axes, ["rightTrigger", "rt", "5"]));
    if (state.l2State > 0) {
      state.buttons |= CONTROLLER_ANALOG_BUTTONS.L2;
    }
    if (state.r2State > 0) {
      state.buttons |= CONTROLLER_ANALOG_BUTTONS.R2;
    }

    if (isPressed(getButtonValue(buttons, ["a", "cross", "0"]))) {
      state.buttons |= CONTROLLER_BUTTONS.CROSS;
    }
    if (isPressed(getButtonValue(buttons, ["b", "circle", "1"]))) {
      state.buttons |= CONTROLLER_BUTTONS.MOON;
    }
    if (isPressed(getButtonValue(buttons, ["x", "square", "2"]))) {
      state.buttons |= CONTROLLER_BUTTONS.BOX;
    }
    if (isPressed(getButtonValue(buttons, ["y", "triangle", "3"]))) {
      state.buttons |= CONTROLLER_BUTTONS.PYRAMID;
    }
    if (isPressed(getButtonValue(buttons, ["leftShoulder", "leftBumper", "l1", "4"]))) {
      state.buttons |= CONTROLLER_BUTTONS.L1;
    }
    if (isPressed(getButtonValue(buttons, ["rightShoulder", "rightBumper", "r1", "5"]))) {
      state.buttons |= CONTROLLER_BUTTONS.R1;
    }
    if (isPressed(getButtonValue(buttons, ["back", "share", "view", "8"]))) {
      state.buttons |= CONTROLLER_BUTTONS.SHARE;
    }
    if (isPressed(getButtonValue(buttons, ["start", "menu", "options", "9"]))) {
      state.buttons |= CONTROLLER_BUTTONS.OPTIONS;
    }
    if (isPressed(getButtonValue(buttons, ["leftStick", "leftThumb", "l3", "10"]))) {
      state.buttons |= CONTROLLER_BUTTONS.L3;
    }
    if (isPressed(getButtonValue(buttons, ["rightStick", "rightThumb", "r3", "11"]))) {
      state.buttons |= CONTROLLER_BUTTONS.R3;
    }
    if (isPressed(getButtonValue(buttons, ["dpadUp", "up", "12"]))) {
      state.buttons |= CONTROLLER_BUTTONS.DPAD_UP;
    }
    if (isPressed(getButtonValue(buttons, ["dpadDown", "down", "13"]))) {
      state.buttons |= CONTROLLER_BUTTONS.DPAD_DOWN;
    }
    if (isPressed(getButtonValue(buttons, ["dpadLeft", "left", "14"]))) {
      state.buttons |= CONTROLLER_BUTTONS.DPAD_LEFT;
    }
    if (isPressed(getButtonValue(buttons, ["dpadRight", "right", "15"]))) {
      state.buttons |= CONTROLLER_BUTTONS.DPAD_RIGHT;
    }
    if (isPressed(getButtonValue(buttons, ["guide", "ps", "home", "16"]))) {
      state.buttons |= CONTROLLER_BUTTONS.PS;
    }
    if (isPressed(getButtonValue(buttons, ["touchpad", "misc1", "17"]))) {
      state.buttons |= CONTROLLER_BUTTONS.TOUCHPAD;
    }

    if (isTriggerPressed(getButtonValue(buttons, ["leftTriggerButton", "leftTrigger", "6"]))) {
      state.l2State = Math.max(state.l2State, 255);
      state.buttons |= CONTROLLER_ANALOG_BUTTONS.L2;
    }
    if (isTriggerPressed(getButtonValue(buttons, ["rightTriggerButton", "rightTrigger", "7"]))) {
      state.r2State = Math.max(state.r2State, 255);
      state.buttons |= CONTROLLER_ANALOG_BUTTONS.R2;
    }
  };

  const closeController = (deviceId: string) => {
    const controller = controllerInstances.get(deviceId);
    onLog?.(`node-sdl controller disconnected: ${deviceId}`);
    if (controller && !controller.closed) {
      try {
        controller.close();
      } catch {
        // ignore close failures
      }
    }
    controllerInstances.delete(deviceId);
    deviceStates.delete(deviceId);
    if (activeDeviceId === deviceId) {
      activeDeviceId = null;
    }
    emitActiveDeviceState();
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
      const controllerState = createIdleState();
      deviceStates.set(deviceId, controllerState);
      syncStateFromControllerInstance(controller, controllerState);
      if (!activeDeviceId) {
        activeDeviceId = deviceId;
      }
      emitActiveDeviceState();

      controller.on("axisMotion", (event: any) => {
        const state = deviceStates.get(deviceId);
        if (!state) return;
        const updated = setAxisState(state, normalizeInputToken(event?.axis), event?.value);
        if (!updated) {
          syncStateFromControllerInstance(controller, state);
        }
        activeDeviceId = deviceId;
        emitState(state);
      });

      controller.on("buttonDown", (event: any) => {
        const state = deviceStates.get(deviceId);
        if (!state) return;
        const updated = setButtonState(state, normalizeInputToken(event?.button), true);
        if (!updated) {
          syncStateFromControllerInstance(controller, state);
        }
        activeDeviceId = deviceId;
        emitState(state);
      });

      controller.on("buttonUp", (event: any) => {
        const state = deviceStates.get(deviceId);
        if (!state) return;
        const updated = setButtonState(state, normalizeInputToken(event?.button), false);
        if (!updated) {
          syncStateFromControllerInstance(controller, state);
        }
        activeDeviceId = deviceId;
        emitState(state);
      });

      controller.on("close", () => {
        controllerInstances.delete(deviceId);
        deviceStates.delete(deviceId);
        if (activeDeviceId === deviceId) {
          activeDeviceId = null;
        }
        emitActiveDeviceState();
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

    const devices = Array.isArray(sdl.controller.devices) ? sdl.controller.devices : [];
    onLog?.(`node-sdl detected controller devices: ${devices.length}`);
    for (const device of devices) {
      openController(device);
    }

    started = true;
    emitActiveDeviceState();
    return true;
  };

  const stop = () => {
    if (!started) {
      return;
    }

    sdl?.controller?.removeListener?.("deviceAdd", handleDeviceAdd);
    sdl?.controller?.removeListener?.("deviceRemove", handleDeviceRemove);

    for (const deviceId of Array.from(controllerInstances.keys())) {
      closeController(deviceId);
    }
    controllerInstances.clear();
    deviceStates.clear();
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

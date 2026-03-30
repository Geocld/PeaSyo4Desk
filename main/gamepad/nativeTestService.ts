declare const __non_webpack_require__: undefined | ((id: string) => any);
const runtimeRequire =
  typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__
    : // eslint-disable-next-line no-eval
      (0, eval)("require");

const MAX_LOG_ENTRIES = 40;
const DEFAULT_RUMBLE_DURATION_MS = 1000;
const MAX_RUMBLE_DURATION_MS = 60_000;

const NATIVE_GAMEPAD_TEST_AXIS_NAMES = [
  "leftStickX",
  "leftStickY",
  "rightStickX",
  "rightStickY",
  "leftTrigger",
  "rightTrigger",
] as const;

type NativeGamepadTestAxisName =
  (typeof NATIVE_GAMEPAD_TEST_AXIS_NAMES)[number];

const NATIVE_GAMEPAD_TEST_BUTTON_NAMES = [
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
  "paddle1",
  "paddle2",
  "paddle3",
  "paddle4",
] as const;

type NativeGamepadTestButtonName =
  (typeof NATIVE_GAMEPAD_TEST_BUTTON_NAMES)[number];

type NativeGamepadTestAxes = Record<NativeGamepadTestAxisName, number>;
type NativeGamepadTestButtons = Record<NativeGamepadTestButtonName, boolean>;

const createEmptyNativeGamepadAxes = (): NativeGamepadTestAxes => ({
  leftStickX: 0,
  leftStickY: 0,
  rightStickX: 0,
  rightStickY: 0,
  leftTrigger: 0,
  rightTrigger: 0,
});

const createEmptyNativeGamepadButtons = (): NativeGamepadTestButtons => ({
  dpadLeft: false,
  dpadRight: false,
  dpadUp: false,
  dpadDown: false,
  a: false,
  b: false,
  x: false,
  y: false,
  guide: false,
  back: false,
  start: false,
  leftStick: false,
  rightStick: false,
  leftShoulder: false,
  rightShoulder: false,
  paddle1: false,
  paddle2: false,
  paddle3: false,
  paddle4: false,
});

type NativeGamepadTestControllerSnapshot = {
  id: string;
  active: boolean;
  connected: boolean;
  closed: boolean;
  power: string | null;
  serialNumber: string | null;
  firmwareVersion: number | null;
  steamHandle: string | null;
  capabilities: {
    hasLed: boolean;
    hasRumble: boolean;
    hasRumbleTriggers: boolean;
  };
  device: {
    id: string;
    numericId: number | null;
    name: string | null;
    path: string | null;
    type: string | null;
    guid: string | null;
    vendor: number | null;
    product: number | null;
    version: number | null;
    player: number | null;
    mapping: string | null;
  };
  axes: NativeGamepadTestAxes;
  buttons: NativeGamepadTestButtons;
};

type NativeGamepadTestSnapshot = {
  started: boolean;
  available: boolean;
  error: string | null;
  logs: string[];
  updatedAt: number;
  activeDeviceId: string | null;
  controllers: NativeGamepadTestControllerSnapshot[];
};

type ControllerEntry = {
  deviceId: string;
  device: any;
  controller: any;
  axes: ReturnType<typeof createEmptyNativeGamepadAxes>;
  buttons: ReturnType<typeof createEmptyNativeGamepadButtons>;
};

const normalizeDeviceId = (value: unknown) => {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
};

const normalizeString = (value: unknown) => {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value);
  return text.length > 0 ? text : null;
};

const normalizeNumber = (value: unknown) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const clampSignedUnit = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  if (numeric <= -1) {
    return -1;
  }
  if (numeric >= 1) {
    return 1;
  }
  return numeric;
};

const clampUnit = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  if (numeric >= 1) {
    return 1;
  }
  return numeric;
};

const normalizeTriggerUnit = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  if (numeric >= 0 && numeric <= 1) {
    return numeric;
  }
  if (numeric >= -1 && numeric <= 1) {
    return (numeric + 1) / 2;
  }
  if (numeric >= 0 && numeric <= 255) {
    return numeric / 255;
  }
  if (numeric >= -32768 && numeric <= 32767) {
    return (numeric + 32768) / 65535;
  }

  return clampUnit(numeric);
};

const clampDurationMs = (value: unknown) => {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) {
    return DEFAULT_RUMBLE_DURATION_MS;
  }
  return Math.max(0, Math.min(MAX_RUMBLE_DURATION_MS, numeric));
};

const AXIS_NAME_MAP = new Map<string, NativeGamepadTestAxisName>(
  NATIVE_GAMEPAD_TEST_AXIS_NAMES.map((name) => [name.toLowerCase(), name])
);
const BUTTON_NAME_MAP = new Map<string, NativeGamepadTestButtonName>(
  NATIVE_GAMEPAD_TEST_BUTTON_NAMES.map((name) => [name.toLowerCase(), name])
);

const normalizeAxisName = (value: unknown) => {
  return AXIS_NAME_MAP.get(String(value || "").trim().toLowerCase()) || null;
};

const normalizeButtonName = (value: unknown) => {
  return BUTTON_NAME_MAP.get(String(value || "").trim().toLowerCase()) || null;
};

const encodeSteamHandle = (value: unknown) => {
  if (Buffer.isBuffer(value)) {
    return value.toString("hex");
  }
  return normalizeString(value);
};

class NativeGamepadTestServiceImpl {
  private started = false;
  private sdl: any = null;
  private error: string | null = null;
  private updatedAt = 0;
  private activeDeviceId: string | null = null;
  private readonly logs: string[] = [];
  private readonly controllerEntries = new Map<string, ControllerEntry>();

  private readonly handleDeviceAdd = (event: any) => {
    this.openController(event?.device);
  };

  private readonly handleDeviceRemove = (event: any) => {
    this.removeController(normalizeDeviceId(event?.device?.id), {
      closeInstance: true,
      reason: "device removed",
    });
  };

  private markUpdated() {
    this.updatedAt = Date.now();
  }

  private pushLog(message: string) {
    const normalizedMessage = String(message || "").trim();
    if (!normalizedMessage) {
      return;
    }

    this.logs.push(normalizedMessage);
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES);
    }
    this.markUpdated();
  }

  private syncEntryFromController(entry: ControllerEntry) {
    const rawAxes =
      entry.controller?.axes && typeof entry.controller.axes === "object"
        ? (entry.controller.axes as Record<string, unknown>)
        : {};
    const rawButtons =
      entry.controller?.buttons && typeof entry.controller.buttons === "object"
        ? (entry.controller.buttons as Record<string, unknown>)
        : {};

    for (const axisName of NATIVE_GAMEPAD_TEST_AXIS_NAMES) {
      const axisValue = rawAxes[axisName];
      entry.axes[axisName] = axisName.includes("Trigger")
        ? normalizeTriggerUnit(axisValue)
        : clampSignedUnit(axisValue);
    }

    for (const buttonName of NATIVE_GAMEPAD_TEST_BUTTON_NAMES) {
      entry.buttons[buttonName] = !!rawButtons[buttonName];
    }

    entry.device = entry.controller?.device || entry.device;
  }

  private buildControllerSnapshot(entry: ControllerEntry): NativeGamepadTestControllerSnapshot {
    const device = entry.controller?.device || entry.device || {};

    return {
      id: entry.deviceId,
      active: this.activeDeviceId === entry.deviceId,
      connected: !entry.controller?.closed,
      closed: !!entry.controller?.closed,
      power: normalizeString(entry.controller?.power),
      serialNumber: normalizeString(entry.controller?.serialNumber),
      firmwareVersion: normalizeNumber(entry.controller?.firmwareVersion),
      steamHandle: encodeSteamHandle(entry.controller?.steamHandle),
      capabilities: {
        hasLed: !!entry.controller?.hasLed,
        hasRumble: !!entry.controller?.hasRumble,
        hasRumbleTriggers: !!entry.controller?.hasRumbleTriggers,
      },
      device: {
        id: entry.deviceId,
        numericId: normalizeNumber(device?.id),
        name: normalizeString(device?.name),
        path: normalizeString(device?.path),
        type: normalizeString(device?.type),
        guid: normalizeString(device?.guid),
        vendor: normalizeNumber(device?.vendor),
        product: normalizeNumber(device?.product),
        version: normalizeNumber(device?.version),
        player: normalizeNumber(device?.player),
        mapping: normalizeString(device?.mapping),
      },
      axes: { ...entry.axes },
      buttons: { ...entry.buttons },
    };
  }

  private getActiveEntry(deviceId?: unknown) {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (normalizedDeviceId) {
      const matchedEntry = this.controllerEntries.get(normalizedDeviceId);
      if (matchedEntry) {
        return matchedEntry;
      }
    }

    if (this.activeDeviceId) {
      const activeEntry = this.controllerEntries.get(this.activeDeviceId);
      if (activeEntry) {
        return activeEntry;
      }
    }

    return this.controllerEntries.values().next().value as ControllerEntry | undefined;
  }

  private removeController(
    deviceId: string,
    options: { closeInstance: boolean; reason?: string | null }
  ) {
    if (!deviceId) {
      return;
    }

    const entry = this.controllerEntries.get(deviceId);
    if (!entry) {
      return;
    }

    this.controllerEntries.delete(deviceId);
    if (this.activeDeviceId === deviceId) {
      const nextEntry = this.controllerEntries.values().next().value as ControllerEntry | undefined;
      this.activeDeviceId = nextEntry?.deviceId || null;
    }

    if (options.reason) {
      this.pushLog(`native gamepad tester: controller ${deviceId} ${options.reason}`);
    } else {
      this.markUpdated();
    }

    if (options.closeInstance && entry.controller && !entry.controller.closed) {
      try {
        entry.controller.close();
      } catch {
        // ignore close failures
      }
    }
  }

  private openController(device: any) {
    const deviceId = normalizeDeviceId(device?.id);
    if (!deviceId || this.controllerEntries.has(deviceId) || !this.sdl?.controller?.openDevice) {
      return;
    }

    try {
      const controller = this.sdl.controller.openDevice(device);
      const entry: ControllerEntry = {
        deviceId,
        device,
        controller,
        axes: createEmptyNativeGamepadAxes(),
        buttons: createEmptyNativeGamepadButtons(),
      };

      this.syncEntryFromController(entry);
      this.controllerEntries.set(deviceId, entry);
      if (!this.activeDeviceId) {
        this.activeDeviceId = deviceId;
      }
      this.pushLog(
        `native gamepad tester: controller connected ${deviceId} (${String(
          device?.name || "unknown"
        )})`
      );

      controller.on("axisMotion", (event: any) => {
        const nextEntry = this.controllerEntries.get(deviceId);
        if (!nextEntry) {
          return;
        }

        const axisName = normalizeAxisName(event?.axis);
        if (!axisName) {
          this.syncEntryFromController(nextEntry);
        } else if (axisName.includes("Trigger")) {
          nextEntry.axes[axisName] = normalizeTriggerUnit(event?.value);
        } else {
          nextEntry.axes[axisName] = clampSignedUnit(event?.value);
        }

        this.activeDeviceId = deviceId;
        this.markUpdated();
      });

      controller.on("buttonDown", (event: any) => {
        const nextEntry = this.controllerEntries.get(deviceId);
        if (!nextEntry) {
          return;
        }

        const buttonName = normalizeButtonName(event?.button);
        if (!buttonName) {
          this.syncEntryFromController(nextEntry);
        } else {
          nextEntry.buttons[buttonName] = true;
        }

        this.activeDeviceId = deviceId;
        this.markUpdated();
      });

      controller.on("buttonUp", (event: any) => {
        const nextEntry = this.controllerEntries.get(deviceId);
        if (!nextEntry) {
          return;
        }

        const buttonName = normalizeButtonName(event?.button);
        if (!buttonName) {
          this.syncEntryFromController(nextEntry);
        } else {
          nextEntry.buttons[buttonName] = false;
        }

        this.activeDeviceId = deviceId;
        this.markUpdated();
      });

      controller.on("powerUpdate", () => {
        if (!this.controllerEntries.has(deviceId)) {
          return;
        }
        this.markUpdated();
      });

      controller.on("steamHandleUpdate", () => {
        if (!this.controllerEntries.has(deviceId)) {
          return;
        }
        this.markUpdated();
      });

      controller.on("remap", () => {
        const nextEntry = this.controllerEntries.get(deviceId);
        if (!nextEntry) {
          return;
        }
        this.syncEntryFromController(nextEntry);
        this.pushLog(`native gamepad tester: controller remapped ${deviceId}`);
      });

      controller.on("close", () => {
        this.removeController(deviceId, {
          closeInstance: false,
          reason: "closed",
        });
      });
    } catch (error: any) {
      const message =
        error instanceof Error
          ? error.message
          : String(error || "Failed to open native controller.");
      this.error = message;
      this.pushLog(`native gamepad tester: failed to open controller ${deviceId}: ${message}`);
    }
  }

  start(): NativeGamepadTestSnapshot {
    if (this.started) {
      const devices = Array.isArray(this.sdl?.controller?.devices) ? this.sdl.controller.devices : [];
      for (const device of devices) {
        this.openController(device);
      }
      return this.getSnapshot();
    }

    this.logs.length = 0;
    this.error = null;
    this.updatedAt = Date.now();

    try {
      this.sdl = runtimeRequire("peasyo-sdl-lib");
    } catch (error: any) {
      this.error =
        error instanceof Error
          ? error.message
          : String(error || "Failed to load peasyo-sdl-lib.");
      this.pushLog(`native gamepad tester: ${this.error}`);
      return this.getSnapshot();
    }

    if (!this.sdl?.controller) {
      this.error = "Invalid peasyo-sdl-lib controller module.";
      this.pushLog(`native gamepad tester: ${this.error}`);
      this.sdl = null;
      return this.getSnapshot();
    }

    this.sdl.controller.on("deviceAdd", this.handleDeviceAdd);
    this.sdl.controller.on("deviceRemove", this.handleDeviceRemove);

    const devices = Array.isArray(this.sdl.controller.devices) ? this.sdl.controller.devices : [];
    this.pushLog(`native gamepad tester: detected controller devices ${devices.length}`);
    for (const device of devices) {
      this.openController(device);
    }

    this.started = true;
    this.markUpdated();
    return this.getSnapshot();
  }

  stop() {
    if (this.started) {
      this.sdl?.controller?.removeListener?.("deviceAdd", this.handleDeviceAdd);
      this.sdl?.controller?.removeListener?.("deviceRemove", this.handleDeviceRemove);
    }

    for (const deviceId of Array.from(this.controllerEntries.keys())) {
      this.removeController(deviceId, {
        closeInstance: true,
        reason: null,
      });
    }

    this.controllerEntries.clear();
    this.activeDeviceId = null;
    this.sdl = null;
    this.started = false;
    this.markUpdated();

    return {
      stopped: true,
    };
  }

  getSnapshot(): NativeGamepadTestSnapshot {
    const controllers = Array.from(this.controllerEntries.values()).map((entry) =>
      this.buildControllerSnapshot(entry)
    );

    return {
      started: this.started,
      available: !!this.sdl?.controller,
      error: this.error,
      logs: [...this.logs],
      updatedAt: this.updatedAt,
      activeDeviceId: this.activeDeviceId,
      controllers,
    };
  }

  rumble(data: {
    deviceId?: unknown;
    low?: unknown;
    high?: unknown;
    durationMs?: unknown;
  }) {
    const entry = this.getActiveEntry(data?.deviceId);
    if (!entry) {
      throw new Error("No native controller is available.");
    }
    if (!entry.controller?.hasRumble || typeof entry.controller?.rumble !== "function") {
      throw new Error("Selected native controller does not support rumble.");
    }

    const low = clampUnit(data?.low ?? 1);
    const high = clampUnit(data?.high ?? 1);
    const durationMs = clampDurationMs(data?.durationMs);

    entry.controller.rumble(low, high, durationMs);
    this.pushLog(
      `native gamepad tester: rumble ${entry.deviceId} low=${low.toFixed(2)} high=${high.toFixed(
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
  }

  rumbleTriggers(data: {
    deviceId?: unknown;
    left?: unknown;
    right?: unknown;
    durationMs?: unknown;
  }) {
    const entry = this.getActiveEntry(data?.deviceId);
    if (!entry) {
      throw new Error("No native controller is available.");
    }
    if (
      !entry.controller?.hasRumbleTriggers ||
      typeof entry.controller?.rumbleTriggers !== "function"
    ) {
      throw new Error("Selected native controller does not support trigger rumble.");
    }

    const left = clampUnit(data?.left ?? 1);
    const right = clampUnit(data?.right ?? 1);
    const durationMs = clampDurationMs(data?.durationMs);

    entry.controller.rumbleTriggers(left, right, durationMs);
    this.pushLog(
      `native gamepad tester: trigger rumble ${entry.deviceId} left=${left.toFixed(
        2
      )} right=${right.toFixed(2)} duration=${durationMs}ms`
    );

    return {
      ok: true,
      deviceId: entry.deviceId,
      left,
      right,
      durationMs,
    };
  }
}

export const NativeGamepadTestService = new NativeGamepadTestServiceImpl();

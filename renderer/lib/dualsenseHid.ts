const SONY_VENDOR_ID = 0x054c;
const DUALSENSE_PRODUCT_ID = 0x0ce6;
const DUALSENSE_EDGE_PRODUCT_ID = 0x0df2;
const HID_USAGE_PAGE_GENERIC_DESKTOP = 0x0001;
const HID_USAGE_ID_GAMEPAD = 0x0005;

const DUALSENSE_INPUT_REPORT_USB = 0x01;
const DUALSENSE_INPUT_REPORT_BT = 0x31;
const DUALSENSE_TOUCH_OFFSET_USB = 32;
const DUALSENSE_TOUCH_OFFSET_BT = 33;
const DUALSENSE_TOUCH_DATA_BYTES = 8;
const DUALSENSE_TOUCHPAD_WIDTH = 1919;
const DUALSENSE_TOUCHPAD_HEIGHT = 1079;
const DUALSENSE_TOUCH_INACTIVE_MASK = 0x80;

const DUALSENSE_OUTPUT_REPORT_USB = 0x02;
const DUALSENSE_OUTPUT_REPORT_BT = 0x31;
const DUALSENSE_OUTPUT_STATE_BYTES = 47;
const DUALSENSE_OUTPUT_REPORT_BT_BYTES = 77;
const DUALSENSE_TRIGGER_PARAM_BYTES = 10;

type HidReportItemInfoLike = {
  reportSize?: number | null;
  reportCount?: number | null;
};

type HidReportInfoLike = {
  items?: HidReportItemInfoLike[] | readonly HidReportItemInfoLike[] | null;
};

type HidCollectionInfoLike = {
  usagePage?: number | null;
  usage?: number | null;
  inputReports?: HidReportInfoLike[] | readonly HidReportInfoLike[] | null;
};

type HIDInputReportEvent = {
  reportId: number;
  data: DataView;
};

type HIDDevice = {
  vendorId: number;
  productId: number;
  productName: string;
  opened: boolean;
  collections: HidCollectionInfoLike[] | readonly HidCollectionInfoLike[];
  open: () => Promise<void>;
  close: () => Promise<void>;
  sendReport: (reportId: number, data: ArrayBuffer | ArrayBufferLike | ArrayBufferView) => Promise<void>;
  addEventListener: (type: "inputreport", listener: (event: HIDInputReportEvent) => void) => void;
  removeEventListener: (
    type: "inputreport",
    listener: (event: HIDInputReportEvent) => void
  ) => void;
};

type HID = {
  getDevices: () => Promise<HIDDevice[]>;
  requestDevice?: (options: {
    filters: Array<{
      vendorId?: number;
      productId?: number;
      usagePage?: number;
      usage?: number;
    }>;
  }) => Promise<HIDDevice[]>;
  addEventListener: (type: "connect" | "disconnect", listener: () => void) => void;
  removeEventListener: (type: "connect" | "disconnect", listener: () => void) => void;
};

type TouchPoint = {
  id: number;
  x?: number;
  y?: number;
};

export type DualSenseTouchState = {
  touchIdNext: number;
  touches: [TouchPoint, TouchPoint];
};

type DeviceConnectionType = "usb" | "bluetooth" | "unknown";

type DeviceContext = {
  device: HIDDevice;
  connectionType: DeviceConnectionType;
  lastInputReportId: number;
  rawTouchState: DualSenseTouchState;
  touchState: DualSenseTouchState;
  nextSessionTouchId: number;
  activeSessionTouchIds: [number | null, number | null];
  outputState: Uint8Array;
  btOutputSeq: number;
  inputReportHandler: (event: HIDInputReportEvent) => void;
  openPromise: Promise<boolean> | null;
  writeChain: Promise<boolean>;
};

const clamp = (value: number, min: number, max: number) => {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
};

const clampByte = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.trunc(numeric)));
};

const normalizeTouchPoint = (touch: TouchPoint): TouchPoint => {
  if (touch.id < 0) {
    return { id: -1 };
  }

  return {
    id: clamp(touch.id, 0, 127),
    x: clamp(Number(touch.x ?? 0), 0, 65535),
    y: clamp(Number(touch.y ?? 0), 0, 65535),
  };
};

const cloneTouchPoint = (touch: TouchPoint): TouchPoint => {
  return normalizeTouchPoint(touch);
};

const createIdleTouchState = (): DualSenseTouchState => ({
  touchIdNext: 0,
  touches: [{ id: -1 }, { id: -1 }],
});

const cloneTouchState = (touchState: DualSenseTouchState): DualSenseTouchState => ({
  touchIdNext: clamp(touchState.touchIdNext, 0, 127),
  touches: [
    cloneTouchPoint(touchState.touches[0]),
    cloneTouchPoint(touchState.touches[1]),
  ],
});

const isSameTouchPoint = (left: TouchPoint, right: TouchPoint) => {
  if (left.id !== right.id) {
    return false;
  }
  if (left.id < 0) {
    return true;
  }
  return Number(left.x ?? 0) === Number(right.x ?? 0) && Number(left.y ?? 0) === Number(right.y ?? 0);
};

const isSameTouchState = (left: DualSenseTouchState, right: DualSenseTouchState) => {
  return (
    left.touchIdNext === right.touchIdNext &&
    isSameTouchPoint(left.touches[0], right.touches[0]) &&
    isSameTouchPoint(left.touches[1], right.touches[1])
  );
};

const hasActiveTouchState = (touchState: DualSenseTouchState | null | undefined) => {
  return !!touchState && touchState.touches.some((touch) => touch.id >= 0);
};

export const hasActiveDualSenseTouchState = hasActiveTouchState;

const isDualSenseProductId = (productId: number) => {
  return productId === DUALSENSE_PRODUCT_ID || productId === DUALSENSE_EDGE_PRODUCT_ID;
};

const getNavigatorHid = () => {
  if (typeof navigator === "undefined") {
    return null;
  }
  const nextNavigator = navigator as Navigator & { hid?: HID };
  if (!nextNavigator.hid) {
    return null;
  }
  return nextNavigator.hid;
};

const parseGamepadVendorProduct = (id: string) => {
  const vendorProductMatch = id.match(/Vendor:\s*([0-9a-f]{4})\s*Product:\s*([0-9a-f]{4})/i);
  if (vendorProductMatch) {
    return {
      vendorId: Number.parseInt(vendorProductMatch[1], 16),
      productId: Number.parseInt(vendorProductMatch[2], 16),
    };
  }

  const compactMatch = id.match(/\b([0-9a-f]{4})-([0-9a-f]{4})\b/i);
  if (compactMatch) {
    return {
      vendorId: Number.parseInt(compactMatch[1], 16),
      productId: Number.parseInt(compactMatch[2], 16),
    };
  }

  return null;
};

const isDualSenseLikeGamepad = (gamepad: Gamepad | null | undefined) => {
  if (!gamepad || !gamepad.connected) {
    return false;
  }

  const parsed = parseGamepadVendorProduct(String(gamepad.id || ""));
  if (parsed) {
    return parsed.vendorId === SONY_VENDOR_ID && isDualSenseProductId(parsed.productId);
  }

  return /dualsense(?:\s+edge)?/i.test(String(gamepad.id || ""));
};

const isDualSenseHidDevice = (device: HIDDevice) => {
  return device.vendorId === SONY_VENDOR_ID && isDualSenseProductId(device.productId);
};

const detectConnectionType = (device: HIDDevice): DeviceConnectionType => {
  for (const collection of device.collections || []) {
    if (
      collection.usagePage !== HID_USAGE_PAGE_GENERIC_DESKTOP ||
      collection.usage !== HID_USAGE_ID_GAMEPAD
    ) {
      continue;
    }

    const maxInputReportBits = (collection.inputReports || []).reduce((currentMax, report) => {
      const bitCount = (report.items || []).reduce((sum, item) => {
        return sum + (item.reportSize || 0) * (item.reportCount || 0);
      }, 0);
      return Math.max(currentMax, bitCount);
    }, 0);

    if (maxInputReportBits === 504) {
      return "usb";
    }
    if (maxInputReportBits === 616) {
      return "bluetooth";
    }
  }

  return "unknown";
};

const parseDualSenseTouchPoint = (data: DataView, offset: number): TouchPoint => {
  if (data.byteLength < offset + 4) {
    return { id: -1 };
  }

  const rawId = data.getUint8(offset);
  if ((rawId & DUALSENSE_TOUCH_INACTIVE_MASK) !== 0) {
    return { id: -1 };
  }

  const x = ((data.getUint8(offset + 2) & 0x0f) << 8) | data.getUint8(offset + 1);
  const y = (data.getUint8(offset + 3) << 4) | (data.getUint8(offset + 2) >> 4);

  return {
    id: rawId & 0x7f,
    x: clamp(x, 0, DUALSENSE_TOUCHPAD_WIDTH),
    y: clamp(y, 0, DUALSENSE_TOUCHPAD_HEIGHT),
  };
};

const parseDualSenseTouchState = (reportId: number, data: DataView) => {
  if (reportId !== DUALSENSE_INPUT_REPORT_USB && reportId !== DUALSENSE_INPUT_REPORT_BT) {
    return null;
  }

  const touchOffset =
    reportId === DUALSENSE_INPUT_REPORT_BT ? DUALSENSE_TOUCH_OFFSET_BT : DUALSENSE_TOUCH_OFFSET_USB;
  if (data.byteLength < touchOffset + DUALSENSE_TOUCH_DATA_BYTES) {
    return null;
  }

  return {
    touchIdNext: 0,
    touches: [
      parseDualSenseTouchPoint(data, touchOffset),
      parseDualSenseTouchPoint(data, touchOffset + 4),
    ] as [TouchPoint, TouchPoint],
  };
};

const buildSessionTouchStateFromRaw = (
  context: DeviceContext,
  rawTouchState: DualSenseTouchState
): DualSenseTouchState => {
  const touches: [TouchPoint, TouchPoint] = [{ id: -1 }, { id: -1 }];

  for (let slot = 0; slot < 2; slot += 1) {
    const slotIndex = slot as 0 | 1;
    const rawTouch = rawTouchState.touches[slotIndex];
    if (rawTouch.id < 0) {
      context.activeSessionTouchIds[slotIndex] = null;
      continue;
    }

    let sessionTouchId = context.activeSessionTouchIds[slotIndex];
    if (sessionTouchId === null || sessionTouchId === undefined) {
      sessionTouchId = context.nextSessionTouchId;
      context.nextSessionTouchId = (context.nextSessionTouchId + 1) % 128;
      context.activeSessionTouchIds[slotIndex] = sessionTouchId;
    }

    touches[slotIndex] = {
      id: sessionTouchId,
      x: rawTouch.x,
      y: rawTouch.y,
    };
  }

  return {
    touchIdNext: context.nextSessionTouchId,
    touches,
  };
};

const createDefaultOutputState = () => {
  const state = new Uint8Array(DUALSENSE_OUTPUT_STATE_BYTES);
  state[1] = 0xf7;
  state[45] = 0xff;
  return state;
};

const setBit = (buffer: Uint8Array, index: number, bit: number, enabled: boolean) => {
  if (enabled) {
    buffer[index] |= 1 << bit;
    return;
  }
  buffer[index] &= ~(1 << bit);
};

const normalizeFixedLengthBytes = (bytes: Uint8Array | null, length: number) => {
  const normalized = new Uint8Array(length);
  if (!bytes) {
    return normalized;
  }

  normalized.set(bytes.subarray(0, length));
  return normalized;
};

const parseByteArrayValue = (value: unknown) => {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value.map((item) => clampByte(item)));
  }

  if (typeof value === "string") {
    const prefixedMatch = value.match(/^Buffer\((\d+)\):([0-9a-f]+)$/i);
    if (prefixedMatch) {
      const expectedLength = Number(prefixedMatch[1]);
      const hex = prefixedMatch[2];
      const bytes = new Uint8Array(Math.floor(hex.length / 2));
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      if (bytes.length === expectedLength) {
        return bytes;
      }
      return bytes.subarray(0, expectedLength);
    }
    return null;
  }

  if (value && typeof value === "object") {
    const numericEntries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => /^\d+$/.test(key))
      .sort((left, right) => Number(left[0]) - Number(right[0]));
    if (numericEntries.length < 1) {
      return null;
    }
    return Uint8Array.from(numericEntries.map(([, item]) => clampByte(item)));
  }

  return null;
};

let crcTable: number[] | null = null;

const getCrcTable = () => {
  if (crcTable) {
    return crcTable;
  }

  crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crcTable[n] = value >>> 0;
  }
  return crcTable;
};

const crc32 = (prefixBytes: number[], view: DataView) => {
  const table = getCrcTable();
  let crc = (-1 >>> 0) as number;

  for (const byte of prefixBytes) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }

  for (let i = 0; i < view.byteLength; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ view.getUint8(i)) & 0xff];
  }

  return (crc ^ -1) >>> 0;
};

const fillDualSenseBluetoothOutputChecksum = (reportId: number, reportData: Uint8Array) => {
  const crc = crc32(
    [0xa2, reportId],
    new DataView(reportData.buffer, reportData.byteOffset, reportData.byteLength - 4)
  );
  reportData[reportData.byteLength - 4] = crc & 0xff;
  reportData[reportData.byteLength - 3] = (crc >>> 8) & 0xff;
  reportData[reportData.byteLength - 2] = (crc >>> 16) & 0xff;
  reportData[reportData.byteLength - 1] = (crc >>> 24) & 0xff;
};

class DualSenseHidBridge {
  private retainCount = 0;
  private started = false;
  private refreshPromise: Promise<void> | null = null;
  private requestAccessPromise: Promise<boolean> | null = null;
  private deviceContexts = new Map<HIDDevice, DeviceContext>();
  private assignedDevicesByGamepadIndex = new Map<number, HIDDevice>();
  private listeners = new Set<() => void>();
  private observedDualSenseGamepadCount = 0;

  private handleConnect = () => {
    void this.refreshDevices();
  };

  private handleDisconnect = () => {
    void this.refreshDevices();
  };

  retain() {
    this.retainCount += 1;
    if (!this.started) {
      void this.start();
    }

    return () => {
      this.release();
    };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  syncActiveGamepads(gamepads: readonly Gamepad[]) {
    if (!this.started) {
      void this.start();
    }

    const dualSenseGamepads = gamepads.filter((gamepad) => isDualSenseLikeGamepad(gamepad));
    this.observedDualSenseGamepadCount = dualSenseGamepads.length;
    const activeIndexes = new Set(dualSenseGamepads.map((gamepad) => gamepad.index));

    for (const [gamepadIndex] of this.assignedDevicesByGamepadIndex) {
      if (!activeIndexes.has(gamepadIndex)) {
        this.assignedDevicesByGamepadIndex.delete(gamepadIndex);
      }
    }

    if (dualSenseGamepads.length < 1 || this.deviceContexts.size < 1) {
      return;
    }

    const usedDevices = new Set<HIDDevice>();

    for (const gamepad of dualSenseGamepads) {
      const assignedDevice = this.assignedDevicesByGamepadIndex.get(gamepad.index);
      if (assignedDevice && this.deviceContexts.has(assignedDevice) && this.deviceMatchesGamepad(assignedDevice, gamepad)) {
        usedDevices.add(assignedDevice);
        const context = this.deviceContexts.get(assignedDevice);
        if (context) {
          void this.ensureDeviceOpen(context);
        }
        continue;
      }

      if (assignedDevice) {
        this.assignedDevicesByGamepadIndex.delete(gamepad.index);
      }

      const matchedDevice = this.findMatchingDevice(gamepad, usedDevices);
      if (!matchedDevice) {
        continue;
      }

      this.assignedDevicesByGamepadIndex.set(gamepad.index, matchedDevice);
      usedDevices.add(matchedDevice);
      const context = this.deviceContexts.get(matchedDevice);
      if (context) {
        void this.ensureDeviceOpen(context);
      }
    }
  }

  getTouchStateForGamepad(gamepad: Gamepad | null | undefined) {
    if (!gamepad) {
      return null;
    }

    const assignedDevice = this.assignedDevicesByGamepadIndex.get(gamepad.index);
    if (!assignedDevice) {
      return null;
    }

    const context = this.deviceContexts.get(assignedDevice);
    if (!context || !hasActiveTouchState(context.touchState)) {
      return null;
    }

    return cloneTouchState(context.touchState);
  }

  requestAccessIfNeeded() {
    if (!this.needsAccess()) {
      return Promise.resolve(false);
    }

    if (this.requestAccessPromise) {
      return this.requestAccessPromise;
    }

    const hid = getNavigatorHid();
    if (!hid || typeof hid.requestDevice !== "function") {
      return Promise.resolve(false);
    }

    this.requestAccessPromise = hid
      .requestDevice({
        filters: [
          {
            vendorId: SONY_VENDOR_ID,
            productId: DUALSENSE_PRODUCT_ID,
            usagePage: HID_USAGE_PAGE_GENERIC_DESKTOP,
            usage: HID_USAGE_ID_GAMEPAD,
          },
          {
            vendorId: SONY_VENDOR_ID,
            productId: DUALSENSE_EDGE_PRODUCT_ID,
            usagePage: HID_USAGE_PAGE_GENERIC_DESKTOP,
            usage: HID_USAGE_ID_GAMEPAD,
          },
        ],
      })
      .then(async (devices) => {
        if (!Array.isArray(devices) || devices.length < 1) {
          return false;
        }
        await this.refreshDevices();
        return true;
      })
      .catch(() => false)
      .finally(() => {
        this.requestAccessPromise = null;
      });

    return this.requestAccessPromise;
  }

  applyTriggerEffects(event: unknown) {
    const payload = (event || {}) as Record<string, unknown>;
    const leftParams = parseByteArrayValue(payload.left);
    const rightParams = parseByteArrayValue(payload.right);
    const hasLeft = payload.typeLeft !== undefined || !!leftParams;
    const hasRight = payload.typeRight !== undefined || !!rightParams;

    if (!hasLeft && !hasRight) {
      return payload;
    }

    const activeContexts = this.getActiveDeviceContexts();
    for (const context of activeContexts) {
      void this.queueOutputWrite(
        context,
        (state) => {
          if (hasRight) {
            state[10] = clampByte(payload.typeRight);
            state.set(normalizeFixedLengthBytes(rightParams, DUALSENSE_TRIGGER_PARAM_BYTES), 11);
          }
          if (hasLeft) {
            state[21] = clampByte(payload.typeLeft);
            state.set(normalizeFixedLengthBytes(leftParams, DUALSENSE_TRIGGER_PARAM_BYTES), 22);
          }
          setBit(state, 0, 3, true);
          setBit(state, 0, 2, true);
        },
        (state) => {
          setBit(state, 0, 3, false);
          setBit(state, 0, 2, false);
        }
      );
    }

    return payload;
  }

  applyLedColor(event: unknown) {
    const payload = (event || {}) as Record<string, unknown>;
    const color = parseByteArrayValue(payload.color);
    if (!color || color.length < 3) {
      return payload;
    }

    const activeContexts = this.getActiveDeviceContexts();
    for (const context of activeContexts) {
      void this.queueOutputWrite(
        context,
        (state) => {
          state[44] = color[0];
          state[45] = color[1];
          state[46] = color[2];
          setBit(state, 1, 2, true);
          setBit(state, 1, 3, false);
        },
        (state) => {
          setBit(state, 1, 2, false);
        }
      );
    }

    return payload;
  }

  private release() {
    this.retainCount = Math.max(0, this.retainCount - 1);
    if (this.retainCount < 1) {
      this.stop();
    }
  }

  private async start() {
    const hid = getNavigatorHid();
    if (!hid || this.started) {
      return;
    }

    this.started = true;
    hid.addEventListener("connect", this.handleConnect);
    hid.addEventListener("disconnect", this.handleDisconnect);
    await this.refreshDevices();
  }

  private stop() {
    if (!this.started) {
      return;
    }

    const hid = getNavigatorHid();
    if (hid) {
      hid.removeEventListener("connect", this.handleConnect);
      hid.removeEventListener("disconnect", this.handleDisconnect);
    }

    this.started = false;
    this.refreshPromise = null;
    this.assignedDevicesByGamepadIndex.clear();

    for (const context of this.deviceContexts.values()) {
      this.disposeContext(context);
    }
    this.deviceContexts.clear();
  }

  private async refreshDevices() {
    const hid = getNavigatorHid();
    if (!hid) {
      return;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      const devices = await hid.getDevices();
      const nextDeviceSet = new Set<HIDDevice>();

      for (const device of devices) {
        if (!isDualSenseHidDevice(device)) {
          continue;
        }

        nextDeviceSet.add(device);
        if (!this.deviceContexts.has(device)) {
          this.deviceContexts.set(device, this.createContext(device));
        }
      }

      for (const [device, context] of this.deviceContexts) {
        if (nextDeviceSet.has(device)) {
          continue;
        }

        this.disposeContext(context);
        this.deviceContexts.delete(device);
      }

      for (const [gamepadIndex, assignedDevice] of this.assignedDevicesByGamepadIndex) {
        if (this.deviceContexts.has(assignedDevice)) {
          continue;
        }
        this.assignedDevicesByGamepadIndex.delete(gamepadIndex);
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.refreshPromise = null;
      });

    return this.refreshPromise;
  }

  private createContext(device: HIDDevice): DeviceContext {
    const context: DeviceContext = {
      device,
      connectionType: detectConnectionType(device),
      lastInputReportId: 0,
      rawTouchState: createIdleTouchState(),
      touchState: createIdleTouchState(),
      nextSessionTouchId: 0,
      activeSessionTouchIds: [null, null],
      outputState: createDefaultOutputState(),
      btOutputSeq: 0,
      openPromise: null,
      writeChain: Promise.resolve(true),
      inputReportHandler: (event) => {
        const nextRawTouchState = parseDualSenseTouchState(event.reportId, event.data);
        context.lastInputReportId = Number(event.reportId) || 0;
        if (!nextRawTouchState || isSameTouchState(context.rawTouchState, nextRawTouchState)) {
          return;
        }
        context.rawTouchState = cloneTouchState(nextRawTouchState);
        context.touchState = buildSessionTouchStateFromRaw(context, nextRawTouchState);
        this.notifyListeners();
      },
    };

    device.addEventListener("inputreport", context.inputReportHandler);
    return context;
  }

  private disposeContext(context: DeviceContext) {
    context.device.removeEventListener("inputreport", context.inputReportHandler);
    context.rawTouchState = createIdleTouchState();
    context.touchState = createIdleTouchState();
    context.nextSessionTouchId = 0;
    context.activeSessionTouchIds = [null, null];
    if (context.device.opened) {
      void context.device.close().catch(() => undefined);
    }
  }

  private async ensureDeviceOpen(context: DeviceContext) {
    if (context.device.opened) {
      return true;
    }

    if (context.openPromise) {
      return context.openPromise;
    }

    context.openPromise = context.device
      .open()
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        context.openPromise = null;
      });

    return context.openPromise;
  }

  private deviceMatchesGamepad(device: HIDDevice, gamepad: Gamepad) {
    const parsed = parseGamepadVendorProduct(String(gamepad.id || ""));
    if (parsed) {
      return device.vendorId === parsed.vendorId && device.productId === parsed.productId;
    }

    return isDualSenseHidDevice(device) && /dualsense(?:\s+edge)?/i.test(String(gamepad.id || ""));
  }

  private findMatchingDevice(gamepad: Gamepad, usedDevices: Set<HIDDevice>) {
    let bestDevice: HIDDevice | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    const gamepadId = String(gamepad.id || "").toLowerCase();
    const parsed = parseGamepadVendorProduct(gamepadId);

    for (const context of this.deviceContexts.values()) {
      if (usedDevices.has(context.device)) {
        continue;
      }

      let score = 0;
      if (parsed) {
        if (
          context.device.vendorId !== parsed.vendorId ||
          context.device.productId !== parsed.productId
        ) {
          continue;
        }
        score += 100;
      }

      const productName = String(context.device.productName || "").toLowerCase();
      if (productName && gamepadId.includes(productName)) {
        score += 10;
      }

      if (!parsed && /dualsense(?:\s+edge)?/i.test(gamepadId)) {
        score += 20;
      }

      if (score > bestScore) {
        bestScore = score;
        bestDevice = context.device;
      }
    }

    if (bestDevice) {
      return bestDevice;
    }

    if (!parsed && this.deviceContexts.size === 1 && /wireless controller/i.test(gamepadId)) {
      return Array.from(this.deviceContexts.keys())[0] || null;
    }

    return null;
  }

  private getActiveDeviceContexts() {
    const contexts = new Map<HIDDevice, DeviceContext>();

    for (const assignedDevice of this.assignedDevicesByGamepadIndex.values()) {
      const context = this.deviceContexts.get(assignedDevice);
      if (context) {
        contexts.set(assignedDevice, context);
      }
    }

    if (contexts.size > 0) {
      return Array.from(contexts.values());
    }

    if (this.deviceContexts.size === 1) {
      return Array.from(this.deviceContexts.values());
    }

    return [];
  }

  private needsAccess() {
    if (this.observedDualSenseGamepadCount < 1) {
      return false;
    }

    let activeAssignedDevices = 0;
    for (const assignedDevice of this.assignedDevicesByGamepadIndex.values()) {
      if (this.deviceContexts.has(assignedDevice)) {
        activeAssignedDevices += 1;
      }
    }

    return activeAssignedDevices < this.observedDualSenseGamepadCount;
  }

  private queueOutputWrite(
    context: DeviceContext,
    apply: (state: Uint8Array) => void,
    cleanup?: (state: Uint8Array) => void
  ) {
    const task = async () => {
      const opened = await this.ensureDeviceOpen(context);
      if (!opened) {
        return false;
      }

      apply(context.outputState);
      const payload = context.outputState.slice();
      cleanup?.(context.outputState);

      try {
        await this.sendOutputReport(context, payload);
        return true;
      } catch {
        return false;
      }
    };

    context.writeChain = context.writeChain.then(task, task);
    return context.writeChain;
  }

  private async sendOutputReport(context: DeviceContext, outputState: Uint8Array) {
    const preferBluetooth =
      context.connectionType === "bluetooth" || context.lastInputReportId === DUALSENSE_INPUT_REPORT_BT;

    if (!preferBluetooth) {
      await context.device.sendReport(DUALSENSE_OUTPUT_REPORT_USB, outputState);
      return;
    }

    const payload = new Uint8Array(DUALSENSE_OUTPUT_REPORT_BT_BYTES);
    payload[0] = (context.btOutputSeq & 0x0f) << 4;
    payload[1] = 0x10;
    payload.set(outputState, 2);
    fillDualSenseBluetoothOutputChecksum(DUALSENSE_OUTPUT_REPORT_BT, payload);
    context.btOutputSeq = (context.btOutputSeq + 1) & 0xff;
    await context.device.sendReport(DUALSENSE_OUTPUT_REPORT_BT, payload);
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore listener failures so input polling is not interrupted.
      }
    }
  }
}

const bridge = new DualSenseHidBridge();

export const retainDualSenseHidBridge = () => bridge.retain();

export const subscribeDualSenseHidChanges = (listener: () => void) => bridge.subscribe(listener);

export const syncDualSenseHidGamepads = (gamepads: readonly Gamepad[]) => {
  bridge.syncActiveGamepads(gamepads);
};

export const getDualSenseTouchStateForGamepad = (gamepad: Gamepad | null | undefined) => {
  return bridge.getTouchStateForGamepad(gamepad);
};

export const requestDualSenseHidAccessIfNeeded = () => {
  return bridge.requestAccessIfNeeded();
};

export const applyDualSenseTriggerEffectsFromChiaki = (event: unknown) => {
  return bridge.applyTriggerEffects(event);
};

export const applyDualSenseLedColorFromChiaki = (event: unknown) => {
  return bridge.applyLedColor(event);
};

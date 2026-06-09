const SONY_VENDOR_ID = 0x054c;
const DUALSENSE_PRODUCT_ID = 0x0ce6;
const DUALSENSE_EDGE_PRODUCT_ID = 0x0df2;
const HID_USAGE_PAGE_GENERIC_DESKTOP = 0x0001;
const HID_USAGE_ID_GAMEPAD = 0x0005;

const DUALSENSE_INPUT_REPORT_USB = 0x01;
const DUALSENSE_INPUT_REPORT_BT = 0x31;
const DUALSENSE_INPUT_OFFSET_BT = 1;
const DUALSENSE_TOUCH_OFFSET_USB = 32;
const DUALSENSE_TOUCH_OFFSET_BT = 33;
const DUALSENSE_TOUCH_DATA_BYTES = 8;
const DUALSENSE_TOUCHPAD_WIDTH = 1919;
const DUALSENSE_TOUCHPAD_HEIGHT = 1079;
const DUALSENSE_TOUCH_INACTIVE_MASK = 0x80;
const DUALSENSE_STANDARD_BUTTON_COUNT = 18;
const DUALSENSE_STANDARD_BUTTON_INDEX = {
  CROSS: 0,
  CIRCLE: 1,
  SQUARE: 2,
  TRIANGLE: 3,
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  CREATE: 8,
  OPTIONS: 9,
  L3: 10,
  R3: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
  PS: 16,
  TOUCHPAD: 17,
} as const;
const DUALSENSE_DPAD_DIRECTION_NEUTRAL = 0x08;

const DUALSENSE_OUTPUT_REPORT_USB = 0x02;
const DUALSENSE_OUTPUT_REPORT_BT = 0x31;
const DUALSENSE_OUTPUT_STATE_BYTES = 47;
const DUALSENSE_OUTPUT_REPORT_BT_BYTES = 77;
const DUALSENSE_TRIGGER_PARAM_BYTES = 10;
const DUALSENSE_HAPTIC_REPORT_ID = 0x32;
const DUALSENSE_HAPTIC_REPORT_ID_MAX = 0x39;
const DUALSENSE_HAPTIC_REPORT_BYTES = 141;
const DUALSENSE_HAPTIC_SAMPLE_BYTES = 64;
const DUALSENSE_HAPTIC_REPORT_OVERHEAD_BYTES =
  DUALSENSE_HAPTIC_REPORT_BYTES - DUALSENSE_HAPTIC_SAMPLE_BYTES;
const DUALSENSE_HAPTIC_PCM_INPUT_CHANNELS = 2;
const DUALSENSE_HAPTIC_SAMPLE_FRAME_BYTES = 2;
const DUALSENSE_HAPTIC_SAMPLE_RATE = 3000;
const DUALSENSE_HAPTIC_MAX_PENDING_SAMPLES = 1000;
const DUALSENSE_HAPTIC_MAX_PLAYAHEAD_MS = 32;
const DUALSENSE_HAPTIC_GAIN_COMPENSATION = 1.35;
const DUALSENSE_HAPTIC_DETAIL_TARGET_PCM16 = 24576;
const DUALSENSE_HAPTIC_MAX_DETAIL_BOOST = 1.35;
const DUALSENSE_HAPTIC_IDLE_STOP_DELAY_MS = Math.ceil(
  ((DUALSENSE_HAPTIC_SAMPLE_BYTES / DUALSENSE_HAPTIC_SAMPLE_FRAME_BYTES) /
    DUALSENSE_HAPTIC_SAMPLE_RATE) *
    1000 *
    4
);

type HidReportItemInfoLike = {
  reportSize?: number | null;
  reportCount?: number | null;
};

type HidReportInfoLike = {
  reportId?: number | null;
  items?: HidReportItemInfoLike[] | readonly HidReportItemInfoLike[] | null;
};

type HidCollectionInfoLike = {
  usagePage?: number | null;
  usage?: number | null;
  inputReports?: HidReportInfoLike[] | readonly HidReportInfoLike[] | null;
  outputReports?: HidReportInfoLike[] | readonly HidReportInfoLike[] | null;
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

type DualSenseButtonState = {
  pressed: boolean;
  value: number;
};

export type DualSenseTouchState = {
  touchIdNext: number;
  touches: [TouchPoint, TouchPoint];
};

export type DualSenseInputState = {
  reportId: number;
  axes: [number, number, number, number];
  buttons: DualSenseButtonState[];
  touchState: DualSenseTouchState;
};

type DeviceConnectionType = "usb" | "bluetooth" | "unknown";

type DeviceContext = {
  device: HIDDevice;
  connectionType: DeviceConnectionType;
  lastInputReportId: number;
  hasInputState: boolean;
  inputState: DualSenseInputState;
  rawTouchState: DualSenseTouchState;
  touchState: DualSenseTouchState;
  nextSessionTouchId: number;
  activeSessionTouchIds: [number | null, number | null];
  outputState: Uint8Array;
  btOutputSeq: number;
  outputReportBytes: Map<number, number>;
  hapticPacketSeq: number;
  hapticQuantizationError: [number, number];
  hapticPrimed: boolean;
  hapticStreaming: boolean;
  pendingHapticSamples: Uint8Array[];
  pendingHapticRemainder: Uint8Array;
  hapticWriteScheduled: boolean;
  hapticWriteTimer: ReturnType<typeof setTimeout> | null;
  hapticStopTimer: ReturnType<typeof setTimeout> | null;
  hapticNextWriteAtMs: number;
  inputReportHandler: (event: HIDInputReportEvent) => void;
  openPromise: Promise<boolean> | null;
  pendingStateOutputPayload: Uint8Array | null;
  stateOutputWriteScheduled: boolean;
  outputWriteChain: Promise<boolean>;
  writeChain: Promise<boolean>;
  rumbleStopTimer: ReturnType<typeof setTimeout> | null;
};

type HapticReportLayout = {
  reportId: number;
  reportBytes: number;
  sampleBytes: number;
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

const clampInt8 = (value: number) => {
  if (value > 127) {
    return 127;
  }
  if (value < -128) {
    return -128;
  }
  return value;
};

const absInt16 = (value: number) => {
  if (value >= 0) {
    return value;
  }
  return value === -32768 ? 32768 : -value;
};

const decodeSignedPcm16Le = (low: number, high: number) => {
  const value = (high << 8) | low;
  return value > 0x7fff ? value - 0x10000 : value;
};

const resolveHapticDetailGainScaleFromPcm16Peak = (peakAbs: number) => {
  if (!Number.isFinite(peakAbs) || peakAbs <= 0) {
    return DUALSENSE_HAPTIC_GAIN_COMPENSATION;
  }

  const detailBoost = clamp(
    Math.sqrt(DUALSENSE_HAPTIC_DETAIL_TARGET_PCM16 / peakAbs),
    1,
    DUALSENSE_HAPTIC_MAX_DETAIL_BOOST
  );
  return DUALSENSE_HAPTIC_GAIN_COMPENSATION * detailBoost;
};

const resolveHapticDetailGainScale = (frame: Int16Array | Uint8Array) => {
  let peakAbs = 0;

  if (frame instanceof Int16Array) {
    for (let index = 0; index < frame.length; index += 1) {
      peakAbs = Math.max(peakAbs, absInt16(frame[index] || 0));
    }
    return resolveHapticDetailGainScaleFromPcm16Peak(peakAbs);
  }

  const sampleCount = Math.floor(frame.byteLength / Int16Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < sampleCount; index += 1) {
    const inputOffset = index * Int16Array.BYTES_PER_ELEMENT;
    const pcm16 = decodeSignedPcm16Le(frame[inputOffset] || 0, frame[inputOffset + 1] || 0);
    peakAbs = Math.max(peakAbs, absInt16(pcm16));
  }
  return resolveHapticDetailGainScaleFromPcm16Peak(peakAbs);
};

const shapeHapticPcm16ForDualSense = (pcm16: number, totalGain: number) => {
  const normalized = clamp((pcm16 / 32768) * totalGain, -8, 8);
  const limited = Math.tanh(normalized);
  return Math.round(clamp(limited * 32767, -32768, 32767));
};

const quantizePcm16ToSignedPcm8 = (
  pcm16: number,
  totalGain: number,
  channel: 0 | 1,
  quantizationError?: [number, number]
) => {
  const shapedPcm16 = shapeHapticPcm16ForDualSense(pcm16, totalGain);
  const adjustedPcm16 = shapedPcm16 + (quantizationError?.[channel] ?? 0);
  const signedPcm8 = clampInt8(Math.round(adjustedPcm16 / 256));

  if (quantizationError) {
    if (signedPcm8 <= -128 || signedPcm8 >= 127) {
      quantizationError[channel] = 0;
    } else {
      quantizationError[channel] = clamp(adjustedPcm16 - signedPcm8 * 256, -255, 255);
    }
  }

  return signedPcm8 & 0xff;
};

const getDualSenseHapticSampleDurationMs = (sampleBytes: number) => {
  if (sampleBytes <= 0) {
    return 0;
  }
  return (
    ((sampleBytes / DUALSENSE_HAPTIC_SAMPLE_FRAME_BYTES) / DUALSENSE_HAPTIC_SAMPLE_RATE) * 1000
  );
};

const getMonotonicTimeMs = () => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
};

const normalizeHapticGain = (gain: unknown) => {
  const numeric = Number(gain);
  if (!Number.isFinite(numeric)) {
    return 0.5;
  }
  if (numeric < 0) {
    return 0;
  }
  if (numeric > 2) {
    return 2;
  }
  return numeric;
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

const createIdleDualSenseButtonState = (): DualSenseButtonState => ({
  pressed: false,
  value: 0,
});

const createIdleDualSenseButtons = () => {
  return Array.from({ length: DUALSENSE_STANDARD_BUTTON_COUNT }, () => {
    return createIdleDualSenseButtonState();
  });
};

const createIdleDualSenseInputState = (): DualSenseInputState => ({
  reportId: 0,
  axes: [0, 0, 0, 0],
  buttons: createIdleDualSenseButtons(),
  touchState: createIdleTouchState(),
});

const cloneTouchState = (touchState: DualSenseTouchState): DualSenseTouchState => ({
  touchIdNext: clamp(touchState.touchIdNext, 0, 127),
  touches: [
    cloneTouchPoint(touchState.touches[0]),
    cloneTouchPoint(touchState.touches[1]),
  ],
});

const cloneDualSenseButtonState = (button: DualSenseButtonState): DualSenseButtonState => ({
  pressed: !!button?.pressed,
  value: clamp(Number(button?.value ?? 0), 0, 1),
});

const cloneDualSenseInputState = (inputState: DualSenseInputState): DualSenseInputState => ({
  reportId: Number(inputState.reportId) || 0,
  axes: [
    clamp(Number(inputState.axes[0] ?? 0), -1, 1),
    clamp(Number(inputState.axes[1] ?? 0), -1, 1),
    clamp(Number(inputState.axes[2] ?? 0), -1, 1),
    clamp(Number(inputState.axes[3] ?? 0), -1, 1),
  ],
  buttons: Array.from({ length: DUALSENSE_STANDARD_BUTTON_COUNT }, (_, index) => {
    return cloneDualSenseButtonState(inputState.buttons[index] || createIdleDualSenseButtonState());
  }),
  touchState: cloneTouchState(inputState.touchState),
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

const isSameDualSenseButtonState = (left: DualSenseButtonState, right: DualSenseButtonState) => {
  return !!left?.pressed === !!right?.pressed && Number(left?.value ?? 0) === Number(right?.value ?? 0);
};

const isSameDualSenseInputState = (left: DualSenseInputState, right: DualSenseInputState) => {
  if (
    left.reportId !== right.reportId ||
    left.axes[0] !== right.axes[0] ||
    left.axes[1] !== right.axes[1] ||
    left.axes[2] !== right.axes[2] ||
    left.axes[3] !== right.axes[3] ||
    !isSameTouchState(left.touchState, right.touchState)
  ) {
    return false;
  }

  for (let index = 0; index < DUALSENSE_STANDARD_BUTTON_COUNT; index += 1) {
    if (!isSameDualSenseButtonState(left.buttons[index], right.buttons[index])) {
      return false;
    }
  }

  return true;
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

const isGenericWirelessControllerGamepad = (gamepad: Gamepad | null | undefined) => {
  if (!gamepad || !gamepad.connected) {
    return false;
  }

  return /wireless controller/i.test(String(gamepad.id || ""));
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

const collectOutputReportBytes = (device: HIDDevice) => {
  const reportBytesById = new Map<number, number>();
  for (const collection of device.collections || []) {
    if (
      collection.usagePage !== HID_USAGE_PAGE_GENERIC_DESKTOP ||
      collection.usage !== HID_USAGE_ID_GAMEPAD
    ) {
      continue;
    }

    for (const report of collection.outputReports || []) {
      const reportId = Number(report?.reportId);
      if (!Number.isFinite(reportId)) {
        continue;
      }

      const byteLength = (report.items || []).reduce((sum, item) => {
        const bits = (item.reportSize || 0) * (item.reportCount || 0);
        return sum + Math.floor(bits / 8);
      }, 0);

      if (byteLength < 1) {
        continue;
      }

      const previous = reportBytesById.get(reportId) || 0;
      reportBytesById.set(reportId, Math.max(previous, byteLength));
    }
  }

  return reportBytesById;
};

const normalizeDualSenseStickAxis = (value: number) => {
  return clamp((2 * clampByte(value)) / 0xff - 1, -1, 1);
};

const normalizeDualSenseTriggerValue = (value: number) => {
  return clamp(clampByte(value) / 0xff, 0, 1);
};

const usesDualSenseBluetoothInputLayout = (
  connectionType: DeviceConnectionType,
  reportId: number
) => {
  if (connectionType === "bluetooth") {
    return true;
  }
  if (connectionType === "usb") {
    return false;
  }
  if (reportId === DUALSENSE_INPUT_REPORT_BT) {
    return true;
  }
  if (reportId === DUALSENSE_INPUT_REPORT_USB) {
    return false;
  }
  return false;
};

const getDualSenseInputOffsetBase = (
  connectionType: DeviceConnectionType,
  reportId: number
) => {
  return usesDualSenseBluetoothInputLayout(connectionType, reportId)
    ? DUALSENSE_INPUT_OFFSET_BT
    : 0;
};

const getDualSenseTouchOffset = (connectionType: DeviceConnectionType, reportId: number) => {
  return usesDualSenseBluetoothInputLayout(connectionType, reportId)
    ? DUALSENSE_TOUCH_OFFSET_BT
    : DUALSENSE_TOUCH_OFFSET_USB;
};

const setDualSenseButtonState = (
  buttons: DualSenseButtonState[],
  index: number,
  pressed: boolean,
  value?: number
) => {
  if (index < 0 || index >= buttons.length) {
    return;
  }

  const normalizedValue = clamp(
    value === undefined ? (pressed ? 1 : 0) : Number(value),
    0,
    1
  );
  buttons[index] = {
    pressed: !!pressed || normalizedValue > 0,
    value: normalizedValue,
  };
};

const parseDualSenseDpadButtons = (buttons: DualSenseButtonState[], direction: number) => {
  const normalizedDirection = direction & 0x0f;
  const up =
    normalizedDirection === 0x00 || normalizedDirection === 0x01 || normalizedDirection === 0x07;
  const right =
    normalizedDirection === 0x01 || normalizedDirection === 0x02 || normalizedDirection === 0x03;
  const down =
    normalizedDirection === 0x03 || normalizedDirection === 0x04 || normalizedDirection === 0x05;
  const left =
    normalizedDirection === 0x05 || normalizedDirection === 0x06 || normalizedDirection === 0x07;
  const hasDirection = normalizedDirection !== DUALSENSE_DPAD_DIRECTION_NEUTRAL;

  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.DPAD_UP,
    hasDirection && up
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.DPAD_RIGHT,
    hasDirection && right
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.DPAD_DOWN,
    hasDirection && down
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.DPAD_LEFT,
    hasDirection && left
  );
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

const parseDualSenseTouchState = (
  connectionType: DeviceConnectionType,
  reportId: number,
  data: DataView
) => {
  const touchOffset = getDualSenseTouchOffset(connectionType, reportId);
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

const parseDualSenseInputState = (
  connectionType: DeviceConnectionType,
  reportId: number,
  data: DataView
) => {
  const offsetBase = getDualSenseInputOffsetBase(connectionType, reportId);
  const digitalKeysOffset = 7 + offsetBase;
  const touchState = parseDualSenseTouchState(connectionType, reportId, data);
  if (!touchState || data.byteLength < digitalKeysOffset + 3) {
    return null;
  }

  const buttons = createIdleDualSenseButtons();
  const axes: [number, number, number, number] = [
    normalizeDualSenseStickAxis(data.getUint8(0 + offsetBase)),
    normalizeDualSenseStickAxis(data.getUint8(1 + offsetBase)),
    normalizeDualSenseStickAxis(data.getUint8(2 + offsetBase)),
    normalizeDualSenseStickAxis(data.getUint8(3 + offsetBase)),
  ];
  const leftTriggerValue = normalizeDualSenseTriggerValue(data.getUint8(4 + offsetBase));
  const rightTriggerValue = normalizeDualSenseTriggerValue(data.getUint8(5 + offsetBase));
  const digitalKeys0 = data.getUint8(digitalKeysOffset);
  const digitalKeys1 = data.getUint8(digitalKeysOffset + 1);
  const digitalKeys2 = data.getUint8(digitalKeysOffset + 2);

  parseDualSenseDpadButtons(buttons, digitalKeys0 & 0x0f);
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.SQUARE,
    (digitalKeys0 & 0x10) !== 0
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.CROSS,
    (digitalKeys0 & 0x20) !== 0
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.CIRCLE,
    (digitalKeys0 & 0x40) !== 0
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.TRIANGLE,
    (digitalKeys0 & 0x80) !== 0
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.L1,
    (digitalKeys1 & 0x01) !== 0
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.R1,
    (digitalKeys1 & 0x02) !== 0
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.CREATE,
    (digitalKeys1 & 0x10) !== 0
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.OPTIONS,
    (digitalKeys1 & 0x20) !== 0
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.L3,
    (digitalKeys1 & 0x40) !== 0
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.R3,
    (digitalKeys1 & 0x80) !== 0
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.PS,
    (digitalKeys2 & 0x01) !== 0
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.TOUCHPAD,
    (digitalKeys2 & 0x02) !== 0
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.L2,
    leftTriggerValue > 0,
    leftTriggerValue
  );
  setDualSenseButtonState(
    buttons,
    DUALSENSE_STANDARD_BUTTON_INDEX.R2,
    rightTriggerValue > 0,
    rightTriggerValue
  );

  return {
    reportId,
    axes,
    buttons,
    touchState,
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

const hasMatchingBytes = (buffer: Uint8Array, offset: number, expected: Uint8Array) => {
  if (offset < 0 || offset + expected.length > buffer.length) {
    return false;
  }

  for (let index = 0; index < expected.length; index += 1) {
    if (buffer[offset + index] !== expected[index]) {
      return false;
    }
  }

  return true;
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

const toDualSenseHapticPayload = (
  frame: Int16Array | Int8Array | Uint8Array,
  gain: unknown,
  quantizationError?: [number, number]
) => {
  const safeGain = normalizeHapticGain(gain);
  const detailGainScale =
    frame instanceof Int8Array ? DUALSENSE_HAPTIC_GAIN_COMPENSATION : resolveHapticDetailGainScale(frame);
  const totalGain = safeGain * detailGainScale;
  // DualSense HID haptics packets carry a continuous 3kHz stereo signed-8 PCM
  // stream. The incoming Peasyo frames are 3kHz stereo s16le, so convert them
  // sample-for-sample without changing the channel count. Mobile keeps the
  // source as linear s16 all the way into the native USB haptics endpoint; on
  // WebHID we only have signed-8 payload budget, so apply a mild calibration
  // and soft limiter before quantizing to preserve more of that detail.

  if (frame instanceof Int16Array) {
    const sample = new Uint8Array(frame.length - (frame.length % DUALSENSE_HAPTIC_PCM_INPUT_CHANNELS));
    for (let index = 0; index < sample.length; index += 1) {
      sample[index] = quantizePcm16ToSignedPcm8(
        frame[index],
        totalGain,
        (index % DUALSENSE_HAPTIC_PCM_INPUT_CHANNELS) as 0 | 1,
        quantizationError
      );
    }
    return sample;
  }

  if (frame instanceof Int8Array) {
    const sample = new Uint8Array(frame.length - (frame.length % DUALSENSE_HAPTIC_PCM_INPUT_CHANNELS));
    for (let index = 0; index < sample.length; index += 1) {
      const normalized = clamp((frame[index] / 128) * totalGain, -8, 8);
      sample[index] = clampInt8(Math.round(Math.tanh(normalized) * 127)) & 0xff;
    }
    return sample;
  }

  const sampleCount = Math.floor(frame.byteLength / Int16Array.BYTES_PER_ELEMENT);
  const sample = new Uint8Array(sampleCount - (sampleCount % DUALSENSE_HAPTIC_PCM_INPUT_CHANNELS));
  for (let index = 0; index < sample.length; index += 1) {
    const inputOffset = index * Int16Array.BYTES_PER_ELEMENT;
    const pcm16 = decodeSignedPcm16Le(frame[inputOffset] || 0, frame[inputOffset + 1] || 0);
    sample[index] = quantizePcm16ToSignedPcm8(
      pcm16,
      totalGain,
      (index % DUALSENSE_HAPTIC_PCM_INPUT_CHANNELS) as 0 | 1,
      quantizationError
    );
  }
  return sample;
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

    const dualSenseGamepads = gamepads.filter((gamepad) => this.isDualSenseCandidateGamepad(gamepad));
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

  getInputStateForGamepad(gamepad: Gamepad | null | undefined) {
    if (!gamepad) {
      return null;
    }

    const assignedDevice = this.assignedDevicesByGamepadIndex.get(gamepad.index);
    if (!assignedDevice) {
      return null;
    }

    const context = this.deviceContexts.get(assignedDevice);
    if (!context || !context.device.opened || !context.hasInputState) {
      return null;
    }

    return cloneDualSenseInputState(context.inputState);
  }

  getInputStates() {
    if (!this.started) {
      void this.start();
    }

    const inputStates: DualSenseInputState[] = [];
    for (const context of this.deviceContexts.values()) {
      void this.ensureDeviceOpen(context);
      if (!context.device.opened || !context.hasInputState) {
        continue;
      }
      inputStates.push(cloneDualSenseInputState(context.inputState));
    }

    return inputStates;
  }

  isManagedGamepad(gamepad: Gamepad | null | undefined) {
    if (!gamepad || !gamepad.connected) {
      return false;
    }

    if (this.assignedDevicesByGamepadIndex.has(gamepad.index)) {
      return true;
    }

    if (isDualSenseLikeGamepad(gamepad)) {
      return true;
    }

    return isGenericWirelessControllerGamepad(gamepad) && this.deviceContexts.size > 0;
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
      const normalizedRightParams = hasRight
        ? normalizeFixedLengthBytes(rightParams, DUALSENSE_TRIGGER_PARAM_BYTES)
        : null;
      const normalizedLeftParams = hasLeft
        ? normalizeFixedLengthBytes(leftParams, DUALSENSE_TRIGGER_PARAM_BYTES)
        : null;
      const nextRightType = hasRight ? clampByte(payload.typeRight) : null;
      const nextLeftType = hasLeft ? clampByte(payload.typeLeft) : null;
      const rightUnchanged =
        !hasRight ||
        (context.outputState[10] === nextRightType &&
          !!normalizedRightParams &&
          hasMatchingBytes(context.outputState, 11, normalizedRightParams));
      const leftUnchanged =
        !hasLeft ||
        (context.outputState[21] === nextLeftType &&
          !!normalizedLeftParams &&
          hasMatchingBytes(context.outputState, 22, normalizedLeftParams));
      if (rightUnchanged && leftUnchanged) {
        continue;
      }

      void this.queueStateOutputWrite(
        context,
        (state) => {
          if (hasRight) {
            state[10] = nextRightType ?? 0;
            state.set(normalizedRightParams ?? new Uint8Array(DUALSENSE_TRIGGER_PARAM_BYTES), 11);
          }
          if (hasLeft) {
            state[21] = nextLeftType ?? 0;
            state.set(normalizedLeftParams ?? new Uint8Array(DUALSENSE_TRIGGER_PARAM_BYTES), 22);
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

  playRumbleForGamepad(
    gamepad: Gamepad | null | undefined,
    weakMotor: unknown,
    strongMotor: unknown,
    durationMs: unknown
  ) {
    if (!gamepad) {
      return false;
    }

    let assignedDevice = this.assignedDevicesByGamepadIndex.get(gamepad.index);
    if (!assignedDevice) {
      assignedDevice = this.findMatchingDevice(gamepad, new Set()) || undefined;
      if (assignedDevice) {
        this.assignedDevicesByGamepadIndex.set(gamepad.index, assignedDevice);
      }
    }
    if (!assignedDevice) {
      return false;
    }

    const context = this.deviceContexts.get(assignedDevice);
    if (!context) {
      return false;
    }

    const weakLevel = clampByte(weakMotor);
    const strongLevel = clampByte(strongMotor);
    const duration = Math.max(0, Math.trunc(Number(durationMs) || 0));

    if (context.rumbleStopTimer) {
      clearTimeout(context.rumbleStopTimer);
      context.rumbleStopTimer = null;
    }

    void this.writeRumbleState(context, weakLevel, strongLevel);

    if (duration > 0 && (weakLevel > 0 || strongLevel > 0)) {
      context.rumbleStopTimer = setTimeout(() => {
        context.rumbleStopTimer = null;
        void this.writeRumbleState(context, 0, 0);
      }, duration);
    }

    return true;
  }

  playRumbleForActiveDevices(weakMotor: unknown, strongMotor: unknown, durationMs: unknown) {
    const contexts = this.getActiveDeviceContexts();
    if (contexts.length < 1) {
      return false;
    }

    const weakLevel = clampByte(weakMotor);
    const strongLevel = clampByte(strongMotor);
    const duration = Math.max(0, Math.trunc(Number(durationMs) || 0));

    for (const context of contexts) {
      if (context.rumbleStopTimer) {
        clearTimeout(context.rumbleStopTimer);
        context.rumbleStopTimer = null;
      }

      void this.writeRumbleState(context, weakLevel, strongLevel);

      if (duration > 0 && (weakLevel > 0 || strongLevel > 0)) {
        context.rumbleStopTimer = setTimeout(() => {
          context.rumbleStopTimer = null;
          void this.writeRumbleState(context, 0, 0);
        }, duration);
      }
    }

    return true;
  }

  supportsHapticsForActiveDevices() {
    const contexts = this.getActiveDeviceContexts();
    return contexts.some((context) => {
      return this.supportsHidHaptics(context);
    });
  }

  playHapticsForActiveDevices(
    frame: Int16Array | Int8Array | Uint8Array,
    gain?: unknown
  ) {
    const contexts = this.getActiveDeviceContexts();
    if (contexts.length < 1) {
      return false;
    }

    let queued = false;

    for (const context of contexts) {
      if (!this.supportsHidHaptics(context)) {
        continue;
      }

      const hapticPayload = toDualSenseHapticPayload(
        frame,
        gain,
        context.hapticQuantizationError
      );
      if (hapticPayload.length < 1) {
        continue;
      }

      this.enqueueHapticPayload(context, hapticPayload);
      this.scheduleQueuedHapticWrite(context);
      queued = true;
    }

    return queued;
  }

  applyLedColor(event: unknown) {
    const payload = (event || {}) as Record<string, unknown>;
    const color = parseByteArrayValue(payload.color);
    if (!color || color.length < 3) {
      return payload;
    }

    const activeContexts = this.getActiveDeviceContexts();
    for (const context of activeContexts) {
      if (
        context.outputState[44] === color[0] &&
        context.outputState[45] === color[1] &&
        context.outputState[46] === color[2]
      ) {
        continue;
      }

      void this.queueStateOutputWrite(
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

      for (const context of this.deviceContexts.values()) {
        void this.ensureDeviceOpen(context);
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
      hasInputState: false,
      inputState: createIdleDualSenseInputState(),
      rawTouchState: createIdleTouchState(),
      touchState: createIdleTouchState(),
      nextSessionTouchId: 0,
      activeSessionTouchIds: [null, null],
      outputState: createDefaultOutputState(),
      btOutputSeq: 0,
      outputReportBytes: collectOutputReportBytes(device),
      hapticPacketSeq: 0,
      hapticQuantizationError: [0, 0],
      hapticPrimed: false,
      hapticStreaming: false,
      pendingHapticSamples: [],
      pendingHapticRemainder: new Uint8Array(0),
      hapticWriteScheduled: false,
      hapticWriteTimer: null,
      hapticStopTimer: null,
      hapticNextWriteAtMs: 0,
      openPromise: null,
      pendingStateOutputPayload: null,
      stateOutputWriteScheduled: false,
      outputWriteChain: Promise.resolve(true),
      writeChain: Promise.resolve(true),
      rumbleStopTimer: null,
      inputReportHandler: (event) => {
        const nextInputState = parseDualSenseInputState(
          context.connectionType,
          event.reportId,
          event.data
        );
        context.lastInputReportId = Number(event.reportId) || 0;
        if (!nextInputState) {
          return;
        }

        if (!isSameTouchState(context.rawTouchState, nextInputState.touchState)) {
          context.rawTouchState = cloneTouchState(nextInputState.touchState);
          context.touchState = buildSessionTouchStateFromRaw(context, nextInputState.touchState);
        }

        const nextResolvedInputState: DualSenseInputState = {
          reportId: nextInputState.reportId,
          axes: nextInputState.axes,
          buttons: nextInputState.buttons,
          touchState: context.touchState,
        };
        const shouldUpdate =
          !context.hasInputState ||
          !isSameDualSenseInputState(context.inputState, nextResolvedInputState);
        context.hasInputState = true;
        if (!shouldUpdate) {
          return;
        }

        context.inputState = cloneDualSenseInputState(nextResolvedInputState);
        this.notifyListeners();
      },
    };

    device.addEventListener("inputreport", context.inputReportHandler);
    return context;
  }

  private disposeContext(context: DeviceContext) {
    context.device.removeEventListener("inputreport", context.inputReportHandler);
    if (context.rumbleStopTimer) {
      clearTimeout(context.rumbleStopTimer);
      context.rumbleStopTimer = null;
    }
    if (context.hapticStopTimer) {
      clearTimeout(context.hapticStopTimer);
      context.hapticStopTimer = null;
    }
    if (context.hapticWriteTimer) {
      clearTimeout(context.hapticWriteTimer);
      context.hapticWriteTimer = null;
    }
    context.inputState = createIdleDualSenseInputState();
    context.hasInputState = false;
    context.rawTouchState = createIdleTouchState();
    context.touchState = createIdleTouchState();
    context.nextSessionTouchId = 0;
    context.activeSessionTouchIds = [null, null];
    context.hapticPrimed = false;
    context.hapticStreaming = false;
    context.hapticPacketSeq = 0;
    context.hapticQuantizationError = [0, 0];
    context.pendingHapticSamples.length = 0;
    context.pendingHapticRemainder = new Uint8Array(0);
    context.hapticWriteScheduled = false;
    context.hapticWriteTimer = null;
    context.hapticNextWriteAtMs = 0;
    context.pendingStateOutputPayload = null;
    context.stateOutputWriteScheduled = false;
    context.outputWriteChain = Promise.resolve(true);
    context.writeChain = Promise.resolve(true);
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

    if (isGenericWirelessControllerGamepad(gamepad)) {
      const assignedDevice = this.assignedDevicesByGamepadIndex.get(gamepad.index);
      if (assignedDevice) {
        return assignedDevice === device;
      }

      return isDualSenseHidDevice(device) && this.deviceContexts.size === 1;
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

    if (!parsed && this.deviceContexts.size === 1 && isGenericWirelessControllerGamepad(gamepad)) {
      return Array.from(this.deviceContexts.keys())[0] || null;
    }

    return null;
  }

  private isDualSenseCandidateGamepad(gamepad: Gamepad | null | undefined) {
    if (isDualSenseLikeGamepad(gamepad)) {
      return true;
    }
    if (!isGenericWirelessControllerGamepad(gamepad)) {
      return false;
    }

    const assignedDevice = gamepad
      ? this.assignedDevicesByGamepadIndex.get(gamepad.index)
      : undefined;
    if (assignedDevice && this.deviceContexts.has(assignedDevice)) {
      return true;
    }

    return this.deviceContexts.size === 1;
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

    const inputContexts = Array.from(this.deviceContexts.values()).filter((context) => {
      return context.hasInputState || context.device.opened;
    });
    if (inputContexts.length > 0) {
      return inputContexts;
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

  private queueDeviceWrite(context: DeviceContext, task: () => Promise<boolean>) {
    const queuedTask = async () => {
      try {
        return await task();
      } catch {
        return false;
      }
    };

    context.writeChain = context.writeChain.then(queuedTask, queuedTask);
    return context.writeChain;
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

      return this.queueDeviceWrite(context, async () => {
        await this.sendOutputReport(context, payload);
        return true;
      });
    };

    context.outputWriteChain = context.outputWriteChain.then(task, task);
    return context.outputWriteChain;
  }

  private queueStateOutputWrite(
    context: DeviceContext,
    apply: (state: Uint8Array) => void,
    cleanup?: (state: Uint8Array) => void
  ) {
    const task = async () => {
      apply(context.outputState);
      context.pendingStateOutputPayload = context.outputState.slice();
      cleanup?.(context.outputState);
      this.scheduleQueuedStateOutputWrite(context);
      return true;
    };

    context.outputWriteChain = context.outputWriteChain.then(task, task);
    return context.outputWriteChain;
  }

  private scheduleQueuedStateOutputWrite(context: DeviceContext) {
    if (context.stateOutputWriteScheduled) {
      return;
    }

    context.stateOutputWriteScheduled = true;
    const task = async () => {
      try {
        while (context.pendingStateOutputPayload) {
          const payload = context.pendingStateOutputPayload;
          context.pendingStateOutputPayload = null;

          const opened = await this.ensureDeviceOpen(context);
          if (!opened) {
            return false;
          }

          const sent = await this.queueDeviceWrite(context, async () => {
            await this.sendOutputReport(context, payload);
            return true;
          });
          if (!sent) {
            return false;
          }
        }

        return true;
      } finally {
        context.stateOutputWriteScheduled = false;
        if (context.pendingStateOutputPayload) {
          this.scheduleQueuedStateOutputWrite(context);
        }
      }
    };

    void task();
  }

  private enqueueHapticSample(context: DeviceContext, hapticSample: Uint8Array) {
    if (context.hapticStopTimer) {
      clearTimeout(context.hapticStopTimer);
      context.hapticStopTimer = null;
    }

    if (context.pendingHapticSamples.length >= DUALSENSE_HAPTIC_MAX_PENDING_SAMPLES) {
      return;
    }

    context.pendingHapticSamples.push(hapticSample.slice());
    this.scheduleHapticStop(context);
  }

  private trimPendingHapticBacklog(context: DeviceContext) {
    let queuedAheadMs = context.pendingHapticSamples.reduce((total, sample) => {
      return total + getDualSenseHapticSampleDurationMs(sample.byteLength);
    }, getDualSenseHapticSampleDurationMs(context.pendingHapticRemainder.byteLength));

    // Haptics that are already tens of milliseconds late feel like aftershock.
    // Keep only a short playout-ahead window so stale PCM does not trail behind
    // the actual game event.
    while (
      queuedAheadMs > DUALSENSE_HAPTIC_MAX_PLAYAHEAD_MS &&
      context.pendingHapticSamples.length > 0
    ) {
      const droppedSample = context.pendingHapticSamples.shift();
      if (!droppedSample) {
        break;
      }
      queuedAheadMs -= getDualSenseHapticSampleDurationMs(droppedSample.byteLength);
    }
  }

  private getQueuedHapticSampleBytes(context: DeviceContext, availableBytes: number) {
    if (availableBytes <= 0) {
      return 0;
    }

    const layout = this.getHapticReportLayoutForSample(context, availableBytes);
    if (!layout || layout.sampleBytes <= 0) {
      return 0;
    }
    return Math.min(availableBytes, layout.sampleBytes);
  }

  private enqueueQueuedHapticBytes(context: DeviceContext, hapticBytes: Uint8Array) {
    let offset = 0;
    while (offset < hapticBytes.length) {
      const chunkBytes = this.getQueuedHapticSampleBytes(context, hapticBytes.length - offset);
      if (chunkBytes < 1) {
        break;
      }

      this.enqueueHapticSample(context, hapticBytes.subarray(offset, offset + chunkBytes));
      offset += chunkBytes;
    }

    return hapticBytes.slice(offset);
  }

  private enqueueHapticPayload(context: DeviceContext, hapticPayload: Uint8Array) {
    if (hapticPayload.length < 1) {
      return;
    }

    if (context.hapticStopTimer) {
      clearTimeout(context.hapticStopTimer);
      context.hapticStopTimer = null;
    }

    const combined = new Uint8Array(context.pendingHapticRemainder.length + hapticPayload.length);
    combined.set(context.pendingHapticRemainder, 0);
    combined.set(hapticPayload, context.pendingHapticRemainder.length);
    context.pendingHapticRemainder = this.enqueueQueuedHapticBytes(context, combined);
    this.trimPendingHapticBacklog(context);
    this.scheduleHapticStop(context);
  }

  private scheduleHapticStop(context: DeviceContext) {
    context.hapticStopTimer = setTimeout(() => {
      context.hapticStopTimer = null;

      if (context.pendingHapticSamples.length > 0 || context.hapticWriteScheduled) {
        this.scheduleHapticStop(context);
        return;
      }

      if (context.pendingHapticRemainder.length > 0) {
        const remainder = context.pendingHapticRemainder;
        context.pendingHapticRemainder = new Uint8Array(0);
        context.pendingHapticRemainder = this.enqueueQueuedHapticBytes(context, remainder);
        this.scheduleQueuedHapticWrite(context);
        if (context.pendingHapticRemainder.length > 0) {
          this.scheduleHapticStop(context);
        }
        return;
      }

      context.hapticQuantizationError = [0, 0];
      context.pendingHapticSamples.push(new Uint8Array(DUALSENSE_HAPTIC_SAMPLE_BYTES));
      this.scheduleQueuedHapticWrite(context);
    }, DUALSENSE_HAPTIC_IDLE_STOP_DELAY_MS);
  }

  private scheduleQueuedHapticWrite(context: DeviceContext) {
    if (context.hapticWriteScheduled || context.hapticWriteTimer) {
      return;
    }

    const now = getMonotonicTimeMs();
    const delayMs = Math.max(0, context.hapticNextWriteAtMs - now);
    if (delayMs > 1) {
      context.hapticWriteTimer = setTimeout(() => {
        context.hapticWriteTimer = null;
        this.scheduleQueuedHapticWrite(context);
      }, delayMs);
      return;
    }

    context.hapticWriteScheduled = true;
    const task = async () => {
      try {
        const opened = await this.ensureDeviceOpen(context);
        if (!opened) {
          context.hapticPrimed = false;
          context.hapticStreaming = false;
          context.hapticNextWriteAtMs = 0;
          return false;
        }

        const hapticSample = context.pendingHapticSamples.shift();
        if (!hapticSample) {
          return false;
        }

        const sendStartedAtMs = Math.max(getMonotonicTimeMs(), context.hapticNextWriteAtMs);
        const sampleDurationMs = getDualSenseHapticSampleDurationMs(hapticSample.byteLength);

        const sent = await this.queueDeviceWrite(context, async () => {
          if (!context.hapticPrimed) {
            const primed = await this.sendHapticPrimePacket(context);
            if (!primed) {
              context.hapticPrimed = false;
              return false;
            }
            context.hapticPrimed = true;
          }

          return this.sendHapticReport(context, hapticSample);
        });
        context.hapticStreaming = sent;
        if (!sent) {
          context.hapticPrimed = false;
          context.hapticNextWriteAtMs = 0;
        } else {
          context.hapticNextWriteAtMs = Math.max(
            sendStartedAtMs + sampleDurationMs,
            getMonotonicTimeMs()
          );
        }
        return sent;
      } catch {
        context.hapticPrimed = false;
        context.hapticStreaming = false;
        context.hapticNextWriteAtMs = 0;
        return false;
      } finally {
        context.hapticWriteScheduled = false;
        if (context.pendingHapticSamples.length > 0) {
          this.scheduleQueuedHapticWrite(context);
        }
      }
    };

    void task();
  }

  private writeRumbleState(context: DeviceContext, weakMotor: number, strongMotor: number) {
    return this.queueOutputWrite(context, (state) => {
      state[2] = clampByte(weakMotor);
      state[3] = clampByte(strongMotor);
      setBit(state, 0, 0, true);
      setBit(state, 0, 1, true);
    });
  }

  private async sendOutputReport(context: DeviceContext, outputState: Uint8Array) {
    const preferBluetooth =
      context.connectionType === "bluetooth" || context.lastInputReportId === DUALSENSE_INPUT_REPORT_BT;

    if (!preferBluetooth) {
      await context.device.sendReport(DUALSENSE_OUTPUT_REPORT_USB, outputState);
      if (context.hapticStreaming) {
        // Regular output can reset haptics routing on DualSense. Mark prime as
        // stale so the next haptics frame re-primes with current trigger state.
        context.hapticPrimed = false;
      }
      return;
    }

    const payload = new Uint8Array(DUALSENSE_OUTPUT_REPORT_BT_BYTES);
    payload[0] = (context.btOutputSeq & 0x0f) << 4;
    payload[1] = 0x10;
    payload.set(outputState, 2);
    fillDualSenseBluetoothOutputChecksum(DUALSENSE_OUTPUT_REPORT_BT, payload);
    context.btOutputSeq = (context.btOutputSeq + 1) & 0xff;
    await context.device.sendReport(DUALSENSE_OUTPUT_REPORT_BT, payload);
    if (context.hapticStreaming) {
      context.hapticPrimed = false;
    }
  }

  private hasOutputReport(context: DeviceContext, reportId: number, minBytes = 1) {
    const reportBytes = context.outputReportBytes.get(reportId);
    if (reportBytes === undefined) {
      return false;
    }
    return reportBytes >= minBytes;
  }

  private getHapticReportLayouts(context: DeviceContext): HapticReportLayout[] {
    const layouts: HapticReportLayout[] = [];
    for (const [reportId, reportBytes] of context.outputReportBytes) {
      if (
        reportId < DUALSENSE_HAPTIC_REPORT_ID ||
        reportId > DUALSENSE_HAPTIC_REPORT_ID_MAX ||
        reportBytes <= DUALSENSE_HAPTIC_REPORT_OVERHEAD_BYTES
      ) {
        continue;
      }

      layouts.push({
        reportId,
        reportBytes,
        sampleBytes: reportBytes - DUALSENSE_HAPTIC_REPORT_OVERHEAD_BYTES,
      });
    }

    return layouts.sort((left, right) => left.sampleBytes - right.sampleBytes);
  }

  private getHapticReportLayoutForSample(context: DeviceContext, sampleBytes: number) {
    const layouts = this.getHapticReportLayouts(context);
    if (layouts.length < 1) {
      return null;
    }

    const canonicalLayout = layouts.find((layout) => {
      return (
        layout.reportId === DUALSENSE_HAPTIC_REPORT_ID &&
        layout.reportBytes === DUALSENSE_HAPTIC_REPORT_BYTES &&
        layout.sampleBytes === DUALSENSE_HAPTIC_SAMPLE_BYTES
      );
    });
    if (canonicalLayout && sampleBytes <= canonicalLayout.sampleBytes) {
      return canonicalLayout;
    }

    for (const layout of layouts) {
      if (layout.sampleBytes >= sampleBytes) {
        return layout;
      }
    }

    return layouts[layouts.length - 1] || null;
  }

  private supportsHidHaptics(context: DeviceContext) {
    return this.getHapticReportLayouts(context).length > 0;
  }

  private setPrimeTriggerData(reportData: Uint8Array, commonOffset: number, outputState: Uint8Array) {
    reportData[commonOffset + 10] = outputState[10];
    reportData.set(outputState.subarray(11, 11 + DUALSENSE_TRIGGER_PARAM_BYTES), commonOffset + 11);
    reportData[commonOffset + 21] = outputState[21];
    reportData.set(outputState.subarray(22, 22 + DUALSENSE_TRIGGER_PARAM_BYTES), commonOffset + 22);
  }

  private async sendHapticPrimePacket(context: DeviceContext) {
    const preferBluetooth =
      context.connectionType === "bluetooth" || context.lastInputReportId === DUALSENSE_INPUT_REPORT_BT;

    if (
      preferBluetooth &&
      this.hasOutputReport(context, DUALSENSE_OUTPUT_REPORT_BT, DUALSENSE_OUTPUT_REPORT_BT_BYTES)
    ) {
      const payload = new Uint8Array(DUALSENSE_OUTPUT_REPORT_BT_BYTES);
      payload[0] = (context.btOutputSeq & 0x0f) << 4;
      payload[1] = 0x10;
      payload[2] = 0x0c;
      payload[3] = 0x40;
      this.setPrimeTriggerData(payload, 2, context.outputState);
      fillDualSenseBluetoothOutputChecksum(DUALSENSE_OUTPUT_REPORT_BT, payload);
      context.btOutputSeq = (context.btOutputSeq + 1) & 0xff;
      await context.device.sendReport(DUALSENSE_OUTPUT_REPORT_BT, payload);
      return true;
    }

    if (!this.hasOutputReport(context, DUALSENSE_OUTPUT_REPORT_USB, DUALSENSE_OUTPUT_STATE_BYTES)) {
      return false;
    }
    const payload = new Uint8Array(DUALSENSE_OUTPUT_STATE_BYTES);
    payload[0] = 0x0c;
    payload[1] = 0x40;
    this.setPrimeTriggerData(payload, 0, context.outputState);
    await context.device.sendReport(DUALSENSE_OUTPUT_REPORT_USB, payload);
    return true;
  }

  private async sendHapticReport(context: DeviceContext, hapticSample: Uint8Array) {
    if (!this.supportsHidHaptics(context)) {
      return false;
    }

    const layout = this.getHapticReportLayoutForSample(context, hapticSample.byteLength);
    if (!layout) {
      return false;
    }

    const report = new Uint8Array(layout.reportBytes);
    report[0] = 0x00;
    report[1] = 0x91;
    report[2] = 0x07;
    report[3] = 0xfe;
    report[8] = 0xff;
    report[9] = context.hapticPacketSeq;
    context.hapticPacketSeq = (context.hapticPacketSeq + 1) & 0xff;
    report[10] = 0x92;
    report[11] = hapticSample.byteLength;
    report.set(hapticSample.subarray(0, layout.sampleBytes), 12);
    fillDualSenseBluetoothOutputChecksum(layout.reportId, report);

    try {
      await context.device.sendReport(layout.reportId, report);
      return true;
    } catch {
      return false;
    }
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

export const getDualSenseInputStateForGamepad = (gamepad: Gamepad | null | undefined) => {
  return bridge.getInputStateForGamepad(gamepad);
};

export const getDualSenseHidInputStates = () => {
  return bridge.getInputStates();
};

export const isDualSenseHidManagedGamepad = (gamepad: Gamepad | null | undefined) => {
  return bridge.isManagedGamepad(gamepad);
};

export const playDualSenseHidRumbleForGamepad = (
  gamepad: Gamepad | null | undefined,
  weakMotor: unknown,
  strongMotor: unknown,
  durationMs: unknown
) => {
  return bridge.playRumbleForGamepad(gamepad, weakMotor, strongMotor, durationMs);
};

export const playDualSenseHidRumbleForActiveDevices = (
  weakMotor: unknown,
  strongMotor: unknown,
  durationMs: unknown
) => {
  return bridge.playRumbleForActiveDevices(weakMotor, strongMotor, durationMs);
};

export const supportsDualSenseHidHapticsForActiveDevices = () => {
  return bridge.supportsHapticsForActiveDevices();
};

export const playDualSenseHidHapticsForActiveDevices = (
  frame: Int16Array | Int8Array | Uint8Array,
  gain?: unknown
) => {
  return bridge.playHapticsForActiveDevices(frame, gain);
};

export const requestDualSenseHidAccessIfNeeded = () => {
  return bridge.requestAccessIfNeeded();
};

export const applyDualSenseTriggerEffectsFromPeasyo = (event: unknown) => {
  return bridge.applyTriggerEffects(event);
};

export const applyDualSenseLedColorFromPeasyo = (event: unknown) => {
  return bridge.applyLedColor(event);
};

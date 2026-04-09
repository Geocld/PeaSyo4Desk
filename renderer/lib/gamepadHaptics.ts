import {
  playDualSenseHidHapticsForActiveDevices,
  supportsDualSenseHidHapticsForActiveDevices,
} from "./dualsenseHid";

type ChiakiHapticAudioEvent = {
  dataBase64?: string;
  data?: unknown;
  hapticFrameSeq?: number;
};

export type GamepadHapticsSettings = {
  enabled?: boolean;
  gain?: number;
};

const isHapticsEnabled = (settings?: GamepadHapticsSettings) => {
  return settings?.enabled === true;
};

export const canUseDualSenseGamepadHaptics = (settings?: GamepadHapticsSettings) => {
  return isHapticsEnabled(settings) && supportsDualSenseHidHapticsForActiveDevices();
};

const clampByte = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.trunc(numeric)));
};

const parseByteArrayValue = (value: unknown) => {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value.map((item) => clampByte(item)));
  }

  if (typeof value === "string") {
    const prefixedMatch = value.match(/^Buffer\((\d+)\):([0-9a-f]+)$/i);
    if (!prefixedMatch) {
      return null;
    }

    const expectedLength = Number(prefixedMatch[1]);
    const hex = prefixedMatch[2];
    const bytes = new Uint8Array(Math.floor(hex.length / 2));
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes.subarray(0, expectedLength);
  }

  return null;
};

const decodeBase64ToBytes = (base64: string) => {
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    try {
      const buffer = Buffer.from(base64, "base64");
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice();
    } catch {
      // Fall back to atob when Buffer is unavailable or rejects the payload.
    }
  }

  if (typeof atob !== "function") {
    return null;
  }

  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index) & 0xff;
    }
    return bytes;
  } catch {
    return null;
  }
};

const normalizeHapticPcm = (event: ChiakiHapticAudioEvent) => {
  if (typeof event?.dataBase64 === "string" && event.dataBase64.length > 0) {
    const decoded = decodeBase64ToBytes(event.dataBase64);
    if (decoded && decoded.byteLength >= 4) {
      return decoded;
    }
  }

  const raw = parseByteArrayValue(event?.data);
  if (raw && raw.byteLength >= 4) {
    return raw;
  }

  return null;
};

export const triggerGamepadHapticsFromChiaki = (
  event: unknown,
  settings?: GamepadHapticsSettings
) => {
  if (!canUseDualSenseGamepadHaptics(settings)) {
    return false;
  }

  const payload = (event || {}) as ChiakiHapticAudioEvent;
  const pcmBytes = normalizeHapticPcm(payload);
  if (!pcmBytes) {
    return false;
  }

  return playDualSenseHidHapticsForActiveDevices(pcmBytes, settings?.gain ?? 0.5);
};

import {
  isDualSenseHidManagedGamepad,
  playDualSenseHidRumbleForActiveDevices,
} from "./dualsenseHid";
import Ipc from "./ipc";

type PeasyoRumbleEvent = {
  left?: number;
  right?: number;
  peakLeft?: number;
  peakRight?: number;
};

export type GamepadRumbleSettings = {
  enabled?: boolean;
  intensity?: number;
};

type PlayEffectOptions = {
  startDelay?: number;
  duration: number;
  weakMagnitude: number;
  strongMagnitude: number;
};

type GamepadVibrationActuatorLike = {
  playEffect?: (type: string, params: PlayEffectOptions) => Promise<unknown> | unknown;
};

type GamepadHapticActuatorLike = {
  pulse?: (value: number, duration: number) => Promise<unknown> | unknown;
};

export const GAMEPAD_RUMBLE_CONFIG = {
  minIntervalMs: 28,
  minDurationMs: 25,
  maxDurationMs: 80,
  hidMinDurationMs: 18,
  hidMaxDurationMs: 52,
  hidMotorScale: 0.68,
  masterGain: 0.48,
  strongScale: 0.55,
  weakScale: 0.45,
  gamma: 1.6,
} as const;

const DEFAULT_RUMBLE_INTENSITY = 3 as const;
const RUMBLE_INTENSITY_GAINS = {
  1: 0.35,
  2: 0.6,
  3: 1,
  4: 1.2,
  5: 1.4,
} as const;

let lastRumbleAtMs = 0;

const clamp01 = (value: number) => {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};

const resolveRumbleIntensityLevel = (
  value: unknown
): keyof typeof RUMBLE_INTENSITY_GAINS => {
  const numeric = Math.round(Number(value));
  if (numeric >= 1 && numeric <= 5) {
    return numeric as keyof typeof RUMBLE_INTENSITY_GAINS;
  }
  return DEFAULT_RUMBLE_INTENSITY;
};

const resolveRumbleIntensityGain = (settings?: GamepadRumbleSettings) => {
  const level = resolveRumbleIntensityLevel(settings?.intensity);
  return RUMBLE_INTENSITY_GAINS[level];
};

const isRumbleEnabled = (settings?: GamepadRumbleSettings) => {
  return settings?.enabled !== false;
};

const tuneRumbleMagnitude = (
  rawMagnitude: number,
  channelScale: number,
  intensityGain: number
) => {
  const compressed = Math.pow(clamp01(rawMagnitude), GAMEPAD_RUMBLE_CONFIG.gamma);
  return clamp01(
    compressed * GAMEPAD_RUMBLE_CONFIG.masterGain * channelScale * intensityGain
  );
};

const toRumbleMagnitude = (rawValue: unknown, rawPeak: unknown) => {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const peak = Number(rawPeak);
  if (Number.isFinite(peak) && peak > 0) {
    return clamp01(value / peak);
  }

  if (value > 1) {
    return clamp01(value / 255);
  }

  return clamp01(value);
};

const toRumbleMotorByte = (rawValue: unknown, rawPeak: unknown) => {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const peak = Number(rawPeak);
  if (Number.isFinite(peak) && peak > 0) {
    return Math.max(0, Math.min(255, Math.round((value / peak) * 255)));
  }

  if (value > 1) {
    return Math.max(0, Math.min(255, Math.round(value)));
  }

  return Math.max(0, Math.min(255, Math.round(value * 255)));
};

const scaleRumbleMotorByte = (value: number, scale: number) => {
  if (value <= 0 || scale <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(value * scale)));
};

const scaleNativeRumbleMagnitude = (value: number, intensityGain: number) => {
  return clamp01(value * intensityGain);
};

const durationFromMagnitude = (magnitude: number) => {
  return (
    GAMEPAD_RUMBLE_CONFIG.minDurationMs +
    Math.round(
      (GAMEPAD_RUMBLE_CONFIG.maxDurationMs - GAMEPAD_RUMBLE_CONFIG.minDurationMs) *
        clamp01(magnitude)
    )
  );
};

const isValidStreamGamepad = (gamepad: Gamepad | null): gamepad is Gamepad => {
  return !!gamepad && gamepad.connected && Array.isArray(gamepad.axes) && gamepad.axes.length === 4;
};

const consumePromiseLike = (value: unknown) => {
  if (value && typeof (value as Promise<unknown>).catch === "function") {
    (value as Promise<unknown>).catch(() => undefined);
  }
};

const playViaVibrationActuator = (
  gamepad: Gamepad,
  weakMagnitude: number,
  strongMagnitude: number,
  duration: number
) => {
  const actuator = (gamepad as Gamepad & { vibrationActuator?: GamepadVibrationActuatorLike })
    .vibrationActuator;
  if (!actuator || typeof actuator.playEffect !== "function") {
    return false;
  }

  try {
    const maybePromise = actuator.playEffect("dual-rumble", {
      startDelay: 0,
      duration,
      weakMagnitude,
      strongMagnitude,
    });
    consumePromiseLike(maybePromise);
    return true;
  } catch {
    return false;
  }
};

const playViaHapticActuators = (gamepad: Gamepad, magnitude: number, duration: number) => {
  const actuators = (
    gamepad as Gamepad & {
      hapticActuators?: GamepadHapticActuatorLike[];
    }
  ).hapticActuators;

  if (!Array.isArray(actuators) || actuators.length < 1) {
    return false;
  }

  let played = false;
  for (const actuator of actuators) {
    if (!actuator || typeof actuator.pulse !== "function") {
      continue;
    }
    try {
      const maybePromise = actuator.pulse(magnitude, duration);
      consumePromiseLike(maybePromise);
      played = true;
    } catch {
      // ignore
    }
  }
  return played;
};

export const triggerGamepadRumbleFromPeasyo = (
  event: unknown,
  settings?: GamepadRumbleSettings
) => {
  if (!isRumbleEnabled(settings)) {
    return false;
  }

  const now = Date.now();
  if (now - lastRumbleAtMs < GAMEPAD_RUMBLE_CONFIG.minIntervalMs) {
    return false;
  }

  const rumble = (event || {}) as PeasyoRumbleEvent;
  const intensityGain = resolveRumbleIntensityGain(settings);
  const strongMagnitude = tuneRumbleMagnitude(
    toRumbleMagnitude(rumble.left, rumble.peakLeft),
    GAMEPAD_RUMBLE_CONFIG.strongScale,
    intensityGain
  );
  const weakMagnitude = tuneRumbleMagnitude(
    toRumbleMagnitude(rumble.right, rumble.peakRight),
    GAMEPAD_RUMBLE_CONFIG.weakScale,
    intensityGain
  );
  const strongMotor = toRumbleMotorByte(rumble.left, rumble.peakLeft);
  const weakMotor = toRumbleMotorByte(rumble.right, rumble.peakRight);
  const maxMagnitude = Math.max(strongMagnitude, weakMagnitude);
  if (maxMagnitude <= 0 && strongMotor <= 0 && weakMotor <= 0) {
    return false;
  }

  const duration = durationFromMagnitude(maxMagnitude);
  const hidStrongMotor = scaleRumbleMotorByte(
    strongMotor,
    GAMEPAD_RUMBLE_CONFIG.hidMotorScale * intensityGain
  );
  const hidWeakMotor = scaleRumbleMotorByte(
    weakMotor,
    GAMEPAD_RUMBLE_CONFIG.hidMotorScale * intensityGain
  );
  const hidDurationMagnitude = Math.max(hidStrongMotor, hidWeakMotor) / 255;
  const hidDuration =
    GAMEPAD_RUMBLE_CONFIG.hidMinDurationMs +
    Math.round(
      (GAMEPAD_RUMBLE_CONFIG.hidMaxDurationMs - GAMEPAD_RUMBLE_CONFIG.hidMinDurationMs) *
        hidDurationMagnitude
    );

  let played = playDualSenseHidRumbleForActiveDevices(
    hidWeakMotor,
    hidStrongMotor,
    hidDuration
  );

  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
    if (played) {
      lastRumbleAtMs = now;
    }
    return played;
  }

  const gamepads = navigator.getGamepads();

  for (const gamepad of gamepads) {
    if (!isValidStreamGamepad(gamepad)) {
      continue;
    }

    if (isDualSenseHidManagedGamepad(gamepad)) {
      continue;
    }

    const viaDualRumble = playViaVibrationActuator(
      gamepad,
      weakMagnitude,
      strongMagnitude,
      duration
    );
    if (viaDualRumble) {
      played = true;
      continue;
    }

    const viaPulse = playViaHapticActuators(gamepad, maxMagnitude, duration);
    if (viaPulse) {
      played = true;
    }
  }

  if (played) {
    lastRumbleAtMs = now;
  }

  return played;
};

export const triggerNativeGamepadRumbleFromPeasyo = async (
  event: unknown,
  settings?: GamepadRumbleSettings
) => {
  if (!isRumbleEnabled(settings)) {
    return false;
  }

  const rumble = (event || {}) as PeasyoRumbleEvent;
  const intensityGain = resolveRumbleIntensityGain(settings);
  const high = scaleNativeRumbleMagnitude(
    toRumbleMagnitude(rumble.left, rumble.peakLeft),
    intensityGain
  );
  const low = scaleNativeRumbleMagnitude(
    toRumbleMagnitude(rumble.right, rumble.peakRight),
    intensityGain
  );
  const durationMagnitude = Math.max(high, low);
  if (durationMagnitude <= 0) {
    return false;
  }

  const duration = durationFromMagnitude(durationMagnitude);

  try {
    await Ipc.send("app", "triggerStreamNativeGamepadRumble", {
      low,
      high,
      durationMs: duration,
    });
    lastRumbleAtMs = Date.now();
    return true;
  } catch {
    return false;
  }
};

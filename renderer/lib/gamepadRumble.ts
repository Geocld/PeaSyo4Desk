import { playDualSenseHidRumbleForGamepad } from "./dualsenseHid";

type ChiakiRumbleEvent = {
  left?: number;
  right?: number;
  peakLeft?: number;
  peakRight?: number;
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

let lastRumbleAtMs = 0;

const clamp01 = (value: number) => {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};

const tuneRumbleMagnitude = (rawMagnitude: number, channelScale: number) => {
  const compressed = Math.pow(clamp01(rawMagnitude), GAMEPAD_RUMBLE_CONFIG.gamma);
  return clamp01(
    compressed * GAMEPAD_RUMBLE_CONFIG.masterGain * channelScale
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

export const triggerGamepadRumbleFromChiaki = (event: unknown) => {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
    return false;
  }

  const now = Date.now();
  if (now - lastRumbleAtMs < GAMEPAD_RUMBLE_CONFIG.minIntervalMs) {
    return false;
  }

  const rumble = (event || {}) as ChiakiRumbleEvent;
  const strongMagnitude = tuneRumbleMagnitude(
    toRumbleMagnitude(rumble.left, rumble.peakLeft),
    GAMEPAD_RUMBLE_CONFIG.strongScale
  );
  const weakMagnitude = tuneRumbleMagnitude(
    toRumbleMagnitude(rumble.right, rumble.peakRight),
    GAMEPAD_RUMBLE_CONFIG.weakScale
  );
  const strongMotor = toRumbleMotorByte(rumble.left, rumble.peakLeft);
  const weakMotor = toRumbleMotorByte(rumble.right, rumble.peakRight);
  const maxMagnitude = Math.max(strongMagnitude, weakMagnitude);
  const maxMotorMagnitude = Math.max(strongMotor, weakMotor) / 255;
  const durationMagnitude = Math.max(maxMagnitude, maxMotorMagnitude);
  if (durationMagnitude <= 0) {
    return false;
  }

  const duration =
    GAMEPAD_RUMBLE_CONFIG.minDurationMs +
    Math.round(
      (GAMEPAD_RUMBLE_CONFIG.maxDurationMs - GAMEPAD_RUMBLE_CONFIG.minDurationMs) *
        durationMagnitude
    );
  const hidDuration =
    GAMEPAD_RUMBLE_CONFIG.hidMinDurationMs +
    Math.round(
      (GAMEPAD_RUMBLE_CONFIG.hidMaxDurationMs - GAMEPAD_RUMBLE_CONFIG.hidMinDurationMs) *
        durationMagnitude
    );
  const hidStrongMotor = scaleRumbleMotorByte(
    strongMotor,
    GAMEPAD_RUMBLE_CONFIG.hidMotorScale
  );
  const hidWeakMotor = scaleRumbleMotorByte(
    weakMotor,
    GAMEPAD_RUMBLE_CONFIG.hidMotorScale
  );

  const gamepads = navigator.getGamepads();
  let played = false;

  for (const gamepad of gamepads) {
    if (!isValidStreamGamepad(gamepad)) {
      continue;
    }

    const viaDualSenseHid = playDualSenseHidRumbleForGamepad(
      gamepad,
      hidWeakMotor,
      hidStrongMotor,
      hidDuration
    );
    if (viaDualSenseHid) {
      played = true;
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

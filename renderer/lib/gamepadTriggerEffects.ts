import { applyDualSenseTriggerEffectsFromPeasyo } from "./dualsenseHid";

type PeasyoTriggerEffectsEvent = {
  typeLeft?: number;
  typeRight?: number;
  left?: Uint8Array;
  right?: Uint8Array;
};

export const handleGamepadTriggerEffectsFromPeasyo = (event: unknown) => {
  const payload = (event || {}) as PeasyoTriggerEffectsEvent;
  applyDualSenseTriggerEffectsFromPeasyo(payload);
  return payload;
};

import { applyDualSenseTriggerEffectsFromChiaki } from "./dualsenseHid";

type ChiakiTriggerEffectsEvent = {
  typeLeft?: number;
  typeRight?: number;
  left?: Uint8Array;
  right?: Uint8Array;
};

export const handleGamepadTriggerEffectsFromChiaki = (event: unknown) => {
  const payload = (event || {}) as ChiakiTriggerEffectsEvent;
  applyDualSenseTriggerEffectsFromChiaki(payload);
  return payload;
};

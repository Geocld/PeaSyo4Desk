import { applyDualSenseLedColorFromChiaki } from "./dualsenseHid";

type ChiakiLedColorEvent = {
  color?: Uint8Array;
};

export const handleGamepadLedColorFromChiaki = (event: unknown) => {
  const payload = (event || {}) as ChiakiLedColorEvent;
  applyDualSenseLedColorFromChiaki(payload);
  return payload;
};

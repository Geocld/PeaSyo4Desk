import { applyDualSenseLedColorFromPeasyo } from "./dualsenseHid";

type PeasyoLedColorEvent = {
  color?: Uint8Array;
};

export const handleGamepadLedColorFromPeasyo = (event: unknown) => {
  const payload = (event || {}) as PeasyoLedColorEvent;
  applyDualSenseLedColorFromPeasyo(payload);
  return payload;
};

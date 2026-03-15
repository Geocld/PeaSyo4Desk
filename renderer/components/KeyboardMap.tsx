import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { Button, Card, CardBody } from "@heroui/react";
import { useTranslation } from "next-i18next";
import { useSettings } from "../context/userContext";
import { defaultSettings } from "../context/userContext.defaults";

const DEFAULT_KEYBOARD_MAPPING = defaultSettings.input_mousekeyboard_maping;

const MAPPABLE_BUTTONS = [
  { value: "DPadUp", label: "DPad Up" },
  { value: "DPadDown", label: "DPad Down" },
  { value: "DPadLeft", label: "DPad Left" },
  { value: "DPadRight", label: "DPad Right" },
  { value: "A", label: "Cross" },
  { value: "B", label: "Circle" },
  { value: "X", label: "Square" },
  { value: "Y", label: "Triangle" },
  { value: "View", label: "Share" },
  { value: "Menu", label: "Options" },
  { value: "Nexus", label: "PS Button" },
  { value: "Touchpad", label: "Touchpad Press" },
  { value: "LeftShoulder", label: "L1" },
  { value: "RightShoulder", label: "R1" },
  { value: "LeftTrigger", label: "L2" },
  { value: "RightTrigger", label: "R2" },
  { value: "LeftThumb", label: "L3" },
  { value: "RightThumb", label: "R3" },
  { value: "LeftThumbXAxisPlus", label: "Left Stick Left" },
  { value: "LeftThumbXAxisMinus", label: "Left Stick Right" },
  { value: "LeftThumbYAxisPlus", label: "Left Stick Up" },
  { value: "LeftThumbYAxisMinus", label: "Left Stick Down" },
  { value: "RightThumbXAxisPlus", label: "Right Stick Left" },
  { value: "RightThumbXAxisMinus", label: "Right Stick Right" },
  { value: "RightThumbYAxisPlus", label: "Right Stick Up" },
  { value: "RightThumbYAxisMinus", label: "Right Stick Down" },
];

const LEGACY_TOUCHPAD_KEY = "t";
const LEGACY_RIGHT_STICK_UP_KEY = "r";

const applyKeyboardMappingDefaults = (mapping: Record<string, string>) => {
  const nextMapping = { ...DEFAULT_KEYBOARD_MAPPING, ...mapping };
  const rawTouchpadBinding = mapping[LEGACY_TOUCHPAD_KEY];
  const hasTouchpadBinding = Object.values(mapping).includes("Touchpad");
  const hasRightStickUpBindingOnOtherKey = Object.entries(mapping).some(
    ([key, action]) =>
      key !== LEGACY_TOUCHPAD_KEY && action === "RightThumbYAxisPlus"
  );

  if (!hasTouchpadBinding) {
    if (
      rawTouchpadBinding === "RightThumbYAxisPlus" &&
      !hasRightStickUpBindingOnOtherKey
    ) {
      nextMapping[LEGACY_RIGHT_STICK_UP_KEY] = "RightThumbYAxisPlus";
      delete nextMapping[LEGACY_TOUCHPAD_KEY];
    } else if (rawTouchpadBinding && rawTouchpadBinding !== "Touchpad") {
      return nextMapping;
    }

    nextMapping[LEGACY_TOUCHPAD_KEY] = "Touchpad";
  }

  return nextMapping;
};

const normalizeKeyboardMapping = (value: unknown) => {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_KEYBOARD_MAPPING };
  }

  const nextMapping: Record<string, string> = {};
  for (const [key, action] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key === "string" && typeof action === "string") {
      nextMapping[key] = action;
    }
  }
  return applyKeyboardMappingDefaults(nextMapping);
};

const invertKeyboardMapping = (mapping: Record<string, string>) => {
  const result: Record<string, string> = {};
  for (const [key, action] of Object.entries(mapping)) {
    result[action] = key;
  }
  return result;
};

function KeyboardMap() {
  const { settings, setSettings } = useSettings();
  const { t } = useTranslation("settings");
  const [controllerKeys, setControllerKeys] = useState<Record<string, string>>(() =>
    normalizeKeyboardMapping(settings.input_mousekeyboard_maping)
  );

  useEffect(() => {
    setControllerKeys(normalizeKeyboardMapping(settings.input_mousekeyboard_maping));
  }, [settings.input_mousekeyboard_maping]);

  const keyConfigs = useMemo(
    () => invertKeyboardMapping(controllerKeys),
    [controllerKeys]
  );

  const saveKeyboardMapping = (nextMapping: Record<string, string>) => {
    setControllerKeys(nextMapping);
    setSettings({
      ...settings,
      input_mousekeyboard_maping: nextMapping,
    });
  };

  const setKeyConfig = (
    button: string,
    event: KeyboardEvent<HTMLInputElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const pressedKey = event.key;
    if (!pressedKey) {
      return;
    }

    const nextMapping = { ...controllerKeys };
    for (const [key, action] of Object.entries(nextMapping)) {
      if (action === button || key === pressedKey) {
        delete nextMapping[key];
      }
    }

    if (pressedKey !== "Backspace") {
      nextMapping[pressedKey] = button;
    }

    saveKeyboardMapping(nextMapping);
    event.currentTarget.blur();
  };

  const handleReset = () => {
    saveKeyboardMapping({ ...DEFAULT_KEYBOARD_MAPPING });
  };

  return (
    <Card className="setting-item">
      <CardBody>
        <div className="setting-title text-foreground">{t("Keyboard mapping")}</div>
        <div className="setting-description text-default-500">
          {t("Config keyboard key mapping")}
        </div>
        <div className="setting-description text-default-400">
          {t("Press a key to bind it. Press Backspace to clear the current binding.")}
        </div>

        <div className="mt-4 space-y-3">
          {MAPPABLE_BUTTONS.map((item) => (
            <div
              key={item.value}
              className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <label className="text-sm font-medium text-foreground sm:min-w-[160px]">
                {item.label}
              </label>
              <input
                type="text"
                readOnly
                onKeyDown={(event) => setKeyConfig(item.value, event)}
                value={keyConfigs[item.value] ?? "None"}
                className="w-full rounded-lg border border-divider bg-content2 px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 sm:w-48"
              />
            </div>
          ))}
        </div>

        <div className="mt-4 flex justify-end">
          <Button color="primary" onPress={handleReset}>
            {t("Reset")}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

export default KeyboardMap;

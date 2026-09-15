import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { Button, Card, CardBody } from "@heroui/react";
import { useTranslation } from "next-i18next";
import { useSettings } from "../context/userContext";
import {
  DEFAULT_KEYBOARD_MAPPING,
  invertKeyboardMapping,
  normalizeKeyboardMapping,
} from "../common/keyboardMapping";

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

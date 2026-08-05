import { useState } from "react";
import { useTranslation } from "next-i18next";
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  Radio,
  RadioGroup,
  Slider,
  Switch,
} from "@heroui/react";
import Ipc from "../lib/ipc";

const CONNECTED = "connected";

type TouchpadPosition = "top" | "center" | "bottom";

type ActionBarProps = {
  type?: string;
  connectState?: string;
  audioMuted?: boolean;
  microphoneEnabled?: boolean;
  brightnessLabel?: string;
  fsrLabel?: string;
  disconnectAndStandby?: boolean;
  touchpadPosition?: TouchpadPosition;
  touchpadScale?: number;
  touchpadOpacity?: number;
  onTogglePerformance?: () => void;
  onPressPs?: () => void;
  onLongPressPs?: () => void;
  onAudio?: () => void;
  onMicrophone?: () => void;
  onAdjustBrightness?: () => void;
  onAdjustFsr?: () => void;
  onDisconnect?: () => void;
  onDisconnectAndStandbyChange?: (enabled: boolean) => void;
  onTouchpadPositionChange?: (position: TouchpadPosition) => void;
  onTouchpadScaleChange?: (value: number | number[]) => void;
  onTouchpadOpacityChange?: (value: number | number[]) => void;
  onDrawerOpenChange?: (open: boolean) => void;
};

function ActionBar(props: ActionBarProps) {
  const { t } = useTranslation("stream");
  const [drawerOpen, setDrawerOpen] = useState(false);

  const isConnected = props.connectState === CONNECTED;

  const setDrawerVisibility = (open: boolean) => {
    setDrawerOpen(open);
    props.onDrawerOpenChange?.(open);
  };

  const closeDrawer = () => {
    setDrawerVisibility(false);
  };

  const runAndClose = (callback?: () => void) => {
    closeDrawer();
    callback && callback();
  };

  const handleToggleFullscreen = () => {
    runAndClose(() => {
      Ipc.send("app", "toggleFullscreen");
    });
  };

  const normalizedTouchpadScale = Number.isFinite(Number(props.touchpadScale))
    ? Math.max(0.5, Math.min(2, Number(props.touchpadScale)))
    : 1;
  const normalizedTouchpadOpacity = Number.isFinite(Number(props.touchpadOpacity))
    ? Math.max(0, Math.min(0.8, Number(props.touchpadOpacity)))
    : 0.6;
  const touchpadPosition = props.touchpadPosition || "center";

  return (
    <div id="actionBar">
      <Button
        variant="bordered"
        size="sm"
        style={{ color: "#fff" }}
        onPress={() => setDrawerVisibility(true)}
      >
        {t("Menu")}
      </Button>

      <Drawer isOpen={drawerOpen} onOpenChange={setDrawerVisibility} placement="right" size="xs">
        <DrawerContent className="h-[100dvh] max-h-[100dvh] overflow-hidden text-sm">
          <>
            <DrawerBody className="h-full min-h-0 overflow-hidden p-0">
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3">
                  <div className="flex flex-col gap-3 pb-3">
                    {isConnected && props.onTogglePerformance ? (
                      <Button
                        size="sm"
                        variant="flat"
                        className="justify-center"
                        onPress={() => runAndClose(props.onTogglePerformance)}
                      >
                        {t("Toggle Performance")}
                      </Button>
                    ) : null}

                    {isConnected && props.onPressPs ? (
                      <Button
                        size="sm"
                        variant="flat"
                        className="justify-center"
                        onPress={() => runAndClose(props.onPressPs)}
                      >
                        {t("Press PS Button")}
                      </Button>
                    ) : null}

                    {isConnected && props.type !== "cloud" && props.onLongPressPs ? (
                      <Button
                        size="sm"
                        variant="flat"
                        className="justify-center"
                        onPress={() => runAndClose(props.onLongPressPs)}
                      >
                        {t("Long press PS Button")}
                      </Button>
                    ) : null}

                    {isConnected && props.onAudio ? (
                      <Button
                        size="sm"
                        variant="flat"
                        className="justify-center"
                        onPress={() => runAndClose(props.onAudio)}
                      >
                        {props.audioMuted ? t("Open Audio") : t("Close Audio")}
                      </Button>
                    ) : null}

                    {isConnected && props.onMicrophone ? (
                      <Button
                        size="sm"
                        variant="flat"
                        className="justify-center"
                        onPress={() => runAndClose(props.onMicrophone)}
                      >
                        {props.microphoneEnabled ? t("Close Microphone") : t("Open Microphone")}
                      </Button>
                    ) : null}

                    {isConnected && props.onAdjustBrightness ? (
                      <Button
                        size="sm"
                        variant="flat"
                        className="justify-center"
                        onPress={() => runAndClose(props.onAdjustBrightness)}
                      >
                        {props.brightnessLabel || t("Brightness")}
                      </Button>
                    ) : null}

                    {isConnected && props.onAdjustFsr ? (
                      <Button
                        size="sm"
                        variant="flat"
                        className="justify-center"
                        onPress={() => runAndClose(props.onAdjustFsr)}
                      >
                        {props.fsrLabel || t("FSR")}
                      </Button>
                    ) : null}

                    <Button size="sm" variant="flat" className="justify-center" onPress={handleToggleFullscreen}>
                      {t("Toggle fullscreen")}
                    </Button>

                    {isConnected && props.onTouchpadPositionChange ? (
                      <div className="rounded-lg border border-default-200 p-3">
                        <RadioGroup
                          label={t("Touchpad position")}
                          orientation="horizontal"
                          size="sm"
                          value={touchpadPosition}
                          onValueChange={(value) =>
                            props.onTouchpadPositionChange &&
                            props.onTouchpadPositionChange(value as TouchpadPosition)
                          }
                        >
                          <Radio value="top">{t("Top")}</Radio>
                          <Radio value="center">{t("Center")}</Radio>
                          <Radio value="bottom">{t("Bottom")}</Radio>
                        </RadioGroup>
                      </div>
                    ) : null}

                    {isConnected && props.onTouchpadScaleChange ? (
                      <div className="rounded-lg border border-default-200 p-3">
                        <Slider
                          label={t("Touchpad size")}
                          size="sm"
                          step={0.05}
                          minValue={0.5}
                          maxValue={2}
                          value={normalizedTouchpadScale}
                          onChange={props.onTouchpadScaleChange}
                        />
                        <div className="mt-1 flex items-center justify-between text-xs text-default-400">
                          <span>0.5x</span>
                          <span>{normalizedTouchpadScale.toFixed(2)}x</span>
                          <span>2.0x</span>
                        </div>
                      </div>
                    ) : null}

                    {isConnected && props.onTouchpadOpacityChange ? (
                      <div className="rounded-lg border border-default-200 p-3">
                        <Slider
                          label={t("Touchpad opacity")}
                          size="sm"
                          step={0.05}
                          minValue={0}
                          maxValue={0.8}
                          value={normalizedTouchpadOpacity}
                          onChange={props.onTouchpadOpacityChange}
                        />
                        <div className="mt-1 flex items-center justify-between text-xs text-default-400">
                          <span>0.00</span>
                          <span>{normalizedTouchpadOpacity.toFixed(2)}</span>
                          <span>0.80</span>
                        </div>
                      </div>
                    ) : null}

                  </div>
                </div>

                <div
                  className="shrink-0 border-t border-default-200 bg-content1 p-3"
                  style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
                >
                  <div className="flex flex-col gap-3">
                    {isConnected && props.onDisconnectAndStandbyChange ? (
                      <div className="rounded-lg border border-default-200 p-3">
                        <Switch
                          size="sm"
                          isSelected={!!props.disconnectAndStandby}
                          onValueChange={props.onDisconnectAndStandbyChange}
                        >
                          {t("Standby on disconnect")}
                        </Switch>
                      </div>
                    ) : null}

                    {props.onDisconnect ? (
                      <Button
                        size="sm"
                        color="danger"
                        className="justify-center"
                        onPress={() => runAndClose(props.onDisconnect)}
                      >
                        {t("Disconnect")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            </DrawerBody>
          </>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

export default ActionBar;

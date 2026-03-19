import { useTranslation } from "next-i18next";
import {
  Button,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
} from "@heroui/react";
import Ipc from "../lib/ipc";

const CONNECTED = 'connected';

function ActionBar(props) {
  const { t } = useTranslation('cloud');

  const handleDisconnect = () => {
    props.onDisconnect && props.onDisconnect();
  };

  const handleDisconnectAndPoweroff = () => {
    props.onDisconnectPowerOff && props.onDisconnectPowerOff();
  }

  const handleTogglePerformance = () => {
    props.onTogglePerformance && props.onTogglePerformance();
  };

  const handleAudio = () => {
    props.onAudio && props.onAudio();
  };

  const handlePressPs = () => {
    props.onPressPs && props.onPressPs();
  };

  const handleLongPressPs = () => {
    props.onLongPressPs && props.onLongPressPs();
  };

  const handleToggleFullscreen = () => {
    Ipc.send('app', 'toggleFullscreen')
  };

  const handleAdjustBrightness = () => {
    props.onAdjustBrightness && props.onAdjustBrightness();
  };

  const handleAdjustFsr = () => {
    props.onAdjustFsr && props.onAdjustFsr();
  };

  const disconnectPowerActionLabel =
    props.type === "remoteplay"
      ? t("Disconnect and standby")
      : t("Disconnect and power off");

  return (
    <div id="actionBar">
      <Dropdown>
        <DropdownTrigger>
          <Button variant="bordered" size="sm" style={{color: '#fff'}}>
            {t("Menu")}
          </Button>
        </DropdownTrigger>
        <DropdownMenu aria-label="Static Actions">
          {
            props.connectState === CONNECTED && props.onTogglePerformance && (
              <DropdownItem key="performance" onClick={handleTogglePerformance}>
                {t("Toggle Performance")}
              </DropdownItem>
            )
          }

          {
            props.connectState === CONNECTED && props.onPressPs && (
              <DropdownItem key="pressPs" onClick={handlePressPs}>
                {t("Press PS Button")}
              </DropdownItem>
            )
          }

          {
            (props.connectState === CONNECTED && props.type !== 'cloud' && props.onLongPressPs) && (
              <DropdownItem key="longPressPs" onClick={handleLongPressPs}>
                {t("Long press PS Button")}
              </DropdownItem>
            )
          }

          {
            props.connectState === CONNECTED && props.onAudio && (
              <DropdownItem key="audio" onClick={handleAudio}>
                {props.audioMuted ? t("Open Audio") : t("Close Audio")}
              </DropdownItem>
            )
          }

          {
            props.connectState === CONNECTED && props.onAdjustBrightness && (
              <DropdownItem key="brightness" onClick={handleAdjustBrightness}>
                {props.brightnessLabel || t("Brightness")}
              </DropdownItem>
            )
          }

          {
            props.connectState === CONNECTED && props.onAdjustFsr && (
              <DropdownItem key="fsr" onClick={handleAdjustFsr}>
                {props.fsrLabel || t("FSR")}
              </DropdownItem>
            )
          }
          
          <DropdownItem key="fullscreen" onClick={handleToggleFullscreen}>
            {t("Toggle fullscreen")}
          </DropdownItem>

          {
            props.onDisconnectPowerOff && (
              <DropdownItem
                key="disconnectPoweroff"
                className="text-danger"
                color="danger"
                onClick={handleDisconnectAndPoweroff}
              >
                {disconnectPowerActionLabel}
              </DropdownItem>
            )
          }
          {
            props.onDisconnect && (
              <DropdownItem
                key="disconnect"
                className="text-danger"
                color="danger"
                onClick={handleDisconnect}
              >
                {t("Disconnect")}
              </DropdownItem>
            )
          }
        </DropdownMenu>
      </Dropdown>
    </div>
  );
}

export default ActionBar;

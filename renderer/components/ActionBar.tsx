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

  const handlePressNexus = () => {
    props.onPressNexus && props.onPressNexus();
  };

  const handleLongPressNexus = () => {
    props.onLongPressNexus && props.onLongPressNexus();
  };

  const handleToggleFullscreen = () => {
    Ipc.send('app', 'toggleFullscreen')
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
            props.connectState === CONNECTED && props.onPressNexus && (
              <DropdownItem key="pressNexus" onClick={handlePressNexus}>
                {t("Press Nexus")}
              </DropdownItem>
            )
          }

          {
            (props.connectState === CONNECTED && props.type !== 'cloud' && props.onLongPressNexus) && (
              <DropdownItem key="longPressNexus" onClick={handleLongPressNexus}>
                {t("Long press Nexus")}
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

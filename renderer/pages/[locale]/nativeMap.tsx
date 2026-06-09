import { useState, useEffect } from "react";
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import { useTranslation } from "next-i18next";
import { useRouter } from "next/router";
import MapItem from "../../components/MapItem";
import Nav from "../../components/Nav";
import PsGamepadIcon from "../../components/gamepad/PsGamepadIcon";
import {
  DEFAULT_GAMEPAD_BUTTON_MAPPING,
  GAMEPAD_MAPPING_ACTIONS,
  normalizeGamepadButtonMapping,
} from "../../common/gamepadMapping";
import {
  type NativeGamepadTestButtonName,
  type NativeGamepadTestSnapshot,
} from "../../common/nativeGamepadTest";
import { useSettings } from "../../context/userContext";
import Ipc from "../../lib/ipc";

import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";

const NATIVE_TRIGGER_PRESS_THRESHOLD = 0.5;

const NATIVE_BUTTON_INDEX_BY_NAME: Partial<Record<NativeGamepadTestButtonName, number>> = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  leftShoulder: 4,
  rightShoulder: 5,
  back: 8,
  start: 9,
  leftStick: 10,
  rightStick: 11,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
  guide: 16,
  touchpad: 17,
};

const findPressedNativeButtonIndex = (snapshot: NativeGamepadTestSnapshot | null) => {
  const controller =
    snapshot?.controllers.find((item) => item.active) || snapshot?.controllers[0];
  if (!controller) {
    return null;
  }

  for (const [buttonName, buttonIndex] of Object.entries(NATIVE_BUTTON_INDEX_BY_NAME)) {
    if (controller.buttons[buttonName as NativeGamepadTestButtonName]) {
      return buttonIndex;
    }
  }

  if (controller.axes.leftTrigger >= NATIVE_TRIGGER_PRESS_THRESHOLD) {
    return 6;
  }

  if (controller.axes.rightTrigger >= NATIVE_TRIGGER_PRESS_THRESHOLD) {
    return 7;
  }

  return null;
};

const NativeGamepadMapModal = ({ show, current, onConfirm, onCancel }) => {
  const { t } = useTranslation("settings");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!show) {
      return undefined;
    }

    let active = true;
    let pollTimer = 0;

    const pollNativeGamepad = async (action: "start" | "refresh" = "refresh") => {
      try {
        const snapshot =
          action === "start"
            ? await Ipc.send("app", "startNativeGamepadTestSession")
            : await Ipc.send("app", "getNativeGamepadTestSnapshot");
        if (!active) {
          return;
        }

        const pressedIndex = findPressedNativeButtonIndex(snapshot);
        if (pressedIndex !== null) {
          active = false;
          if (pollTimer) {
            window.clearInterval(pollTimer);
          }
          onConfirm && onConfirm(current, pressedIndex);
        }
      } catch (err: any) {
        if (active) {
          setError(String(err?.message || err || ""));
        }
      }
    };

    void pollNativeGamepad("start");
    pollTimer = window.setInterval(() => {
      void pollNativeGamepad("refresh");
    }, 80);

    return () => {
      active = false;
      if (pollTimer) {
        window.clearInterval(pollTimer);
      }
      void Ipc.send("app", "stopNativeGamepadTestSession").catch(() => undefined);
    };
  }, [current, onConfirm, show]);

  const handleCancel = () => {
    onCancel && onCancel();
  };

  return (
    <Modal isOpen={show} hideCloseButton={true}>
      <ModalContent style={{ background: "#fff", color: "#333" }}>
        <>
          <ModalHeader className="flex flex-col gap-1">{t("Key Maping")}</ModalHeader>
          <ModalBody className="map-modal-body">
            <p>{t("Please press the button on the controller, which will be mapped to:")} </p>
            <div className="icon-wrap">
              <PsGamepadIcon action={current} size={40} />
            </div>
            <p>{t("After successful mapping, this pop-up will automatically close")}</p>
            {error ? <p className="text-danger">{error}</p> : null}
          </ModalBody>
          <ModalFooter>
            <Button color="primary" fullWidth onClick={handleCancel}>
              {t("Cancel")}
            </Button>
          </ModalFooter>
        </>
      </ModalContent>
    </Modal>
  );
};

function NativeMap() {
  const { t, i18n: {language: locale} } = useTranslation("settings");
  const { settings, setSettings } = useSettings();
  const router = useRouter();

  const [maping, setMaping] = useState({ ...DEFAULT_GAMEPAD_BUTTON_MAPPING });
  const [current, setCurrent] = useState("");
  const [loading, setLoading] = useState(false);
  const [isLogined, setIsLogined] = useState(false);

  useEffect(() => {
    const _isLogined = window.sessionStorage.getItem("isLogined") || "0";
    if (_isLogined === "1") {
      setIsLogined(true);
    }

    setMaping(normalizeGamepadButtonMapping(settings.native_gamepad_maping));

    return () => {};
  }, [settings.native_gamepad_maping]);

  const [showModal, setShowModal] = useState(false);

  const handleMapConfirm = (name, idx) => {
    console.log(name, idx);
    setShowModal(false);
    setMaping((prevMaping) => {
      const nextMaping = { ...prevMaping };

      for (const action of GAMEPAD_MAPPING_ACTIONS) {
        if (action !== name && nextMaping[action] === idx) {
          nextMaping[action] = -1;
        }
      }

      nextMaping[name] = idx;
      return nextMaping;
    });
  };

  const handleMapPress = (name) => {
    setCurrent(name);
    setShowModal(true);
  };

  const handleSave = () => {
    console.log("native maping:", maping);
    setLoading(true)
    setSettings({
      ...settings,
      native_gamepad_maping: maping,
    });
    router.push({
      pathname: `/${locale}/settings`
    });
  };

  const handleReset = () => {
    setMaping({ ...DEFAULT_GAMEPAD_BUTTON_MAPPING });
  };

  return (
    <div className="map-page">
      <Nav current="settings" isLogined={isLogined} />

      {showModal && (
        <NativeGamepadMapModal
          show={showModal}
          current={current}
          onConfirm={handleMapConfirm}
          onCancel={() => setShowModal(false)}
        />
      )}

      <div className="maps">
        {GAMEPAD_MAPPING_ACTIONS.map((name) => {
          return (
            <div className="maps-item" key={name}>
              <MapItem
                name={name}
                value={maping[name]}
                onPress={handleMapPress}
              />
            </div>
          );
        })}

        <div className="operate-btns">
          <Button
            color="primary"
            className="mt-5"
            fullWidth
            isLoading={loading}
            onClick={handleSave}
          >
            {t("Save")}
          </Button>
          <Button
            color="default"
            className="mt-5"
            fullWidth
            onClick={handleReset}
          >
            {t("Reset")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default NativeMap;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "settings"]);

// eslint-disable-next-line react-refresh/only-export-components
export {getStaticPaths};

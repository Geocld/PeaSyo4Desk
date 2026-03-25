import { useState, useEffect } from "react";
import { Button } from "@heroui/react";
import { useTranslation } from "next-i18next";
import { useRouter } from "next/router";
import GamepadMapModal from "../../components/GamepadMapModal";
import MapItem from "../../components/MapItem";
import Nav from "../../components/Nav";
import {
  DEFAULT_GAMEPAD_BUTTON_MAPPING,
  GAMEPAD_MAPPING_ACTIONS,
  normalizeGamepadButtonMapping,
} from "../../common/gamepadMapping";
import { useSettings } from "../../context/userContext";

import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";

function Map() {
  const { t, i18n: {language: locale} } = useTranslation("settings");
  const { settings, setSettings } = useSettings();
  const router = useRouter();

  const [maping, setMaping] = useState({ ...DEFAULT_GAMEPAD_BUTTON_MAPPING });
  const [current, setCurrent] = useState("");
  const [loading, setLoading] = useState(false);
  // const [loadingText, setLoadingText] = useState("");
  const [isLogined, setIsLogined] = useState(false);

  useEffect(() => {
    const _isLogined = window.sessionStorage.getItem("isLogined") || "0";
    if (_isLogined === "1") {
      setIsLogined(true);
    }

    setMaping(normalizeGamepadButtonMapping(settings.gamepad_maping));

    return () => {};
  }, [settings.gamepad_maping]);

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
    console.log("maping:", maping);
    setLoading(true)
    setSettings({
      ...settings,
      gamepad_maping: maping,
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
        <GamepadMapModal
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

export default Map;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "settings"]);

// eslint-disable-next-line react-refresh/only-export-components
export {getStaticPaths};

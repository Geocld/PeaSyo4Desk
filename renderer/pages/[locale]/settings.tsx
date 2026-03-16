import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  Chip,
  Radio,
  RadioGroup,
  Slider,
  Tab,
  Tabs,
  addToast,
} from "@heroui/react";
import { useTranslation } from "next-i18next";
import { useRouter } from "next/router";
import Ipc from "../../lib/ipc";
import Layout from "../../components/Layout";
import SettingItem from "../../components/SettingItem";
import KeyboardMap from "../../components/KeyboardMap";
import PsnLoginModals from "../../components/PsnLoginModals";
import Alert from "../../components/Alert";
import ConfirmModal from "../../components/ConfirmModal";
import Nav from "../../components/Nav";
import updater from "../../lib/updater";
import { useSettings } from "../../context/userContext";
import { defaultSettings } from "../../context/userContext.defaults";
import getSettingsMetas from "../../common/settings";
import {
  getPsnAccountId,
  getPsnLoginDisplayName,
  getPsnLoginUserKey,
  PENDING_STREAM_STORAGE_KEY,
  parseCachedPsnLoginUsers,
  type PsnLoginInfo,
} from "../../common/remotePlay";
import pkg from "../../../package.json";
import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";

type BasicStreamDraft = {
  resolution: number;
  bitrate_mode: "auto" | "custom";
  bitrate: number;
  codec: string;
  fps: number;
  remote_resolution: number;
  remote_bitrate_mode: "auto" | "custom";
  remote_bitrate: number;
  remote_codec: string;
  remote_fps: number;
};

const getAutoBitrateForResolution = (resolution: number) => {
  if (resolution >= 1080) return 27000;
  if (resolution >= 720) return 10000;
  if (resolution >= 540) return 6000;
  return 2000;
};

const normalizeBitrateMode = (mode: unknown): "auto" | "custom" => {
  return String(mode || "auto").toLowerCase() === "custom" ? "custom" : "auto";
};

const getSliderValue = (value: number | number[]) => {
  return Array.isArray(value) ? Number(value[0] || 0) : Number(value || 0);
};

const clampStreamBitrate = (bitrate: unknown, resolution: number) => {
  const parsed = Math.round(Number(bitrate));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return getAutoBitrateForResolution(resolution);
  }

  return Math.min(100000, Math.max(1000, parsed));
};

const ensureBitrateForMode = (
  resolution: number,
  bitrateMode: unknown,
  bitrate: unknown
) => {
  if (normalizeBitrateMode(bitrateMode) === "custom") {
    return clampStreamBitrate(bitrate, resolution);
  }

  return getAutoBitrateForResolution(resolution);
};

const createDraftFromSettings = (settings: any): BasicStreamDraft => {
  const resolution = Number(settings?.resolution || defaultSettings.resolution);
  const bitrateMode = normalizeBitrateMode(settings?.bitrate_mode);
  const remoteResolution = Number(
    settings?.remote_resolution || defaultSettings.remote_resolution
  );
  const remoteBitrateMode = normalizeBitrateMode(settings?.remote_bitrate_mode);

  return {
    resolution,
    bitrate_mode: bitrateMode,
    bitrate: ensureBitrateForMode(resolution, bitrateMode, settings?.bitrate),
    codec: String(settings?.codec || defaultSettings.codec),
    fps: Number(settings?.fps || defaultSettings.fps),
    remote_resolution: remoteResolution,
    remote_bitrate_mode: remoteBitrateMode,
    remote_bitrate: ensureBitrateForMode(
      remoteResolution,
      remoteBitrateMode,
      settings?.remote_bitrate
    ),
    remote_codec: String(settings?.remote_codec || defaultSettings.remote_codec),
    remote_fps: Number(settings?.remote_fps || defaultSettings.remote_fps),
  };
};

const defaultDraft = createDraftFromSettings(defaultSettings);

const getOptionLabel = (option: any) => option?.label ?? option?.text ?? String(option?.value);
const formatBitrateText = (bitrate: number) => `${Math.round(bitrate / 1000)} Mbps`;

function SettingsPage() {
  const {
    t,
    i18n: { language: locale },
  } = useTranslation("settings");
  const router = useRouter();
  const { settings, setSettings } = useSettings();

  const [draft, setDraft] = useState<BasicStreamDraft>(defaultDraft);
  const [showAlert, setShowAlert] = useState(false);
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showDeleteAccountModal, setShowDeleteAccountModal] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [alertMessage, setAlertMessage] = useState("");
  const [updateText, setUpdateText] = useState("");
  const [updateUrl, setUpdateUrl] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [psnUsers, setPsnUsers] = useState<PsnLoginInfo[]>([]);
  const [currentPsnUserKey, setCurrentPsnUserKey] = useState("");
  const [selectedPsnUserKey, setSelectedPsnUserKey] = useState("");
  const [accountActionLoading, setAccountActionLoading] = useState<
    "switch" | "delete" | null
  >(null);

  useEffect(() => {
    const localFontSize = localStorage.getItem("fontSize");
    if (localFontSize && localFontSize !== "16") {
      document.documentElement.style.fontSize = `${localFontSize}px`;
    }
  }, []);

  useEffect(() => {
    const nextDraft = createDraftFromSettings(settings);
    setDraft(nextDraft);
  }, [settings]);

  const loadPsnUsers = async () => {
    const [storedUsers, currentLoginInfo] = await Promise.all([
      Ipc.send("app", "getCachedPsnLoginUsers").catch(() => []),
      Ipc.send("app", "getCachedPsnLoginInfo").catch(() => null),
    ]);

    const nextUsers = parseCachedPsnLoginUsers(storedUsers);
    const nextCurrentUserKey = getPsnLoginUserKey(
      currentLoginInfo as PsnLoginInfo | null
    );
    const fallbackSelectedUserKey =
      nextCurrentUserKey || getPsnLoginUserKey(nextUsers[0]);

    setPsnUsers(nextUsers);
    setCurrentPsnUserKey(nextCurrentUserKey);
    setSelectedPsnUserKey((prev) => {
      if (nextUsers.some((item) => getPsnLoginUserKey(item) === prev)) {
        return prev;
      }
      return fallbackSelectedUserKey;
    });

    return {
      users: nextUsers,
      currentUserKey: nextCurrentUserKey,
    };
  };

  useEffect(() => {
    void loadPsnUsers();
  }, []);

  const settingsMetas = useMemo(() => getSettingsMetas(t), [t]);
  const baseMetas = settingsMetas.base || [];
  const localMetas = settingsMetas.local || [];
  const remoteMetas = settingsMetas.remote || [];
  const otherMetas = settingsMetas.others || [];

  const persistedDraft = useMemo(() => createDraftFromSettings(settings), [settings]);
  const isDirty = JSON.stringify(draft) !== JSON.stringify(persistedDraft);

  const syncDraft = (nextDraft: BasicStreamDraft) => {
    setDraft(nextDraft);
  };

  const handleResolutionChange = (type: "local" | "remote", resolution: number) => {
    const autoBitrate = getAutoBitrateForResolution(resolution);

    if (type === "local") {
      setDraft((prev) => ({
        ...prev,
        resolution,
        bitrate_mode: "auto",
        bitrate: autoBitrate,
      }));
      return;
    }

    setDraft((prev) => ({
      ...prev,
      remote_resolution: resolution,
      remote_bitrate_mode: "auto",
      remote_bitrate: autoBitrate,
    }));
  };

  const handleBitrateModeChange = (
    type: "local" | "remote",
    mode: "auto" | "custom"
  ) => {
    if (type === "local") {
      const nextBitrate =
        mode === "auto"
          ? getAutoBitrateForResolution(draft.resolution)
          : clampStreamBitrate(draft.bitrate, draft.resolution);
      setDraft((prev) => ({
        ...prev,
        bitrate_mode: mode,
        bitrate: nextBitrate,
      }));
      return;
    }

    const nextBitrate =
      mode === "auto"
        ? getAutoBitrateForResolution(draft.remote_resolution)
        : clampStreamBitrate(draft.remote_bitrate, draft.remote_resolution);
    setDraft((prev) => ({
      ...prev,
      remote_bitrate_mode: mode,
      remote_bitrate: nextBitrate,
    }));
  };

  const handleCodecChange = (type: "local" | "remote", codec: string) => {
    if (type === "local") {
      setDraft((prev) => ({ ...prev, codec }));
      return;
    }

    setDraft((prev) => ({ ...prev, remote_codec: codec }));
  };

  const handleFpsChange = (type: "local" | "remote", fps: number) => {
    if (type === "local") {
      setDraft((prev) => ({ ...prev, fps }));
      return;
    }

    setDraft((prev) => ({ ...prev, remote_fps: fps }));
  };

  const handleBitrateSliderChange = (
    type: "local" | "remote",
    value: number | number[]
  ) => {
    const bitrate = Math.min(100000, Math.max(1000, getSliderValue(value) * 1000));

    if (type === "local") {
      setDraft((prev) => ({ ...prev, bitrate }));
      return;
    }

    setDraft((prev) => ({ ...prev, remote_bitrate: bitrate }));
  };

  const handleResetStreamSettings = () => {
    syncDraft(defaultDraft);
  };

  const handleSaveStreamSettings = () => {
    const nextDraft: BasicStreamDraft = {
      ...draft,
      bitrate: ensureBitrateForMode(draft.resolution, draft.bitrate_mode, draft.bitrate),
      remote_bitrate: ensureBitrateForMode(
        draft.remote_resolution,
        draft.remote_bitrate_mode,
        draft.remote_bitrate
      ),
    };

    syncDraft(nextDraft);
    setSettings({
      ...settings,
      ...nextDraft,
    });

    addToast({
      title: t("Saved"),
      color: "success",
    });
  };

  const handleResetAppSettings = () => {
    localStorage.removeItem("theme");
    localStorage.removeItem("fontSize");
    document.documentElement.style.fontSize = "16px";
    Ipc.send("app", "exitFullscreen").catch(() => undefined);

    const nextSettings = {
      ...settings,
      ...defaultSettings,
      locale: defaultSettings.locale,
      fullscreen: defaultSettings.fullscreen,
    };
    setSettings(nextSettings);
    syncDraft(createDraftFromSettings(nextSettings));

    addToast({
      title: t("Saved"),
      color: "success",
    });
  };

  const clearLocalCache = () => {
    localStorage.removeItem(PENDING_STREAM_STORAGE_KEY);
    sessionStorage.removeItem("isLogined");
  };

  const handleCheckUpdate = () => {
    setIsChecking(true);
    updater().then((infos: any) => {
      setIsChecking(false);
      if (infos) {
        const { latestVer, version, url } = infos;
        setUpdateText(`Check new version ${latestVer}, current version is ${version}`);
        setUpdateUrl(url);
        setShowUpdateModal(true);
      } else {
        setAlertMessage(t("Current version is latest"));
        setShowAlert(true);
      }
    });
  };

  const handleClearCache = async () => {
    await Ipc.send("app", "clearData").catch(() => undefined);
    await Ipc.send("app", "clearUserData").catch(() => undefined);
    await Ipc.send("app", "clearCachedPsnLoginInfo").catch(() => undefined);
    await Ipc.send("app", "clearCachedConsoles").catch(() => undefined);
    clearLocalCache();
    Ipc.send("app", "restart");
  };

  const handleAccountLoginSuccess = async () => {
    setShowLoginModal(false);
    window.sessionStorage.setItem("isLogined", "1");
    const nextState = await loadPsnUsers();
    setSelectedPsnUserKey(
      nextState.currentUserKey || getPsnLoginUserKey(nextState.users[0]) || ""
    );
    addToast({
      title: t("Account added"),
      color: "success",
    });
  };

  const handleSwitchAccount = async () => {
    if (!selectedPsnUserKey || selectedPsnUserKey === currentPsnUserKey) {
      return;
    }

    setAccountActionLoading("switch");
    try {
      await Ipc.send("app", "setCurrentPsnLoginUser", {
        userKey: selectedPsnUserKey,
      });
      window.sessionStorage.setItem("isLogined", "1");
      await loadPsnUsers();
      addToast({
        title: t("Account switched"),
        color: "success",
      });
    } catch (error: any) {
      addToast({
        title: t("Failed to switch account"),
        description: String(error?.message || error || ""),
        color: "danger",
      });
    } finally {
      setAccountActionLoading(null);
    }
  };

  const handleDeleteAccount = async () => {
    if (!selectedPsnUserKey) {
      return;
    }

    setAccountActionLoading("delete");
    try {
      const nextState: any = await Ipc.send("app", "deletePsnLoginUser", {
        userKey: selectedPsnUserKey,
      });
      const nextUsers = parseCachedPsnLoginUsers(nextState?.users || []);
      const nextCurrentUserKey = String(nextState?.currentUserKey || "").trim();

      setPsnUsers(nextUsers);
      setCurrentPsnUserKey(nextCurrentUserKey);
      setSelectedPsnUserKey(
        nextCurrentUserKey || getPsnLoginUserKey(nextUsers[0]) || ""
      );
      window.sessionStorage.setItem("isLogined", nextUsers.length > 0 ? "1" : "0");

      addToast({
        title: t("Account deleted"),
        color: "success",
      });
    } catch (error: any) {
      addToast({
        title: t("Failed to delete account"),
        description: String(error?.message || error || ""),
        color: "danger",
      });
    } finally {
      setAccountActionLoading(null);
      setShowDeleteAccountModal(false);
    }
  };

  const handleOtherAction = (item: any) => {
    switch (item.action) {
      case "open-map":
        router.push({
          pathname: `/${locale}/map`,
        });
        return;
      case "open-test":
        router.push({
          pathname: `/${locale}/test`,
        });
        return;
      case "reset-settings":
        handleResetAppSettings();
        return;
      case "check-update":
        handleCheckUpdate();
        return;
      case "clear-cache":
        void handleClearCache();
        return;
      case "exit":
        Ipc.send("app", "quit");
        return;
      default:
        return;
    }
  };

  const renderSettingCard = (
    title: string,
    description: string,
    children: ReactNode,
    tips?: string
  ) => {
    return (
      <div className="setting-item">
        <Card>
          <CardBody>
            <div className="setting-title text-foreground">{title}</div>
            <div className="setting-description text-default-500">{description}</div>
            {tips ? <div className="setting-description text-warning">{tips}</div> : null}
            {children}
          </CardBody>
        </Card>
      </div>
    );
  };

  const renderAccountManagerCard = () => {
    return (
      <div className="setting-item">
        <Card>
          <CardBody className="flex flex-col gap-4">
            <div className="setting-title text-foreground">{t("PSN accounts")}</div>
            <div className="setting-description text-default-500">
              {t(
                "Manage signed in PSN accounts here. Newly added accounts become the current account immediately. Registered hosts are kept when deleting accounts."
              )}
            </div>

            {psnUsers.length > 0 ? (
              <RadioGroup
                value={selectedPsnUserKey}
                onValueChange={setSelectedPsnUserKey}
              >
                {psnUsers.map((user) => {
                  const userKey = getPsnLoginUserKey(user);
                  const isCurrent = userKey === currentPsnUserKey;
                  const onlineId = getPsnLoginDisplayName(user);
                  const accountId = getPsnAccountId(user) || userKey;

                  return (
                    <Radio key={userKey} value={userKey}>
                      <div className="flex flex-col gap-1 py-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{onlineId || userKey}</span>
                          {isCurrent ? (
                            <Chip size="sm" color="success" variant="flat">
                              {t("Current")}
                            </Chip>
                          ) : null}
                        </div>
                        <p className="text-xs text-default-500 break-all">
                          {accountId}
                        </p>
                      </div>
                    </Radio>
                  );
                })}
              </RadioGroup>
            ) : (
              <div className="rounded-large border border-dashed border-divider px-4 py-6">
                <p className="text-sm text-default-600">
                  {t("No signed in accounts yet.")}
                </p>
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-3">
              <Button variant="flat" onPress={() => setShowLoginModal(true)}>
                {t("Add account")}
              </Button>
              <Button
                variant="flat"
                onPress={() => void handleSwitchAccount()}
                isDisabled={
                  !selectedPsnUserKey ||
                  selectedPsnUserKey === currentPsnUserKey ||
                  psnUsers.length < 1
                }
                isLoading={accountActionLoading === "switch"}
              >
                {t("Switch account")}
              </Button>
              <Button
                color="danger"
                variant="flat"
                onPress={() => setShowDeleteAccountModal(true)}
                isDisabled={!selectedPsnUserKey || psnUsers.length < 1}
                isLoading={accountActionLoading === "delete"}
              >
                {t("Delete account")}
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    );
  };

  const renderProfile = (type: "local" | "remote") => {
    const metas = type === "local" ? localMetas : remoteMetas;
    const resolutionKey = type === "local" ? "resolution" : "remote_resolution";
    const bitrateModeKey = type === "local" ? "bitrate_mode" : "remote_bitrate_mode";
    const codecKey = type === "local" ? "codec" : "remote_codec";
    const fpsKey = type === "local" ? "fps" : "remote_fps";

    const resolutionMeta = metas.find((item) => item.name === resolutionKey);
    const bitrateMeta = metas.find((item) => item.name === bitrateModeKey);
    const codecMeta = metas.find((item) => item.name === codecKey);
    const fpsMeta = metas.find((item) => item.name === fpsKey);

    if (!resolutionMeta || !bitrateMeta || !codecMeta || !fpsMeta) {
      return null;
    }

    const resolution = draft[resolutionKey];
    const bitrateMode = draft[bitrateModeKey];
    const codec = draft[codecKey];
    const fps = draft[fpsKey];
    const autoBitrate = getAutoBitrateForResolution(resolution);
    const customBitrate = type === "local" ? draft.bitrate : draft.remote_bitrate;
    const customBitrateSliderValue = Math.round(customBitrate / 1000);

    return (
      <>
        {renderSettingCard(
          resolutionMeta.title,
          resolutionMeta.description,
          <RadioGroup
            orientation="horizontal"
            value={String(resolution)}
            onValueChange={(value) => handleResolutionChange(type, Number(value))}
          >
            {resolutionMeta.data.map((option) => (
              <Radio key={String(option.value)} value={String(option.value)}>
                {getOptionLabel(option)}
              </Radio>
            ))}
          </RadioGroup>
        )}

        {renderSettingCard(
          bitrateMeta.title,
          bitrateMeta.description,
          <div className="space-y-4">
            <RadioGroup
              orientation="horizontal"
              value={bitrateMode}
              onValueChange={(value) =>
                handleBitrateModeChange(type, normalizeBitrateMode(value))
              }
            >
              {bitrateMeta.data.map((option) => (
                <Radio key={String(option.value)} value={String(option.value)}>
                  {getOptionLabel(option)}
                </Radio>
              ))}
            </RadioGroup>

            {bitrateMode === "custom" ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-default-500">{t("Custom bitrate (kbps)")}</span>
                  <span className="font-medium text-foreground">
                    {formatBitrateText(customBitrate)}
                  </span>
                </div>

                <Slider
                  className="setting-slider"
                  size="sm"
                  label={t("Custom bitrate (kbps)")}
                  step={1}
                  minValue={1}
                  maxValue={100}
                  value={customBitrateSliderValue}
                  onChange={(value) => handleBitrateSliderChange(type, value)}
                />

                <div className="flex items-center justify-between text-xs text-default-400">
                  <span>1 Mbps</span>
                  <span>100 Mbps</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-default-500">
                {t(
                  "Automatic bitrate will follow the selected resolution and use {{bitrate}} kbps.",
                  { bitrate: autoBitrate }
                )}
              </p>
            )}
          </div>,
          bitrateMeta.tips
        )}

        {renderSettingCard(
          codecMeta.title,
          codecMeta.description,
          <RadioGroup
            orientation="horizontal"
            value={codec}
            onValueChange={(value) => handleCodecChange(type, value)}
          >
            {codecMeta.data.map((option) => (
              <Radio key={String(option.value)} value={String(option.value)}>
                {getOptionLabel(option)}
              </Radio>
            ))}
          </RadioGroup>
        )}

        {renderSettingCard(
          fpsMeta.title,
          fpsMeta.description,
          <RadioGroup
            orientation="horizontal"
            value={String(fps)}
            onValueChange={(value) => handleFpsChange(type, Number(value))}
          >
            {fpsMeta.data.map((option) => (
              <Radio key={String(option.value)} value={String(option.value)}>
                {getOptionLabel(option)}
              </Radio>
            ))}
          </RadioGroup>
        )}

        <div className="setting-item">
          <Card>
            <CardBody className="flex flex-row justify-end gap-3">
              <Button variant="flat" onPress={handleResetStreamSettings}>
                {t("Reset stream settings")}
              </Button>
              <Button
                color="primary"
                onPress={handleSaveStreamSettings}
                isDisabled={!isDirty}
              >
                {t("Save changes")}
              </Button>
            </CardBody>
          </Card>
        </div>
      </>
    );
  };

  const renderOtherActionCard = (item: any) => {
    const description =
      item.action === "check-update"
        ? `${item.description} ${pkg.version}`
        : item.description;

    return (
      <Card className="setting-item" key={item.name}>
        <CardBody>
          <div className="setting-title">{item.title}</div>
          {description ? (
            <div className="setting-description">{description}</div>
          ) : null}
          <Button
            color={item.color || "primary"}
            isLoading={item.action === "check-update" && isChecking}
            onPress={() => handleOtherAction(item)}
          >
            {item.buttonText}
          </Button>
        </CardBody>
      </Card>
    );
  };

  return (
    <>
      <Nav current="settings" />

      {showAlert ? (
        <Alert content={alertMessage} onClose={() => setShowAlert(false)} />
      ) : null}

      <ConfirmModal
        show={showRestartModal}
        content={t(
          "The option has been saved. A restart is required for it to take effect. Would you like to restart now?"
        )}
        confirmText={t("Restart")}
        onConfirm={() => {
          Ipc.send("app", "restart");
        }}
        onCancel={() => setShowRestartModal(false)}
      />

      <ConfirmModal
        show={showUpdateModal}
        content={updateText}
        onCancel={() => setShowUpdateModal(false)}
        onConfirm={() => {
          window.location.href = updateUrl;
          setShowUpdateModal(false);
        }}
      />

      <ConfirmModal
        show={showDeleteAccountModal}
        content={t(
          "Delete the selected account? Registered hosts will be kept on this device."
        )}
        confirmText={t("Delete account")}
        onConfirm={() => {
          void handleDeleteAccount();
        }}
        onCancel={() => setShowDeleteAccountModal(false)}
      />

      <Layout>
        <Tabs aria-label="Options">
          <Tab key="Base" title={t("Base")}>
            {renderAccountManagerCard()}
            {baseMetas.map((item) => (
              <SettingItem
                key={item.name}
                item={item}
                onRestartWarn={() => setShowRestartModal(true)}
              />
            ))}
          </Tab>

          <Tab key="Local" title={t("Local streaming")}>
            {renderProfile("local")}
          </Tab>

          <Tab key="Remote" title={t("Remote streaming")}>
            {renderProfile("remote")}
          </Tab>

          <Tab key="Others" title={t("Others")}>
            {otherMetas.map((item) => (
              <div key={item.name}>
                {renderOtherActionCard(item)}
                {item.name === "gamepad_tester" ? <KeyboardMap /> : null}
              </div>
            ))}
          </Tab>
        </Tabs>
      </Layout>

      <PsnLoginModals
        show={showLoginModal}
        allowClose
        onClose={() => setShowLoginModal(false)}
        onLoginSuccess={() => {
          void handleAccountLoginSuccess();
        }}
      />
    </>
  );
}

export default SettingsPage;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "home", "settings"]);

// eslint-disable-next-line react-refresh/only-export-components
export { getStaticPaths };

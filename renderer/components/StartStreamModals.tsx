import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import { useTranslation } from "next-i18next";
import Ipc from "../lib/ipc";
import { getWakeupCredentialFromRegistKey } from "../common/remotePlay";

type ConsoleItem = {
  consoleId?: string;
  serverNickname?: string;
  apName?: string;
  host?: string;
  remoteHost?: string;
  parsedRemoteHost?: string;
  remoteDeviceUid?: string;
  deviceUid?: string;
  rpRegistKey?: string;
  userCredential?: string | number;
  hostId?: string;
  hostType?: string;
  isPs5?: boolean;
  target?: number;
  stateName?: string;
};

type StartStreamModalsProps = {
  show: boolean;
  consoleItem: ConsoleItem | null;
  onClose: () => void;
  onConsoleUpdated: (updatedConsole: ConsoleItem) => void;
  onLoginRequired?: () => void;
  onStartPrepared: (payload: {
    consoleInfo: ConsoleItem;
    streamHost: string;
    isRemote: boolean;
    autoRemote?: boolean;
    wakeBeforeConnect: boolean;
  }) => void;
};

type Step = "mode" | "remote";
type LoadingType = "local" | "auto" | "direct" | "wake" | null;
type PreparedLocalStreamResult = {
  status?: "ready" | "standby" | "unknown" | "not_discovered" | "wake_timeout";
  streamReady?: boolean;
  host?: string;
  hostId?: string;
  hostType?: string;
  target?: number;
  stateName?: string;
  wakeAttempts?: number;
  discovered?: boolean;
};

const getErrorMessage = (error: any, fallback: string) => {
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (error?.message && typeof error.message === "string") {
    return error.message;
  }
  return fallback;
};

const isWakeupCredentialError = (message: string) => {
  const normalized = String(message || "").trim().toLowerCase();
  return (
    normalized.includes("wakeup user credential is missing") ||
    normalized.includes("wakeup user credential is invalid")
  );
};

const inferConsoleIsPs5 = (consoleItem: ConsoleItem | null | undefined) => {
  return Boolean(
    consoleItem?.isPs5 ||
    consoleItem?.apName?.toUpperCase().includes("PS5") ||
    consoleItem?.hostType?.toUpperCase().includes("PS5")
  );
};
const REMOTE_WAKE_CONNECT_WAIT_MS = 45000;

export default function StartStreamModals(props: StartStreamModalsProps) {
  const { t } = useTranslation("home");
  const { t: tCommon } = useTranslation("common");

  const [step, setStep] = useState<Step>("mode");
  const [loadingType, setLoadingType] = useState<LoadingType>(null);
  const [errorText, setErrorText] = useState("");
  const [infoText, setInfoText] = useState("");
  const [remoteHostInput, setRemoteHostInput] = useState("");
  const [wakeCountdownSeconds, setWakeCountdownSeconds] = useState(0);
  const wakeCountdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const title = useMemo(() => {
    if (props.consoleItem?.serverNickname) {
      return `${props.consoleItem.serverNickname}`;
    }
    return t("Start stream");
  }, [props.consoleItem?.serverNickname, t]);
  const remoteStreamHint = t("RemoteStreamHostHint");

  useEffect(() => {
    if (!props.show) return;

    setStep("mode");
    setLoadingType(null);
    setErrorText("");
    setInfoText("");
    clearWakeCountdownTimer();
    setRemoteHostInput(
      (props.consoleItem?.remoteHost || props.consoleItem?.host || "").trim()
    );
  }, [props.show, props.consoleItem?.consoleId, props.consoleItem?.remoteHost, props.consoleItem?.host]);

  useEffect(() => {
    return () => {
      clearWakeCountdownTimer();
    };
  }, []);

  const clearWakeCountdownTimer = () => {
    if (wakeCountdownTimerRef.current) {
      clearInterval(wakeCountdownTimerRef.current);
      wakeCountdownTimerRef.current = null;
    }
    setWakeCountdownSeconds(0);
  };

  const waitWithWakeCountdown = (ms: number) => {
    clearWakeCountdownTimer();

    return new Promise<void>((resolve) => {
      const startedAt = Date.now();
      let resolved = false;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearWakeCountdownTimer();
        resolve();
      };

      const update = () => {
        const remainingMs = Math.max(0, ms - (Date.now() - startedAt));
        const remainingSeconds = Math.ceil(remainingMs / 1000);
        setWakeCountdownSeconds(remainingSeconds);
        if (remainingSeconds <= 0) {
          finish();
        }
      };

      update();
      wakeCountdownTimerRef.current = setInterval(update, 250);
    });
  };

  const resolveHost = async (host: string) => {
    return Ipc.send("app", "resolveHost", { host });
  };

  const sendWakeup = async (host: string) => {
    return Ipc.send("app", "sendWakeupPacket", {
      host,
      ps5: inferConsoleIsPs5(props.consoleItem),
      userCredential:
        props.consoleItem?.userCredential ||
        getWakeupCredentialFromRegistKey(props.consoleItem?.rpRegistKey),
    });
  };

  const startPreparedLocalStream = (
    streamHost: string,
    consoleInfo?: ConsoleItem,
    wakeBeforeConnect = false
  ) => {
    if (!props.consoleItem) {
      return;
    }

    props.onStartPrepared({
      consoleInfo: consoleInfo || props.consoleItem,
      streamHost,
      isRemote: false,
      autoRemote: false,
      wakeBeforeConnect,
    });
  };

  const updateCachedConsole = (updatedConsole: ConsoleItem) => {
    props.onConsoleUpdated(updatedConsole);
    return updatedConsole;
  };

  const handleLocalStream = async () => {
    const localHost = (props.consoleItem?.host || "").trim();
    if (!localHost) {
      setErrorText(t("Local host is empty"));
      return;
    }

    setErrorText("");
    setInfoText("");
    setLoadingType("local");
    try {
      setInfoText(t("Checking local console status..."));
      // Keep the desktop side explicit so the native orchestrator follows the same
      // retry cadence as Android: immediate wake, +5s follow-up wake, 2s polls,
      // then a short ready-confirm delay before entering stream.
      const preparedResult = (await Ipc.send("app", "prepareLocalStream", {
        host: localHost,
        hostId: props.consoleItem?.hostId,
        ps5: inferConsoleIsPs5(props.consoleItem),
        userCredential:
          props.consoleItem?.userCredential ||
          getWakeupCredentialFromRegistKey(props.consoleItem?.rpRegistKey),
        consoleInfo: props.consoleItem || undefined,
        wakeIfStandby: true,
        discoveryTimeoutMs: 3000,
        wakeRetryIntervalMs: 5000,
        pollIntervalMs: 2000,
        pollTimeoutMs: 25000,
        readyConfirmDelayMs: 5000,
      })) as PreparedLocalStreamResult;

      const nextConsoleInfo = props.consoleItem
        ? {
            ...props.consoleItem,
            host: String(preparedResult.host || localHost).trim() || localHost,
            hostId: String(preparedResult.hostId || props.consoleItem.hostId || "").trim() || undefined,
            hostType:
              String(preparedResult.hostType || props.consoleItem.hostType || "").trim() ||
              undefined,
            target:
              typeof preparedResult.target === "number"
                ? preparedResult.target
                : props.consoleItem.target,
            stateName:
              String(preparedResult.stateName || props.consoleItem.stateName || "").trim() ||
              undefined,
            isPs5: inferConsoleIsPs5(props.consoleItem),
          }
        : undefined;

      if (nextConsoleInfo && props.consoleItem) {
        const hasChanged =
          (nextConsoleInfo.host || "") !== (props.consoleItem.host || "") ||
          (nextConsoleInfo.hostId || "") !== (props.consoleItem.hostId || "") ||
          (nextConsoleInfo.hostType || "") !== (props.consoleItem.hostType || "") ||
          Number(nextConsoleInfo.target || 0) !== Number(props.consoleItem.target || 0) ||
          (nextConsoleInfo.stateName || "") !== (props.consoleItem.stateName || "");
        if (hasChanged) {
          updateCachedConsole(nextConsoleInfo);
        }
      }

      if (preparedResult.streamReady) {
        setInfoText(t("Local console is powered on, starting stream..."));
        startPreparedLocalStream(
          String(preparedResult.host || localHost).trim() || localHost,
          nextConsoleInfo,
          Number(preparedResult.wakeAttempts || 0) > 0
        );
      } else if (preparedResult.status === "wake_timeout") {
        // Even if wake polling times out, still enter
        // stream and let the connection path continue while the console finishes waking.
        startPreparedLocalStream(
          String(preparedResult.host || localHost).trim() || localHost,
          nextConsoleInfo,
          true
        );
      } else if (preparedResult.status === "not_discovered") {
        // Even if discovery cannot find the console, still try to connect with the cached host.
        startPreparedLocalStream(
          String(preparedResult.host || localHost).trim() || localHost,
          nextConsoleInfo,
          Number(preparedResult.wakeAttempts || 0) > 0
        );
      } else {
        setErrorText(t("Unable to confirm local console status."));
        setInfoText("");
        return;
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error, t("Failed to prepare local stream."));
      if (isWakeupCredentialError(errorMessage)) {
        setErrorText(errorMessage);
        return;
      }

      // Keep local wake best-effort like Android: transport/discovery failures
      // should not strand the user on Home when we still have a cached host.
      console.warn("[home] prepareLocalStream failed, continuing to local stream:", {
        host: localHost,
        hostId: props.consoleItem?.hostId,
        error: errorMessage,
      });
      startPreparedLocalStream(localHost, props.consoleItem || undefined, true);
    } finally {
      setLoadingType(null);
    }

    props.onClose();
  };

  const saveRemoteHostToCache = (resolvedHost: string) => {
    if (!props.consoleItem) return;

    const updatedConsole: ConsoleItem = {
      ...props.consoleItem,
      remoteHost: remoteHostInput.trim(),
      parsedRemoteHost: resolvedHost,
    };
    props.onConsoleUpdated(updatedConsole);
  };

  const handleRemoteDirectConnect = async () => {
    const remoteHost = remoteHostInput.trim();
    if (!remoteHost) {
      setErrorText(t("Please input remote host"));
      return;
    }

    setErrorText("");
    setInfoText("");
    setLoadingType("direct");
    try {
      const resolved = await resolveHost(remoteHost);
      saveRemoteHostToCache(resolved.preferredAddress);

      console.log("[home] Remote direct connect prepared:", {
        inputHost: remoteHost,
        resolved,
        consoleId: props.consoleItem?.consoleId,
      });
      setInfoText(t("Remote direct connect is ready."));
      if (props.consoleItem) {
        props.onStartPrepared({
          consoleInfo: {
            ...props.consoleItem,
            remoteHost: remoteHost,
            parsedRemoteHost: resolved.preferredAddress,
          },
          streamHost: resolved.preferredAddress,
          isRemote: true,
          autoRemote: false,
          wakeBeforeConnect: false,
        });
      }
    } catch (error) {
      setErrorText(getErrorMessage(error, t("Failed to resolve host.")));
      return;
    } finally {
      setLoadingType(null);
    }

    props.onClose();
  };

  const handleRemoteAutoConnect = async () => {
    if (!props.consoleItem) {
      return;
    }

    setErrorText("");
    setInfoText("");
    setLoadingType("auto");
    try {
      const streamHost =
        props.consoleItem.parsedRemoteHost ||
        props.consoleItem.remoteHost ||
        props.consoleItem.host ||
        "127.0.0.1";

      console.log("[home] Remote auto connect prepared:", {
        streamHost,
        consoleId: props.consoleItem.consoleId,
        serverNickname: props.consoleItem.serverNickname,
      });

      await Ipc.send("app", "refreshPsnLoginInfoForRemotePlay");

      props.onStartPrepared({
        consoleInfo: props.consoleItem,
        streamHost,
        isRemote: true,
        autoRemote: true,
        wakeBeforeConnect: false,
      });
    } catch (error) {
      if (props.onLoginRequired) {
        props.onLoginRequired();
        return;
      }
      setErrorText(getErrorMessage(error, t("Failed to prepare remote stream.")));
      return;
    } finally {
      setLoadingType(null);
    }

    props.onClose();
  };

  const handleRemoteWakeAndConnect = async () => {
    const remoteHost = remoteHostInput.trim();
    if (!remoteHost) {
      setErrorText(t("Please input remote host"));
      return;
    }

    setErrorText("");
    setInfoText("");
    setLoadingType("wake");
    try {
      const resolved = await resolveHost(remoteHost);
      saveRemoteHostToCache(resolved.preferredAddress);

      await sendWakeup(resolved.preferredAddress);

      console.log("[home] Remote wakeup sent:", {
        inputHost: remoteHost,
        resolved,
        consoleId: props.consoleItem?.consoleId,
      });

      await waitWithWakeCountdown(5000);
      await sendWakeup(resolved.preferredAddress);

      setInfoText(t("Wakeup packet sent, waiting before connecting..."));
      await waitWithWakeCountdown(REMOTE_WAKE_CONNECT_WAIT_MS);
      if (props.consoleItem) {
        props.onStartPrepared({
          consoleInfo: {
            ...props.consoleItem,
            remoteHost: remoteHost,
            parsedRemoteHost: resolved.preferredAddress,
          },
          streamHost: resolved.preferredAddress,
          isRemote: true,
          autoRemote: false,
          wakeBeforeConnect: true,
        });
      }
    } catch (error) {
      setErrorText(getErrorMessage(error, t("Failed to send wakeup packet.")));
      return;
    } finally {
      clearWakeCountdownTimer();
      setLoadingType(null);
    }

    props.onClose();
  };

  return (
    <>
      <Modal
        isOpen={props.show && step === "mode"}
        isDismissable={false}
        hideCloseButton
        size="2xl"
      >
        <ModalContent>
          <>
            <ModalHeader>{title}</ModalHeader>
            <ModalBody className="gap-3">
              <p className="text-sm text-default-500">
                {t("Choose local network or remote network streaming.")}
              </p>
              {errorText ? (
                <p className="text-danger text-sm break-all">{errorText}</p>
              ) : null}
              {infoText ? (
                <p className="text-success text-sm break-all">{infoText}</p>
              ) : null}
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={props.onClose}>
                {tCommon("Cancel")}
              </Button>
              <Button
                variant="flat"
                onPress={() => setStep("remote")}
                isDisabled={loadingType !== null}
              >
                {t("Remote stream")}
              </Button>
              <Button
                color="primary"
                onPress={handleLocalStream}
                isLoading={loadingType === "local"}
              >
                {t("Local stream")}
              </Button>
            </ModalFooter>
          </>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={props.show && step === "remote"}
        isDismissable={false}
        hideCloseButton
        size="2xl"
      >
        <ModalContent>
          <>
            <ModalHeader>{t("Remote stream")}</ModalHeader>
            <ModalBody className="gap-3">
              <p className="text-sm text-default-500 whitespace-pre-line">
                {remoteStreamHint}
              </p>
              {errorText ? (
                <p className="text-danger text-sm break-all">{errorText}</p>
              ) : null}
              {infoText ? (
                <p className="text-success text-sm break-all">{infoText}</p>
              ) : null}
              <Input
                label={t("Remote host")}
                labelPlacement="outside"
                value={remoteHostInput}
                onValueChange={setRemoteHostInput}
                placeholder="example.com / 1.2.3.4 / 2408::1"
              />
            </ModalBody>
            <ModalFooter>
              <Button
                variant="light"
                onPress={() => setStep("mode")}
                isDisabled={loadingType !== null}
              >
                {tCommon("Back")}
              </Button>
              <Button
                variant="flat"
                onPress={handleRemoteAutoConnect}
                isLoading={loadingType === "auto"}
              >
                {t("Auto connect")}
              </Button>
              <Button
                variant="flat"
                onPress={handleRemoteDirectConnect}
                isLoading={loadingType === "direct"}
              >
                {t("Direct connect")}
              </Button>
              <Button
                color="primary"
                onPress={handleRemoteWakeAndConnect}
                isLoading={loadingType === "wake"}
              >
                {loadingType === "wake" && wakeCountdownSeconds > 0
                  ? `${t("Wakeup and connect")} (${wakeCountdownSeconds}s)`
                  : t("Wakeup and connect")}
              </Button>
            </ModalFooter>
          </>
        </ModalContent>
      </Modal>
    </>
  );
}

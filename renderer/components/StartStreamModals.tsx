import { useEffect, useMemo, useState } from "react";
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
  onStartPrepared: (payload: {
    consoleInfo: ConsoleItem;
    streamHost: string;
    isRemote: boolean;
    wakeBeforeConnect: boolean;
  }) => void;
};

type Step = "mode" | "remote";
type LoadingType = "local" | "direct" | "wake" | null;

type DiscoveredConsole = {
  id: string;
  host: string;
  hostId?: string;
  hostType?: string;
  isPs5: boolean;
  target?: number;
  stateName?: string;
  name?: string;
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildConsoleId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `console-${Date.now()}`;
};

const normalizeStateName = (value: unknown) => {
  return String(value || "")
    .trim()
    .toUpperCase();
};

const mapDiscoveredConsole = (item: any): DiscoveredConsole => {
  const host = String(item?.hostAddr || "").trim();
  const hostId = String(item?.hostId || "").trim();

  return {
    id: hostId || host || buildConsoleId(),
    host,
    hostId: hostId || undefined,
    hostType: String(item?.hostType || (item?.isPs5 ? "PS5" : "PS4")).trim(),
    isPs5: Boolean(item?.isPs5),
    target: typeof item?.target === "number" ? item.target : undefined,
    stateName: String(item?.stateName || "").trim(),
    name: String(item?.hostName || "").trim(),
  };
};

const LOCAL_WAKEUP_RETRY_INTERVAL_MS = 2000;
const LOCAL_WAKEUP_FALLBACK_WAIT_MS = 5000;
const LOCAL_AWAKE_CONFIRM_DELAY_MS = 5000;
const LOCAL_WAKEUP_POLL_INTERVAL_MS = 2000;
const LOCAL_WAKEUP_POLL_TIMEOUT_MS = 10000;

export default function StartStreamModals(props: StartStreamModalsProps) {
  const { t } = useTranslation("home");
  const { t: tCommon } = useTranslation("common");

  const [step, setStep] = useState<Step>("mode");
  const [loadingType, setLoadingType] = useState<LoadingType>(null);
  const [errorText, setErrorText] = useState("");
  const [infoText, setInfoText] = useState("");
  const [remoteHostInput, setRemoteHostInput] = useState("");

  const title = useMemo(() => {
    if (props.consoleItem?.serverNickname) {
      return `${props.consoleItem.serverNickname}`;
    }
    return t("Start stream");
  }, [props.consoleItem?.serverNickname, t]);

  useEffect(() => {
    if (!props.show) return;

    setStep("mode");
    setLoadingType(null);
    setErrorText("");
    setInfoText("");
    setRemoteHostInput(
      (props.consoleItem?.remoteHost || props.consoleItem?.host || "").trim()
    );
  }, [props.show, props.consoleItem?.consoleId, props.consoleItem?.remoteHost, props.consoleItem?.host]);

  const resolveHost = async (host: string) => {
    return Ipc.send("app", "resolveHost", { host });
  };

  const sendWakeup = async (host: string) => {
    return Ipc.send("app", "sendWakeupPacket", {
      host,
      userCredential:
        props.consoleItem?.userCredential ||
        getWakeupCredentialFromRegistKey(props.consoleItem?.rpRegistKey),
    });
  };

  const discoverLocalConsole = async () => {
    const isPs5 = Boolean(
      props.consoleItem?.isPs5 ||
      props.consoleItem?.apName?.toUpperCase().includes("PS5") ||
      props.consoleItem?.hostType?.toUpperCase().includes("PS5")
    );

    const result = await Ipc.send("app", "discoverConsoles", {
      ps5: isPs5,
    });

    return Array.isArray(result) ? result.map(mapDiscoveredConsole) : [];
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
      wakeBeforeConnect,
    });
  };

  const updateCachedConsole = (updatedConsole: ConsoleItem) => {
    props.onConsoleUpdated(updatedConsole);
    return updatedConsole;
  };

  const findMatchedLocalConsole = (
    discoveredConsoles: DiscoveredConsole[],
    localHost: string
  ) => {
    const cachedConsoleId = String(props.consoleItem?.consoleId || "").trim();
    const cachedHostId = String(props.consoleItem?.hostId || "").trim();

    return discoveredConsoles.find((item) => {
      if (cachedConsoleId && item.id === cachedConsoleId) {
        return true;
      }

      if (cachedHostId && item.hostId === cachedHostId) {
        return true;
      }

      return item.host === localHost;
    });
  };

  const buildPreparedLocalConsoleInfo = (
    localHost: string,
    matchedConsole?: DiscoveredConsole
  ) => {
    if (!props.consoleItem) {
      return undefined;
    }

    if (!matchedConsole) {
      return {
        ...props.consoleItem,
        host: localHost,
      };
    }

    return {
      ...props.consoleItem,
      host: matchedConsole.host || localHost,
      hostId: matchedConsole.hostId || props.consoleItem.hostId,
      hostType: matchedConsole.hostType || props.consoleItem.hostType,
      isPs5: matchedConsole.isPs5,
      target:
        typeof matchedConsole.target === "number"
          ? matchedConsole.target
          : props.consoleItem.target,
      stateName: matchedConsole.stateName || props.consoleItem.stateName,
    };
  };

  const syncMatchedLocalConsole = (
    localHost: string,
    matchedConsole?: DiscoveredConsole
  ) => {
    const nextConsoleInfo = buildPreparedLocalConsoleInfo(localHost, matchedConsole);

    if (!matchedConsole || !props.consoleItem || !nextConsoleInfo) {
      return nextConsoleInfo;
    }

    const hasChanged =
      (nextConsoleInfo.host || "") !== (props.consoleItem.host || "") ||
      (nextConsoleInfo.hostId || "") !== (props.consoleItem.hostId || "") ||
      (nextConsoleInfo.hostType || "") !== (props.consoleItem.hostType || "") ||
      Boolean(nextConsoleInfo.isPs5) !== Boolean(props.consoleItem.isPs5) ||
      Number(nextConsoleInfo.target || 0) !== Number(props.consoleItem.target || 0) ||
      (nextConsoleInfo.stateName || "") !== (props.consoleItem.stateName || "");

    if (hasChanged) {
      updateCachedConsole(nextConsoleInfo);
    }

    return nextConsoleInfo;
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

      const discoveredConsoles = await discoverLocalConsole();
      const matchedConsole = findMatchedLocalConsole(discoveredConsoles, localHost);
      const nextHost = matchedConsole?.host || localHost;
      const nextConsoleInfo = syncMatchedLocalConsole(nextHost, matchedConsole);
      const stateName = normalizeStateName(matchedConsole?.stateName);

      console.log('stateName11111:', stateName)
      if (stateName === "READY") {
        console.log("[home] Local console already awake:", {
          localHost,
          matchedConsole,
          consoleId: props.consoleItem?.consoleId,
        });
        setInfoText(t("Local console is powered on, starting stream..."));
        startPreparedLocalStream(nextHost, nextConsoleInfo, false);
      } else if (matchedConsole) {
        setInfoText(t("Local console is in standby, sending wakeup packet..."));
        await sendWakeup(nextHost);

        console.log("[home] Local wakeup sent:", {
          localHost,
          matchedConsole,
          consoleId: props.consoleItem?.consoleId,
        });

        setInfoText(t("Waiting for local console to wake up..."));
        const pollStartedAt = Date.now();
        let preparedHost = nextHost;
        let preparedConsoleInfo = nextConsoleInfo;
        let didPrepareStream = false;

        while (Date.now() - pollStartedAt < LOCAL_WAKEUP_POLL_TIMEOUT_MS) {
          await wait(LOCAL_WAKEUP_POLL_INTERVAL_MS);

          const polledConsoles = await discoverLocalConsole();
          const polledConsole = findMatchedLocalConsole(polledConsoles, preparedHost);

          if (!polledConsole) {
            continue;
          }

          preparedHost = polledConsole.host || preparedHost;
          preparedConsoleInfo = syncMatchedLocalConsole(preparedHost, polledConsole);

          if (normalizeStateName(polledConsole.stateName) !== "AWAKE") {
            continue;
          }

          console.log("[home] Local console woke up after wakeup:", {
            localHost,
            polledConsole,
            consoleId: props.consoleItem?.consoleId,
          });

          setInfoText(t("Local console is powered on, starting stream..."));
          await wait(LOCAL_AWAKE_CONFIRM_DELAY_MS);
          startPreparedLocalStream(preparedHost, preparedConsoleInfo, true);
          didPrepareStream = true;
          break;
        }

        if (!didPrepareStream) {
          console.log("[home] Local console did not report awake before timeout, starting anyway:", {
            localHost,
            matchedConsole,
            consoleId: props.consoleItem?.consoleId,
          });

          startPreparedLocalStream(preparedHost, preparedConsoleInfo, true);
        }
      } else {
        await sendWakeup(localHost);
        await wait(LOCAL_WAKEUP_RETRY_INTERVAL_MS);
        await sendWakeup(localHost);

        console.log("[home] Local console not discovered, sent wakeup twice before stream:", {
          localHost,
          consoleId: props.consoleItem?.consoleId,
        });

        setInfoText(t("Wakeup packets sent, waiting for local console to wake up..."));
        await wait(LOCAL_WAKEUP_FALLBACK_WAIT_MS);
        startPreparedLocalStream(localHost, nextConsoleInfo, true);
      }
    } catch (error) {
      setErrorText(getErrorMessage(error, t("Failed to prepare local stream.")));
      return;
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

      await wait(35000);
      if (props.consoleItem) {
        props.onStartPrepared({
          consoleInfo: {
            ...props.consoleItem,
            remoteHost: remoteHost,
            parsedRemoteHost: resolved.preferredAddress,
          },
          streamHost: resolved.preferredAddress,
          isRemote: true,
          wakeBeforeConnect: true,
        });
      }
    } catch (error) {
      setErrorText(getErrorMessage(error, t("Failed to send wakeup packet.")));
      return;
    } finally {
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
        size="lg"
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
        size="lg"
      >
        <ModalContent>
          <>
            <ModalHeader>{t("Remote stream")}</ModalHeader>
            <ModalBody className="gap-3">
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
                {t("Wakeup and connect")}
              </Button>
            </ModalFooter>
          </>
        </ModalContent>
      </Modal>
    </>
  );
}

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

type ConsoleItem = {
  consoleId?: string;
  serverNickname?: string;
  apName?: string;
  host?: string;
  remoteHost?: string;
  parsedRemoteHost?: string;
  userCredential?: string | number;
};

type StartStreamModalsProps = {
  show: boolean;
  consoleItem: ConsoleItem | null;
  onClose: () => void;
  onConsoleUpdated: (updatedConsole: ConsoleItem) => void;
};

type Step = "mode" | "remote";
type LoadingType = "local" | "direct" | "wake" | null;

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
      return `${t("Start stream")} - ${props.consoleItem.serverNickname}`;
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
      userCredential: props.consoleItem?.userCredential,
    });
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
      const resolved = await resolveHost(localHost);
      await sendWakeup(resolved.preferredAddress);

      console.log("[home] Local stream wakeup sent:", {
        inputHost: localHost,
        resolved,
        consoleId: props.consoleItem?.consoleId,
      });

      setInfoText(t("Local wakeup packet sent."));
    } catch (error) {
      setErrorText(getErrorMessage(error, t("Failed to send wakeup packet.")));
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

      setInfoText(t("Remote wakeup sent, waiting 35 seconds..."));
      await wait(35000);

      // TODO: route to stream page after stream page implementation is finished.
      console.log("[home] Waited 35s after remote wakeup. TODO: navigate to stream page.");
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
                {t("Back to mode")}
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

import { useEffect, useState } from "react";
import {
  Button,
  Divider,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import { useTranslation } from "next-i18next";
import Ipc from "../lib/ipc";

type LoginMethod = "oauth" | "username" | "accountId" | "manual";

type PsnLoginModalsProps = {
  show: boolean;
  onLoginSuccess: (loginInfo: any) => void;
  allowClose?: boolean;
  onClose?: () => void;
};

const PSN_ACCOUNT_ID_INVALID_MESSAGE =
  "PSN account id format is invalid. Please sign in again, or enter a valid Base64 PSN account id.";

const getErrorMessage = (error: any, fallback: string) => {
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (error?.message && typeof error.message === "string") {
    return error.message;
  }
  return fallback;
};

const isAccountIdFormatError = (error: any, message: string) => {
  const code = String(error?.code || "").trim();
  return (
    code === "PSN_ACCOUNT_ID_INVALID" ||
    /invalid base64 input/i.test(message) ||
    /psnAccountId must be 8 bytes/i.test(message) ||
    /PSN account id format is invalid/i.test(message)
  );
};

const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(textarea);
      return copied;
    } catch {
      return false;
    }
  }
};

export default function PsnLoginModals(props: PsnLoginModalsProps) {
  const { t } = useTranslation("home");
  const { t: tCommon } = useTranslation("common");

  const [activeMethod, setActiveMethod] = useState<LoginMethod>("oauth");
  const [loadingMethod, setLoadingMethod] = useState<LoginMethod | null>(null);
  const [loginError, setLoginError] = useState("");
  const [manualHint, setManualHint] = useState("");
  const [username, setUsername] = useState("");
  const [accountId, setAccountId] = useState("");
  const [manualLoginUrl, setManualLoginUrl] = useState("");
  const [manualRedirectUrl, setManualRedirectUrl] = useState("");

  const switchMethod = (method: LoginMethod) => {
    setActiveMethod(method);
    setLoginError("");
    setManualHint("");
  };

  useEffect(() => {
    if (!props.show) return;
    switchMethod("oauth");

    let cancelled = false;
    Ipc.send("app", "getPsnLoginUrl")
      .then((url) => {
        if (cancelled) return;
        setManualLoginUrl(String(url || ""));
      })
      .catch((error) => {
        if (cancelled) return;
        setManualLoginUrl("");
        setLoginError(
          getErrorMessage(error, "Failed to build manual PSN login URL.")
        );
      });

    return () => {
      cancelled = true;
    };
  }, [props.show]);

  const doOauthLogin = async () => {
    setLoginError("");
    setManualHint("");
    setLoadingMethod("oauth");
    try {
      const loginInfo = await Ipc.send("app", "login");
      props.onLoginSuccess(loginInfo);
    } catch (error) {
      setLoginError(getErrorMessage(error, "PSN login failed."));
    } finally {
      setLoadingMethod(null);
    }
  };

  const doUsernameLogin = async () => {
    const normalizedUsername = username.trim();
    if (!normalizedUsername) {
      setLoginError(t("Please input PSN username"));
      return;
    }

    setLoginError("");
    setManualHint("");
    setLoadingMethod("username");
    try {
      const loginInfo = await Ipc.send("app", "loginWithUsername", {
        username: normalizedUsername,
      });
      props.onLoginSuccess(loginInfo);
    } catch (error) {
      setLoginError(getErrorMessage(error, t("Username login failed")));
    } finally {
      setLoadingMethod(null);
    }
  };

  const doAccountIdLogin = async () => {
    const normalizedAccountId = accountId.trim();
    if (!normalizedAccountId) {
      setLoginError(t("Please input account id"));
      return;
    }

    setLoginError("");
    setManualHint("");
    setLoadingMethod("accountId");
    try {
      const loginInfo = await Ipc.send("app", "loginWithAccountId", {
        accountId: normalizedAccountId,
      });
      props.onLoginSuccess(loginInfo);
    } catch (error) {
      const message = getErrorMessage(error, t("Account id login failed"));
      setLoginError(
        isAccountIdFormatError(error, message)
          ? t(PSN_ACCOUNT_ID_INVALID_MESSAGE)
          : message
      );
    } finally {
      setLoadingMethod(null);
    }
  };

  const openManualLink = () => {
    if (!manualLoginUrl) return;
    if (window.PeaSyo?.openExternal) {
      window.PeaSyo.openExternal(manualLoginUrl);
      return;
    }
    window.open(manualLoginUrl, "_blank", "noopener,noreferrer");
  };

  const doCopyManualLink = async () => {
    if (!manualLoginUrl) return;
    const copied = await copyText(manualLoginUrl);
    setManualHint(copied ? tCommon("Copied") : "Failed to copy login URL.");
  };

  const doManualRedirectLogin = async () => {
    const normalizedRedirectUrl = manualRedirectUrl.trim();
    if (!normalizedRedirectUrl) {
      setLoginError(t("Please input redirect URL"));
      return;
    }
    if (
      !normalizedRedirectUrl.startsWith("https://") ||
      normalizedRedirectUrl.indexOf("code=") === -1
    ) {
      setLoginError(t("Invalid redirect URL"));
      return;
    }

    setLoginError("");
    setManualHint("");
    setLoadingMethod("manual");
    try {
      const loginInfo = await Ipc.send("app", "manualLoginByRedirect", {
        redirectUrl: normalizedRedirectUrl,
      });
      props.onLoginSuccess(loginInfo);
    } catch (error) {
      setLoginError(getErrorMessage(error, t("Manual login failed")));
    } finally {
      setLoadingMethod(null);
    }
  };

  return (
    <>
      <Modal
        isOpen={props.show && activeMethod === "oauth"}
        isDismissable={!!props.allowClose}
        hideCloseButton={!props.allowClose}
        onClose={props.allowClose ? props.onClose : undefined}
        size="lg"
      >
        <ModalContent>
          <>
            <ModalHeader>{tCommon("Login")}</ModalHeader>
            <ModalBody className="gap-4">
              <p>{tCommon("Login has expired or not logged in, please log in again")}</p>
              {loginError ? (
                <p className="text-danger text-sm break-all">{loginError}</p>
              ) : null}
            </ModalBody>
            <ModalFooter className="flex-col gap-3">
              <Button
                color="primary"
                className="w-full"
                onPress={doOauthLogin}
                isLoading={loadingMethod === "oauth"}
              >
                {loadingMethod === "oauth" ? t("Loading...") : tCommon("Login")}
              </Button>
              <Divider />
              <p className="text-xs text-default-500 w-full">
                {t("If you cannot open PSN login page, try the fallback methods below.")}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 w-full">
                {/* <Button variant="flat" onPress={() => switchMethod("username")}>
                  {t("Login with username")}
                </Button> */}
                <Button variant="flat" onPress={() => switchMethod("accountId")}>
                  {t("Login with account id")}
                </Button>
                <Button variant="flat" onPress={() => switchMethod("manual")}>
                  {t("Manual login")}
                </Button>
              </div>
            </ModalFooter>
          </>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={props.show && activeMethod === "username"}
        isDismissable={!!props.allowClose}
        hideCloseButton={!props.allowClose}
        onClose={props.allowClose ? props.onClose : undefined}
        size="lg"
      >
        <ModalContent>
          <>
            <ModalHeader>{t("Login with username")}</ModalHeader>
            <ModalBody className="gap-3">
              {loginError ? (
                <p className="text-danger text-sm break-all">{loginError}</p>
              ) : null}
              <Input
                label={t("PSN username")}
                labelPlacement="outside"
                value={username}
                onValueChange={setUsername}
                placeholder={t("Input your PSN username")}
              />
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={() => switchMethod("oauth")}>
                {tCommon("Back")}
              </Button>
              <Button
                color="primary"
                onPress={doUsernameLogin}
                isLoading={loadingMethod === "username"}
              >
                {t("Login with username")}
              </Button>
            </ModalFooter>
          </>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={props.show && activeMethod === "accountId"}
        isDismissable={!!props.allowClose}
        hideCloseButton={!props.allowClose}
        onClose={props.allowClose ? props.onClose : undefined}
        size="lg"
      >
        <ModalContent>
          <>
            <ModalHeader>{t("Login with account id")}</ModalHeader>
            <ModalBody className="gap-3">
              {loginError ? (
                <p className="text-danger text-sm break-all">{loginError}</p>
              ) : null}
              <Input
                label={t("Account ID (Base64)")}
                labelPlacement="outside"
                value={accountId}
                onValueChange={setAccountId}
                placeholder="ABCD=="
              />
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={() => switchMethod("oauth")}>
                {tCommon("Back")}
              </Button>
              <Button
                color="primary"
                onPress={doAccountIdLogin}
                isLoading={loadingMethod === "accountId"}
              >
                {t("Login with account id")}
              </Button>
            </ModalFooter>
          </>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={props.show && activeMethod === "manual"}
        isDismissable={!!props.allowClose}
        hideCloseButton={!props.allowClose}
        onClose={props.allowClose ? props.onClose : undefined}
        size="2xl"
        scrollBehavior="inside"
      >
        <ModalContent>
          <>
            <ModalHeader>{t("Manual login")}</ModalHeader>
            <ModalBody className="gap-3">
              {loginError ? (
                <p className="text-danger text-sm break-all">{loginError}</p>
              ) : null}
              <p className="text-xs text-default-500">
                {t("Open PSN link in external browser and paste redirect URL here.")}
              </p>
              <Input
                label={t("PSN login link")}
                labelPlacement="outside"
                value={manualLoginUrl}
                isReadOnly
              />
              <div className="flex gap-2">
                <Button
                  variant="flat"
                  onPress={openManualLink}
                  isDisabled={!manualLoginUrl}
                >
                  {t("Open link")}
                </Button>
                <Button
                  variant="flat"
                  onPress={doCopyManualLink}
                  isDisabled={!manualLoginUrl}
                >
                  {tCommon("Copy")}
                </Button>
              </div>
              {manualHint ? (
                <p className="text-xs text-success">{manualHint}</p>
              ) : null}
              <Input
                label={t("Redirect URL")}
                labelPlacement="outside"
                value={manualRedirectUrl}
                onValueChange={setManualRedirectUrl}
                placeholder="https://remoteplay.dl.playstation.net/remoteplay/redirect?..."
              />
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={() => switchMethod("oauth")}>
                {tCommon("Back")}
              </Button>
              <Button
                color="primary"
                onPress={doManualRedirectLogin}
                isLoading={loadingMethod === "manual"}
              >
                {t("Login with redirect URL")}
              </Button>
            </ModalFooter>
          </>
        </ModalContent>
      </Modal>
    </>
  );
}

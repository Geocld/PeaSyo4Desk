import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import { useTranslation } from "next-i18next";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import Nav from "../../components/Nav";
import Ipc from "../../lib/ipc";

import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";

const PSN_LOGIN_STORAGE_KEY = "psn-login-info";

function Home() {
  const { t } = useTranslation("home");
  const { t: tCommon } = useTranslation("common");

  const { setTheme } = useTheme();
  const [isLogined, setIsLogined] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");

  useEffect(() => {
    const localTheme = localStorage.getItem('theme');
    if (localTheme === 'xbox-light') {
      setTheme(localTheme)
    }

    const localFontSize = localStorage.getItem('fontSize');
    if (localFontSize && localFontSize !== '16') {
      document.documentElement.style.fontSize = localFontSize + 'px';
    }

    const localLoginInfo = localStorage.getItem(PSN_LOGIN_STORAGE_KEY);
    if (!localLoginInfo) {
      window.sessionStorage.setItem("isLogined", "0");
      setIsLogined(false);
      setShowLoginModal(true);
      return;
    }

    try {
      const parsedLoginInfo = JSON.parse(localLoginInfo);
      if (parsedLoginInfo?.accessToken) {
        window.sessionStorage.setItem("isLogined", "1");
        setIsLogined(true);
        setShowLoginModal(false);
      } else {
        localStorage.removeItem(PSN_LOGIN_STORAGE_KEY);
        window.sessionStorage.setItem("isLogined", "0");
        setIsLogined(false);
        setShowLoginModal(true);
      }
    } catch (error) {
      console.error("Invalid login cache:", error);
      localStorage.removeItem(PSN_LOGIN_STORAGE_KEY);
      window.sessionStorage.setItem("isLogined", "0");
      setIsLogined(false);
      setShowLoginModal(true);
    }
  }, [setTheme]);

  const handleLogin = async () => {
    setLoginError("");
    setLoginLoading(true);
    try {
      const loginInfo = await Ipc.send("app", "login");

      if (!loginInfo?.accessToken) {
        throw new Error("Failed to get PSN access token.");
      }

      localStorage.setItem(PSN_LOGIN_STORAGE_KEY, JSON.stringify(loginInfo));
      window.sessionStorage.setItem("isLogined", "1");
      setIsLogined(true);
      setShowLoginModal(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "PSN login failed.";
      setLoginError(message);
      setIsLogined(false);
      window.sessionStorage.setItem("isLogined", "0");
      setShowLoginModal(true);
    } finally {
      setLoginLoading(false);
    }
  };

  return (
    <>
      <Nav isLogined={isLogined} />

      <Layout>
        <div className="gap-4 grid grid-cols-3">
          home
        </div>
      </Layout>

      <Modal isOpen={showLoginModal} isDismissable={false} hideCloseButton>
        <ModalContent>
          <>
            <ModalHeader className="flex flex-col gap-1">
              {tCommon("Warning")}
            </ModalHeader>
            <ModalBody>
              <p>{tCommon("Login has expired or not logged in, please log in again")}</p>
              {loginError ? (
                <p className="text-danger text-sm break-all">{loginError}</p>
              ) : null}
            </ModalBody>
            <ModalFooter>
              <Button color="primary" onPress={handleLogin} isLoading={loginLoading}>
                {loginLoading ? t("Loading...") : tCommon("Login")}
              </Button>
            </ModalFooter>
          </>
        </ModalContent>
      </Modal>
    </>
  );
}

export default Home;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "home"]);

// eslint-disable-next-line react-refresh/only-export-components
export { getStaticPaths };

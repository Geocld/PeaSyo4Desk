import {
  Button,
  Card,
  CardBody,
  CardFooter,
  Chip,
  Divider,
} from "@heroui/react";
import { useTranslation } from "next-i18next";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import Nav from "../../components/Nav";
import PsnLoginModals from "../../components/PsnLoginModals";
import StartStreamModals from "../../components/StartStreamModals";
import mockConsoles from "../../mock/consoles.json";

import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";

const PSN_LOGIN_STORAGE_KEY = "psn-login-info";
const LOCAL_CONSOLES_KEY = "local-consoles";

type ConsoleCacheItem = {
  rpKey?: string;
  rpRegistKey?: string;
  apName?: string;
  apBssid?: string;
  serverMac?: string;
  apKey?: string;
  serverNickname?: string;
  apSsid?: string;
  consoleId?: string;
  host?: string;
  remoteHost?: string;
  parsedRemoteHost?: string;
  userCredential?: string | number;
  registedTime?: number;
};

const hasLoginCredential = (loginInfo: any) => {
  return Boolean(loginInfo?.accessToken || loginInfo?.userInfo?.account_id);
};

const parseCachedConsoles = (raw: string | null): ConsoleCacheItem[] => {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return parsed.filter((item) => item && typeof item === "object");
    }

    if (parsed && typeof parsed === "object") {
      return [parsed];
    }

    return [];
  } catch (error) {
    console.error("Invalid local consoles cache:", error);
    return [];
  }
};

const formatConsoleType = (item: ConsoleCacheItem) => {
  if (item.apName) return item.apName;
  return "PS";
};

function Home() {
  const { t } = useTranslation("home");
  const { setTheme } = useTheme();
  const [isLogined, setIsLogined] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [consoles, setConsoles] = useState<ConsoleCacheItem[]>([]);
  const [showStartStreamModal, setShowStartStreamModal] = useState(false);
  const [selectedConsole, setSelectedConsole] = useState<ConsoleCacheItem | null>(
    null
  );

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
      if (hasLoginCredential(parsedLoginInfo)) {
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

  useEffect(() => {
    if (!isLogined) {
      setConsoles([]);
      return;
    }

    const cachedConsoles = parseCachedConsoles(
      localStorage.getItem(LOCAL_CONSOLES_KEY)
    );
    setConsoles(mockConsoles);
    // setConsoles(cachedConsoles);
  }, [isLogined]);

  const handleLoginSuccess = (loginInfo: any) => {
    if (!hasLoginCredential(loginInfo)) {
      throw new Error("Failed to get valid PSN login info.");
    }

    localStorage.setItem(PSN_LOGIN_STORAGE_KEY, JSON.stringify(loginInfo));
    window.sessionStorage.setItem("isLogined", "1");
    setIsLogined(true);
    setShowLoginModal(false);
  };

  const handleAddHostClick = () => {
    console.log("[home] Add host clicked. TODO: implement register flow.");
  };

  const handleStartStreamClick = (item: ConsoleCacheItem) => {
    setSelectedConsole(item);
    setShowStartStreamModal(true);
  };

  const handleCloseStartStreamModal = () => {
    setShowStartStreamModal(false);
    setSelectedConsole(null);
  };

  const handleConsoleUpdated = (updatedConsole: ConsoleCacheItem) => {
    setConsoles((prevConsoles) => {
      const nextConsoles = prevConsoles.map((item) => {
        if (item.consoleId && updatedConsole.consoleId) {
          if (item.consoleId !== updatedConsole.consoleId) return item;
          return { ...item, ...updatedConsole };
        }

        if (
          item.serverNickname === updatedConsole.serverNickname &&
          item.host === updatedConsole.host
        ) {
          return { ...item, ...updatedConsole };
        }

        return item;
      });

      localStorage.setItem(LOCAL_CONSOLES_KEY, JSON.stringify(nextConsoles));
      return nextConsoles;
    });
  };

  return (
    <>
      <Nav isLogined={isLogined} />

      <Layout>
        {isLogined && consoles.length > 0 ? (
          <div className="gap-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
            {consoles.map((item, index) => {
              const nickname =
                item.serverNickname || `${t("Consoles")} ${index + 1}`;
              const type = formatConsoleType(item);
              const hostText = item.remoteHost || item.host || "-";
              const consoleId = item.consoleId || "-";

              return (
                <Card key={`${item.consoleId || "console"}-${index}`}>
                  <CardBody>
                    <p className="text-center">{nickname}</p>
                    <p className="text-center text-sm text-gray-400">{type}</p>
                    <p className="text-center text-xs text-gray-500">
                      ({consoleId})
                    </p>
                    <div className="flex justify-center py-2">
                      <Chip size="sm" radius="none" color="success">
                        {t("Cached host")}
                      </Chip>
                    </div>
                    <div className="text-xs text-gray-500 break-all text-center">
                      {hostText}
                    </div>
                  </CardBody>
                  <Divider />
                  <CardFooter>
                    <Button
                      color="primary"
                      size="sm"
                      className="w-full"
                      onPress={() => handleStartStreamClick(item)}
                    >
                      {t("Start stream")}
                    </Button>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        ) : isLogined ? (
          <Card className="max-w-2xl mx-auto">
            <CardBody className="py-10">
              <div className="text-center">
                <p className="text-xl font-semibold">{t("No cached hosts")}</p>
                <p className="text-sm text-gray-500 mt-2">
                  {t("You have no local console cache yet.")}
                </p>
              </div>
            </CardBody>
            <Divider />
            <CardFooter className="justify-center py-6">
              <Button color="primary" onPress={handleAddHostClick}>
                {t("Add host")}
              </Button>
            </CardFooter>
          </Card>
        ) : null}
      </Layout>

      <PsnLoginModals show={showLoginModal} onLoginSuccess={handleLoginSuccess} />
      <StartStreamModals
        show={showStartStreamModal}
        consoleItem={selectedConsole}
        onClose={handleCloseStartStreamModal}
        onConsoleUpdated={handleConsoleUpdated}
      />
    </>
  );
}

export default Home;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "home"]);

// eslint-disable-next-line react-refresh/only-export-components
export { getStaticPaths };

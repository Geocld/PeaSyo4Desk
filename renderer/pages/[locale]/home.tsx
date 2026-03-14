import {
  Button,
  Card,
  CardBody,
  CardFooter,
  Chip,
  Divider,
} from "@heroui/react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import Nav from "../../components/Nav";
import PsnLoginModals from "../../components/PsnLoginModals";
import StartStreamModals from "../../components/StartStreamModals";
import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";
import {
  ConsoleCacheItem,
  hasLoginCredential,
  LOCAL_CONSOLES_KEY,
  PENDING_STREAM_STORAGE_KEY,
  parseCachedConsoles,
  PSN_LOGIN_STORAGE_KEY,
  upsertConsoleCache,
} from "../../common/remotePlay";

const formatConsoleType = (item: ConsoleCacheItem) => {
  if (item.apName) return item.apName;
  return "PS";
};

function Home() {
  const { t, i18n: { language: locale } } = useTranslation("home");
  const router = useRouter();
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

    setConsoles(parseCachedConsoles(localStorage.getItem(LOCAL_CONSOLES_KEY)));
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
    router.push(`/${locale}/registry`);
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
      const nextConsoles = upsertConsoleCache(prevConsoles, updatedConsole);
      localStorage.setItem(LOCAL_CONSOLES_KEY, JSON.stringify(nextConsoles));
      return nextConsoles;
    });
  };

  const handleStartPrepared = (payload: {
    consoleInfo: ConsoleCacheItem;
    streamHost: string;
    isRemote: boolean;
    wakeBeforeConnect: boolean;
  }) => {
    const pendingConfig = {
      ...payload,
      startedAt: Date.now(),
    };

    window.sessionStorage.setItem(
      PENDING_STREAM_STORAGE_KEY,
      JSON.stringify(pendingConfig)
    );
    router.push(`/${locale}/stream`);
  };

  return (
    <>
      <Nav isLogined={isLogined} />

      <Layout>
        {isLogined && consoles.length > 0 ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-2xl font-semibold">{t("Consoles")}</p>
                <p className="text-sm text-gray-500">
                  {t("Registered consoles are stored locally on this device.")}
                </p>
              </div>
              <Button color="primary" onPress={handleAddHostClick}>
                {t("Add host")}
              </Button>
            </div>

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
        onStartPrepared={handleStartPrepared}
      />
    </>
  );
}

export default Home;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "home"]);

// eslint-disable-next-line react-refresh/only-export-components
export { getStaticPaths };

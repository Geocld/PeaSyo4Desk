import {
  addToast,
  Button,
  Card,
  CardBody,
  CardFooter,
  Divider,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import ConsoleHostCard from "../../components/ConsoleHostCard";
import Layout from "../../components/Layout";
import Nav from "../../components/Nav";
import PsnLoginModals from "../../components/PsnLoginModals";
import StartStreamModals from "../../components/StartStreamModals";
import { useSettings } from "../../context/userContext";
import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";
import Ipc from "../../lib/ipc";
import {
  ConsoleCacheItem,
  hasLoginCredential,
  normalizeConsoleCacheItem,
  PENDING_STREAM_STORAGE_KEY,
  parseCachedConsoles,
  upsertConsoleCache,
} from "../../common/remotePlay";

const isLinuxOrSteamOsRuntime = () => {
  if (typeof navigator === "undefined") {
    return false;
  }

  const platformText = `${navigator.userAgent || ""} ${navigator.platform || ""}`;
  return /linux|steamos|steam deck/i.test(platformText);
};

function Home() {
  const { t, i18n: { language: locale } } = useTranslation("home");
  const { t: tCommon } = useTranslation("common");
  const router = useRouter();
  const { setTheme } = useTheme();
  const { settings } = useSettings();
  const [isLogined, setIsLogined] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [consoles, setConsoles] = useState<ConsoleCacheItem[]>([]);
  const [showStartStreamModal, setShowStartStreamModal] = useState(false);
  const [selectedConsole, setSelectedConsole] = useState<ConsoleCacheItem | null>(
    null
  );
  const [showEditHostModal, setShowEditHostModal] = useState(false);
  const [editingConsoleIndex, setEditingConsoleIndex] = useState<number | null>(null);
  const [editHostNameInput, setEditHostNameInput] = useState("");
  const [editHostIpInput, setEditHostIpInput] = useState("");

  useEffect(() => {
    let active = true;

    const initializeLoginState = async () => {
      const storedLoginInfo = await Ipc.send("app", "getCachedPsnLoginInfo").catch(
        () => null
      );
      const hasCachedLogin = hasLoginCredential(storedLoginInfo);
      if (!active) {
        return;
      }

      if (!hasCachedLogin) {
        window.sessionStorage.setItem("isLogined", "0");
        setIsLogined(false);
        setShowLoginModal(true);
        return;
      }

      window.sessionStorage.setItem("isLogined", "1");
      setIsLogined(true);
      setShowLoginModal(false);
    };

    const localTheme = localStorage.getItem('theme');
    if (localTheme === 'xbox-light') {
      setTheme(localTheme)
    }

    const localFontSize = localStorage.getItem('fontSize');
    if (localFontSize && localFontSize !== '16') {
      document.documentElement.style.fontSize = localFontSize + 'px';
    }

    void initializeLoginState();

    return () => {
      active = false;
    };
  }, [setTheme]);

  useEffect(() => {
    if (!isLogined) {
      setConsoles([]);
      return;
    }

    let active = true;

    const loadCachedConsoles = async () => {
      const storedConsoles = await Ipc.send("app", "getCachedConsoles").catch(
        () => []
      );
      if (!active) {
        return;
      }

      setConsoles(parseCachedConsoles(storedConsoles));
    };

    void loadCachedConsoles();

    return () => {
      active = false;
    };
  }, [isLogined]);

  const handleLoginSuccess = (loginInfo: any) => {
    if (!hasLoginCredential(loginInfo)) {
      throw new Error("Failed to get valid PSN login info.");
    }

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
      void Ipc.send("app", "setCachedConsoles", {
        consoles: nextConsoles,
      }).catch(() => undefined);
      return nextConsoles;
    });
  };

  const handleEditHostClick = (item: ConsoleCacheItem, index: number) => {
    setEditingConsoleIndex(index);
    setEditHostNameInput(String(item.serverNickname || "").trim());
    setEditHostIpInput(String(item.host || "").trim());
    setShowEditHostModal(true);
  };

  const handleCloseEditHostModal = () => {
    setShowEditHostModal(false);
    setEditingConsoleIndex(null);
    setEditHostNameInput("");
    setEditHostIpInput("");
  };

  const handleSaveEditedHost = () => {
    const host = editHostIpInput.trim();
    if (!host) {
      addToast({
        title: t("Host cannot be empty."),
        color: "danger",
      });
      return;
    }

    const nextName = editHostNameInput.trim();
    const targetIndex = editingConsoleIndex;
    if (!Number.isInteger(targetIndex) || targetIndex === null || targetIndex < 0) {
      handleCloseEditHostModal();
      return;
    }

    setConsoles((prevConsoles) => {
      if (targetIndex >= prevConsoles.length) {
        return prevConsoles;
      }

      const targetConsole = prevConsoles[targetIndex];
      const updatedConsole = normalizeConsoleCacheItem({
        ...targetConsole,
        serverNickname: nextName,
        host,
      });
      const nextConsoles = [...prevConsoles];
      nextConsoles[targetIndex] = updatedConsole;
      void Ipc.send("app", "setCachedConsoles", {
        consoles: nextConsoles,
      }).catch(() => undefined);
      return nextConsoles;
    });

    handleCloseEditHostModal();
  };

  const handleDeleteEditedHost = () => {
    const targetIndex = editingConsoleIndex;
    if (!Number.isInteger(targetIndex) || targetIndex === null || targetIndex < 0) {
      handleCloseEditHostModal();
      return;
    }

    setConsoles((prevConsoles) => {
      if (targetIndex >= prevConsoles.length) {
        return prevConsoles;
      }

      const nextConsoles = prevConsoles.filter((_, index) => index !== targetIndex);
      void Ipc.send("app", "setCachedConsoles", {
        consoles: nextConsoles,
      }).catch(() => undefined);
      return nextConsoles;
    });

    handleCloseEditHostModal();
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
    const streamRoute = isLinuxOrSteamOsRuntime()
      ? "webStream"
      : String(settings?.stream_renderer || "ffmpeg").trim().toLowerCase() === "webcodec"
        ? "webStream"
        : "stream";
    router.push(`/${locale}/${streamRoute}`);
  };

  return (
    <>
      <Nav current="home" isLogined={isLogined} />

      <Layout>
        {isLogined && consoles.length > 0 ? (
          <div className="flex flex-col gap-4">

            <div className="gap-4 grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4">
              {consoles.map((item, index) => (
                <ConsoleHostCard
                  key={`${item.consoleId || item.host || "console"}-${index}`}
                  item={item}
                  index={index}
                  onStartStream={handleStartStreamClick}
                  onEditHost={handleEditHostClick}
                />
              ))}
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
      <Modal isOpen={showEditHostModal} onClose={handleCloseEditHostModal} size="lg">
        <ModalContent>
          <>
            <ModalHeader>{t("Edit host")}</ModalHeader>
            <ModalBody className="gap-3">
              <Input
                label={t("Host name")}
                labelPlacement="outside"
                value={editHostNameInput}
                onValueChange={setEditHostNameInput}
              />
              <Input
                label={t("Host IP")}
                labelPlacement="outside"
                value={editHostIpInput}
                onValueChange={setEditHostIpInput}
              />
            </ModalBody>
            <ModalFooter className="w-full items-center justify-between">
              <Button color="danger" variant="light" onPress={handleDeleteEditedHost}>
                {t("Delete host")}
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="light" onPress={handleCloseEditHostModal}>
                  {tCommon("Cancel")}
                </Button>
                <Button color="primary" onPress={handleSaveEditedHost}>
                  {t("Save")}
                </Button>
              </div>
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

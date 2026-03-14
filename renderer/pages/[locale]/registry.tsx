import {
  Button,
  Card,
  CardBody,
  CardFooter,
  Chip,
  Divider,
  Input,
  Radio,
  RadioGroup,
} from "@heroui/react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import { useEffect, useRef, useState } from "react";
import Layout from "../../components/Layout";
import Nav from "../../components/Nav";
import {
  ConsoleCacheItem,
  getPsnAccountId,
  getPsnOnlineId,
  hasLoginCredential,
  LOCAL_CONSOLES_KEY,
  parseCachedConsoles,
  PSN_LOGIN_STORAGE_KEY,
  upsertConsoleCache,
  type PsnLoginInfo,
} from "../../common/remotePlay";
import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";
import Ipc from "../../lib/ipc";

type ConsoleType = "ps5" | "ps4";

type DiscoveredConsole = {
  id: string;
  host: string;
  name: string;
  type: string;
  isPs5: boolean;
  target?: number;
  stateName?: string;
  hostId?: string;
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

const buildConsoleId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `console-${Date.now()}`;
};

const mapDiscoveredConsole = (item: any): DiscoveredConsole => {
  const host = String(item?.hostAddr || "").trim();
  const hostId = String(item?.hostId || "").trim();

  return {
    id: hostId || host || buildConsoleId(),
    host,
    name: String(item?.hostName || host || "PlayStation").trim(),
    type: String(item?.hostType || (item?.isPs5 ? "PS5" : "PS4")).trim(),
    isPs5: Boolean(item?.isPs5),
    target: typeof item?.target === "number" ? item.target : undefined,
    stateName: String(item?.stateName || "").trim(),
    hostId,
  };
};

function RegistryPage() {
  const { t, i18n: { language: locale } } = useTranslation("home");
  const { t: tCommon } = useTranslation("common");
  const router = useRouter();
  const discoverRequestIdRef = useRef(0);

  const [isLogined, setIsLogined] = useState(false);
  const [consoleType, setConsoleType] = useState<ConsoleType>("ps5");
  const [consoles, setConsoles] = useState<DiscoveredConsole[]>([]);
  const [selectedConsoleId, setSelectedConsoleId] = useState("");
  const [hostInput, setHostInput] = useState("");
  const [pinInput, setPinInput] = useState("");
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [successText, setSuccessText] = useState("");

  useEffect(() => {
    const localLoginInfo = localStorage.getItem(PSN_LOGIN_STORAGE_KEY);
    if (!localLoginInfo) {
      router.replace(`/${locale}/home`);
      return;
    }

    try {
      const parsedLoginInfo = JSON.parse(localLoginInfo) as PsnLoginInfo;
      if (!hasLoginCredential(parsedLoginInfo)) {
        localStorage.removeItem(PSN_LOGIN_STORAGE_KEY);
        router.replace(`/${locale}/home`);
        return;
      }

      setIsLogined(true);
    } catch (error) {
      console.error("Invalid login cache:", error);
      localStorage.removeItem(PSN_LOGIN_STORAGE_KEY);
      router.replace(`/${locale}/home`);
    }
  }, [locale, router]);

  const refreshDiscoveredConsoles = async (type: ConsoleType = consoleType) => {
    const requestId = discoverRequestIdRef.current + 1;
    discoverRequestIdRef.current = requestId;

    setIsDiscovering(true);
    setErrorText("");
    setSuccessText("");

    try {
      const result = await Ipc.send("app", "discoverConsoles", {
        ps5: type === "ps5",
      });

      if (discoverRequestIdRef.current !== requestId) {
        return;
      }

      const discoveredConsoles = Array.isArray(result)
        ? result.map(mapDiscoveredConsole)
        : [];

      setConsoles(discoveredConsoles);

      if (discoveredConsoles.length < 1) {
        setSelectedConsoleId("");
        return;
      }

      const matchedConsole = discoveredConsoles.find(
        (item) => item.id === selectedConsoleId
      );
      const nextConsole = matchedConsole || discoveredConsoles[0];

      setSelectedConsoleId(nextConsole.id);
      setHostInput((prevHost) => nextConsole.host || prevHost);
    } catch (error) {
      if (discoverRequestIdRef.current !== requestId) {
        return;
      }

      setConsoles([]);
      setSelectedConsoleId("");
      setErrorText(getErrorMessage(error, t("Failed to discover consoles.")));
    } finally {
      if (discoverRequestIdRef.current === requestId) {
        setIsDiscovering(false);
      }
    }
  };

  useEffect(() => {
    if (!isLogined) {
      return;
    }

    void refreshDiscoveredConsoles(consoleType);
    // refreshDiscoveredConsoles intentionally captures the latest selected host state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consoleType, isLogined]);

  const handleSelectConsole = (value: string) => {
    setSelectedConsoleId(value);

    const selectedConsole = consoles.find((item) => item.id === value);
    if (selectedConsole?.host) {
      setHostInput(selectedConsole.host);
    }
  };

  const handleRegisterHost = async () => {
    const host = hostInput.trim();
    if (!host) {
      setErrorText(t("Host cannot be empty."));
      return;
    }

    if (pinInput.trim().length !== 8) {
      setErrorText(t("PIN must be 8 digits."));
      return;
    }

    const localLoginInfo = localStorage.getItem(PSN_LOGIN_STORAGE_KEY);
    if (!localLoginInfo) {
      setErrorText(t("Please login first."));
      router.replace(`/${locale}/home`);
      return;
    }

    let loginInfo: PsnLoginInfo;
    try {
      loginInfo = JSON.parse(localLoginInfo) as PsnLoginInfo;
    } catch (error) {
      console.error("Invalid login cache:", error);
      setErrorText(t("Please login first."));
      localStorage.removeItem(PSN_LOGIN_STORAGE_KEY);
      router.replace(`/${locale}/home`);
      return;
    }

    const psnAccountId = getPsnAccountId(loginInfo);
    if (!psnAccountId) {
      setErrorText(t("PSN account id is missing."));
      return;
    }

    setIsRegistering(true);
    setErrorText("");
    setSuccessText("");

    try {
      const result = await Ipc.send("app", "registerConsole", {
        host,
        pin: pinInput.trim(),
        ps5: consoleType === "ps5",
        psnAccountId,
        psnOnlineId: getPsnOnlineId(loginInfo) || undefined,
      });

      const registeredConsole = (result || {}) as ConsoleCacheItem;
      if (!registeredConsole.rpKey || !registeredConsole.rpRegistKey) {
        throw new Error(t("Failed to register host."));
      }

      const selectedConsole = consoles.find((item) => item.id === selectedConsoleId);
      const nextConsole = {
        ...registeredConsole,
        consoleId: selectedConsole?.id || buildConsoleId(),
        host,
        serverNickname:
          registeredConsole.serverNickname || selectedConsole?.name || host,
        apName:
          registeredConsole.apName ||
          selectedConsole?.type ||
          (consoleType === "ps5" ? "PS5" : "PS4"),
        hostType: selectedConsole?.type,
        hostId: selectedConsole?.hostId || selectedConsole?.id,
        isPs5: selectedConsole?.isPs5 ?? consoleType === "ps5",
        target: registeredConsole.target || selectedConsole?.target,
        stateName: selectedConsole?.stateName,
        registedTime: Date.now(),
      } satisfies ConsoleCacheItem;

      const cachedConsoles = parseCachedConsoles(
        localStorage.getItem(LOCAL_CONSOLES_KEY)
      );
      const nextConsoles = upsertConsoleCache(cachedConsoles, nextConsole);
      localStorage.setItem(LOCAL_CONSOLES_KEY, JSON.stringify(nextConsoles));

      setSuccessText(t("Host registered successfully."));
      router.push(`/${locale}/home`);
    } catch (error) {
      setErrorText(getErrorMessage(error, t("Failed to register host.")));
    } finally {
      setIsRegistering(false);
    }
  };

  return (
    <>
      <Nav isLogined={isLogined} />

      <Layout>
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-2xl font-semibold">{t("Add host")}</p>
              <p className="text-sm text-gray-500">
                {t("Register a PS host with the 8-digit PIN shown on your console.")}
              </p>
            </div>
            <Button variant="flat" onPress={() => router.push(`/${locale}/home`)}>
              {tCommon("Back")}
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <Card>
              <CardBody className="flex flex-col gap-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-lg font-semibold">{t("Select console type")}</p>
                    <p className="text-sm text-gray-500">{t("Discovered via LAN")}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="flat"
                    isLoading={isDiscovering}
                    onPress={() => void refreshDiscoveredConsoles()}
                  >
                    {tCommon("Refresh")}
                  </Button>
                </div>

                <RadioGroup
                  orientation="horizontal"
                  value={consoleType}
                  onValueChange={(value) => setConsoleType(value as ConsoleType)}
                >
                  <Radio value="ps5">PS5</Radio>
                  <Radio value="ps4">PS4</Radio>
                </RadioGroup>

                <Divider />

                {isDiscovering ? (
                  <p className="text-sm text-gray-500">
                    {t("Searching consoles on local network...")}
                  </p>
                ) : null}

                {consoles.length > 0 ? (
                  <RadioGroup value={selectedConsoleId} onValueChange={handleSelectConsole}>
                    {consoles.map((item) => {
                      const isStandby = item.stateName?.toUpperCase().includes("STANDBY");

                      return (
                        <Radio key={item.id} value={item.id}>
                          <div className="flex flex-col gap-1 py-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{item.name}</span>
                              <Chip
                                size="sm"
                                color={isStandby ? "warning" : "success"}
                                variant="flat"
                              >
                                {item.stateName || item.type}
                              </Chip>
                            </div>
                            <p className="text-xs text-gray-500 break-all">{item.host}</p>
                            <p className="text-xs text-gray-400">
                              {item.type} · {item.id}
                            </p>
                          </div>
                        </Radio>
                      );
                    })}
                  </RadioGroup>
                ) : (
                  <div className="rounded-large border border-dashed border-divider px-4 py-6">
                    <p className="text-sm text-default-600">
                      {t("No consoles found on current network. You can still enter host manually.")}
                    </p>
                  </div>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardBody className="flex flex-col gap-4">
                <div>
                  <p className="text-lg font-semibold">{t("Register host")}</p>
                  <p className="text-sm text-gray-500">
                    {t("Registration will save rpKey and rpRegistKey to local cache for later streaming.")}
                  </p>
                </div>

                {errorText ? (
                  <p className="text-danger text-sm break-all">{errorText}</p>
                ) : null}

                {successText ? (
                  <p className="text-success text-sm break-all">{successText}</p>
                ) : null}

                <Input
                  label={t("Host")}
                  labelPlacement="outside"
                  placeholder="192.168.1.100"
                  value={hostInput}
                  onValueChange={setHostInput}
                />

                <Input
                  label={t("Registration PIN")}
                  labelPlacement="outside"
                  placeholder="12345678"
                  value={pinInput}
                  onValueChange={(value) => {
                    setPinInput(value.replace(/\D/g, "").slice(0, 8));
                  }}
                />
              </CardBody>
              <Divider />
              <CardFooter className="flex items-center justify-between gap-3">
                <Button
                  variant="light"
                  onPress={() => router.push(`/${locale}/home`)}
                >
                  {tCommon("Cancel")}
                </Button>
                <Button
                  color="primary"
                  isLoading={isRegistering}
                  onPress={handleRegisterHost}
                >
                  {isRegistering ? t("Registering host...") : t("Register host")}
                </Button>
              </CardFooter>
            </Card>
          </div>
        </div>
      </Layout>
    </>
  );
}

export default RegistryPage;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "home"]);

// eslint-disable-next-line react-refresh/only-export-components
export { getStaticPaths };

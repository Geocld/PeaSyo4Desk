import { useState } from "react";
import { useTranslation } from "next-i18next";
import { useTheme } from "next-themes";
import { Button, Card, CardBody, CardFooter, Divider, addToast } from "@heroui/react";
import { ConsoleCacheItem, getWakeupCredentialFromRegistKey } from "../common/remotePlay";
import Ipc from "../lib/ipc";

type ConsoleHostCardProps = {
  item: ConsoleCacheItem;
  index: number;
  onStartStream: (item: ConsoleCacheItem) => void;
  onEditHost?: (item: ConsoleCacheItem, index: number) => void;
};

const formatRegisteredTime = (value: number | undefined) => {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");

  return `${year}/${month}/${day} ${hour}:${minute}`;
};

const resolveConsoleVariant = (item: ConsoleCacheItem) => {
  let apName = String(item.apName || "");
  let isPs5 = false;
  let isPs5Pro = false;

  if (apName) {
    apName = apName.toUpperCase();
    if (apName.includes("PS5")) {
      isPs5 = true;
      if (apName.includes("PRO")) {
        isPs5Pro = true;
      }
    }
  }

  if (!isPs5 && item.isPs5) {
    isPs5 = true;
  }

  return { isPs5, isPs5Pro };
};

const EditIcon = () => {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-6">
      <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
    </svg>
  );
};

const PowerIcon = () => {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-6">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1 0 12.728 0M12 3v8.25" />
    </svg>
  );
};

function ConsoleHostCard({ item, index, onStartStream, onEditHost }: ConsoleHostCardProps) {
  const { t } = useTranslation("home");
  const { theme, resolvedTheme } = useTheme();

  const nickname = item.serverNickname || `${t("Consoles")} ${index + 1}`;
  const consoleId = item.consoleId || "-";
  const hostText = item.host || "-";
  const registeredTimeText = formatRegisteredTime(item.registedTime);
  const { isPs5, isPs5Pro } = resolveConsoleVariant(item);
  const [waking, setWaking] = useState(false);
  const isLightTheme =
    theme === "xbox-light" || theme === "light" || resolvedTheme === "light";

  const handleWakeHost = async () => {
    const host = item.host;
    if (!host || waking) return;
    setWaking(true);
    try {
      const credential =
        item.userCredential ?? getWakeupCredentialFromRegistKey(item.rpRegistKey);
      await Ipc.send("app", "sendWakeupPacket", {
        host,
        ps5: isPs5,
        userCredential: credential || undefined,
      });
      addToast({
        title: t("WakePacketSent"),
        color: "success",
      });
    } finally {
      setWaking(false);
    }
  };

  let consoleImage = "/images/console.svg";
  if (isPs5) {
    if (isPs5Pro) {
      consoleImage = isLightTheme ? "/images/ps5pro-light.svg" : "/images/ps5pro.svg";
    } else {
      consoleImage = isLightTheme ? "/images/ps5-light.svg" : "/images/ps5.svg";
    }
  }

  console.log('item.host', item.host)

  return (
    <Card className="relative">
      {
        item.host ? (
          <Button
            size="sm"
            variant="light"
            color="warning"
            className="absolute right-12 top-2 z-10 min-w-0 px-2"
            onPress={handleWakeHost}
            aria-label={t("Wake host")}
          >
            <PowerIcon/>
          </Button>
        ) : null
      }
      {onEditHost ? (
        <Button
          size="sm"
          variant="light"
          className="absolute right-2 top-2 z-10 min-w-0 px-2 text-default-500"
          onPress={() => onEditHost(item, index)}
          aria-label={t("Edit host")}
        >
          <EditIcon/>
        </Button>
      ) : null}
      <CardBody className="pt-6">
        <p className="text-center text-base font-medium">{nickname}</p>
        <p className="text-center text-xs text-gray-500">({consoleId})</p>

        <div className="flex justify-center items-center py-3">
          <img
            src={consoleImage}
            alt={isPs5 ? (isPs5Pro ? "ps5 pro" : "ps5") : "console"}
            draggable="false"
            width={100}
            height={100}
            className={isPs5 ? "rotate-180" : ""}
          />
        </div>

        <div className="mt-2 flex flex-col gap-2 text-sm">
          <div className="flex items-start justify-between gap-3">
            <span className="text-gray-500">IP</span>
            <span className="text-right break-all">{hostText}</span>
          </div>
          <div className="flex items-start justify-between gap-3">
            <span className="text-gray-500">{t("Registered")}</span>
            <span className="text-right break-all">{registeredTimeText}</span>
          </div>
        </div>
      </CardBody>
      <Divider />
      <CardFooter>
        <Button
          color="primary"
          size="sm"
          className="w-full"
          onPress={() => onStartStream(item)}
        >
          {t("Start stream")}
        </Button>
      </CardFooter>
    </Card>
  );
}

export default ConsoleHostCard;

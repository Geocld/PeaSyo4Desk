import Image from "next/image";
import { useTranslation } from "next-i18next";
import { useTheme } from "next-themes";
import { Button, Card, CardBody, CardFooter, Divider } from "@heroui/react";
import { ConsoleCacheItem } from "../common/remotePlay";

type ConsoleHostCardProps = {
  item: ConsoleCacheItem;
  index: number;
  onStartStream: (item: ConsoleCacheItem) => void;
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

function ConsoleHostCard({ item, index, onStartStream }: ConsoleHostCardProps) {
  const { t } = useTranslation("home");
  const { theme, resolvedTheme } = useTheme();

  const nickname = item.serverNickname || `${t("Consoles")} ${index + 1}`;
  const consoleId = item.consoleId || "-";
  const hostText = item.host || "-";
  const registeredTimeText = formatRegisteredTime(item.registedTime);
  const { isPs5, isPs5Pro } = resolveConsoleVariant(item);
  const isLightTheme =
    theme === "xbox-light" || theme === "light" || resolvedTheme === "light";

  let consoleImage = "/images/console.svg";
  if (isPs5) {
    if (isPs5Pro) {
      consoleImage = isLightTheme ? "/images/ps5pro-light.svg" : "/images/ps5pro.svg";
    } else {
      consoleImage = isLightTheme ? "/images/ps5-light.svg" : "/images/ps5.svg";
    }
  }

  return (
    <Card>
      <CardBody>
        <p className="text-center text-base font-medium">{nickname}</p>
        <p className="text-center text-xs text-gray-500">({consoleId})</p>

        <div className="flex justify-center items-center py-3">
          <Image
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

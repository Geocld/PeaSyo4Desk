import { useState, useEffect } from "react";
import { useTranslation } from "next-i18next";
import { useSettings } from "../context/userContext";
import { PENDING_STREAM_STORAGE_KEY } from "../common/remotePlay";
import {
  PERFORMANCE_OPACITY_DEFAULT,
  PERFORMANCE_OPACITY_MAX,
  PERFORMANCE_OPACITY_MIN,
} from "../common/streamConstants";
import Ipc from "../lib/ipc";

type PerformProps = {
  connectState?: string;
  opacity?: number;
};

type StreamPerformance = {
  resolution?: string;
  rtt?: string;
  pl?: string;
  br?: string;
  decode?: string;
  decodeAvailable?: boolean;
};

function Perform({ connectState, opacity }: PerformProps) {
  const { t } = useTranslation('stream');
  const { settings } = useSettings();
  const [performance, setPerformance] = useState<StreamPerformance>({});
  const [isLight, setIslight] = useState(false);
  const [isRemoteSession, setIsRemoteSession] = useState(false);

  useEffect(() => {
    const localTheme = localStorage.getItem('theme');
    if (localTheme === 'xbox-light') {
      setIslight(true)
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const raw = window.sessionStorage.getItem(PENDING_STREAM_STORAGE_KEY);
      if (!raw) {
        setIsRemoteSession(false);
        return;
      }

      const pendingConfig = JSON.parse(raw);
      setIsRemoteSession(!!pendingConfig?.isRemote);
    } catch {
      setIsRemoteSession(false);
    }
  }, [connectState]);

  useEffect(() => {
    let alive = true;

    if (connectState !== "connected") {
      setPerformance({});
      return undefined;
    }

    const fetchPerformance = () => {
      Ipc.send("app", "getStreamPerformanceStats")
        .then((perf: any) => {
          if (!alive) {
            return;
          }
          setPerformance(perf || {});
        })
        .catch(() => undefined);
    };

    fetchPerformance();
    const perfInterval = setInterval(() => {
      fetchPerformance();
    }, 2000);

    return () => {
      alive = false;
      clearInterval(perfInterval);
    };
  }, [connectState]);

  const configuredResolution = Number(
    isRemoteSession ? settings?.remote_resolution : settings?.resolution
  );
  const resolutionText =
    performance.resolution ||
    (configuredResolution > 0 ? `${configuredResolution}P` : "--");

  const configuredCodec = String(
    isRemoteSession ? settings?.remote_codec : settings?.codec || "H265"
  ).toUpperCase();
  const codec = configuredCodec.indexOf("H265") > -1 ? 'HEVC' : 'AVC';
  const isFsrEnabled = !!settings?.fsr;
  const showDecode = performance.decodeAvailable !== false;
  const normalizedOpacity = Number.isFinite(Number(opacity))
    ? Math.max(PERFORMANCE_OPACITY_MIN, Math.min(PERFORMANCE_OPACITY_MAX, Number(opacity)))
    : PERFORMANCE_OPACITY_DEFAULT;
  const panelStyle = { opacity: normalizedOpacity };

  return (
    <>
      {
        settings.performance_style ? (
          <div id="performances-x" className="flex flex-row justify-center w-full">
            <span
              className={isLight ? "performance-x-wrap-light" : "performance-x-wrap"}
              style={panelStyle}
            >
              <span className="text-xs">
                {resolutionText}{isFsrEnabled ? "(FSR)" : ""} | &nbsp;
              </span>
              <span className="text-xs">
                {t("RTT")}: {performance.rtt || "--"} | &nbsp;
              </span>
              <span className="text-xs">
                {t("PL")}: {performance.pl || "--"} | &nbsp;
              </span>
              <span className="text-xs">
                {t("BT")}: {performance.br || "--"}({codec})
                {showDecode ? " | " : ""}
              </span>
              {showDecode ? (
                <span className="text-xs">
                  {t("DT")}: {performance.decode || "--"}
                </span>
              ) : null}
            </span>
          </div>
        ) : (
          <div id="performances" style={panelStyle}>
            <div className="px-1 text-sm">
              {resolutionText}{isFsrEnabled ? "(FSR)" : ""}
            </div>
            <div className="px-1 text-sm">
              {t("RTT")}: {performance.rtt || "--"}
            </div>
            <div className="px-1 text-sm">
              {t("PL")}: {performance.pl || "--"}
            </div>
            <div className="px-1 text-sm">
              {t("BT")}: {performance.br || "--"} ({codec})
            </div>
            {showDecode ? (
              <div className="px-1 text-sm">
                {t("DT")}: {performance.decode || "--"}
              </div>
            ) : null}
          </div>
        )
      }
    </>
  );
}

export default Perform;

import { useState, useEffect } from "react";
import { useTranslation } from "next-i18next";
import { useSettings } from "../context/userContext";
import Ipc from "../lib/ipc";

type PerformProps = {
  connectState?: string;
};

function Perform({ connectState }: PerformProps) {
  const { t } = useTranslation('cloud');
  const { settings } = useSettings();
  const [performance, setPerformance] = useState<any>({});
  const [isLight, setIslight] = useState(false);

  useEffect(() => {
    const localTheme = localStorage.getItem('theme');
    if (localTheme === 'xbox-light') {
      setIslight(true)
    }
  }, []);

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

  let resolutionText = '';
  if (performance.resolution) {
    resolutionText = performance.resolution;
  }

  const codec = settings.codec.indexOf('H265') > -1 ? 'HEVC' : 'AVC';

  return (
    <>
      {
        settings.performance_style ? (
          <div id="performances-x" className="flex flex-row justify-center w-full">
            <span className={isLight ? "performance-x-wrap-light" : "performance-x-wrap"}>
              <span className="text-xs">
                {resolutionText || "--"}{settings.fsr ? "(FSR)" : ""} | &nbsp;
              </span>
              <span className="text-xs">
                {t("RTT")}: {performance.rtt || "--"} | &nbsp;
              </span>
              <span className="text-xs">
                {t("PL")}: {performance.pl || "--"} | &nbsp;
              </span>
              <span className="text-xs">
                {t("Bitrate")}: {performance.br || "--"} | &nbsp;
              </span>
              <span className="text-xs">
                {t("DT")}: {performance.decode || "--"}({codec})
              </span>
            </span>
          </div>
        ) : (
          <div id="performances">
            <div className="px-1 text-sm">
              {resolutionText || "--"}{settings.fsr ? "(FSR)" : ""}
            </div>
            <div className="px-1 text-sm">
              {t("RTT")}: {performance.rtt || "--"}
            </div>
            <div className="px-1 text-sm">
              {t("PL")}: {performance.pl || "--"}
            </div>
            <div className="px-1 text-sm">
              {t("Bitrate")}: {performance.br || "--"}
            </div>
            <div className="px-1 text-sm">
              {t("DT")}: {performance.decode || "--"}({codec})
            </div>
          </div>
        )
      }
    </>
  );
}

export default Perform;

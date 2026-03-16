import { useState } from "react";
import { Button, Card, CardBody, addToast } from "@heroui/react";
import { useTranslation } from "next-i18next";
import Layout from "../../components/Layout";
import Nav from "../../components/Nav";
import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";
import Ipc from "../../lib/ipc";

function TransferPage() {
  const { t } = useTranslation("settings");
  const [actionLoading, setActionLoading] = useState<"export" | "import" | null>(null);

  const handleExport = async () => {
    setActionLoading("export");
    try {
      const result: any = await Ipc.send("app", "exportTransferConfig");
      if (result?.canceled) {
        return;
      }

      addToast({
        title: t("ExportSuccess"),
        description: String(result?.filePath || ""),
        color: "success",
      });
    } catch (error: any) {
      addToast({
        title: t("ExportFail"),
        description: String(error?.message || error || ""),
        color: "danger",
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleImport = async () => {
    setActionLoading("import");
    try {
      const result: any = await Ipc.send("app", "importTransferConfig");
      if (result?.canceled) {
        return;
      }

      addToast({
        title: t("ImportSuccess"),
        description: t("The app will restart after import succeeds."),
        color: "success",
      });

      window.sessionStorage.setItem(
        "isLogined",
        Number(result?.tokensCount || 0) > 0 ? "1" : "0"
      );

      setTimeout(() => {
        void Ipc.send("app", "restart").catch(() => undefined);
      }, 800);
    } catch (error: any) {
      addToast({
        title: t("ImportFail"),
        description: String(error?.message || error || ""),
        color: "danger",
      });
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <>
      <Nav current="settings" />

      <Layout>
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <Card>
            <CardBody className="flex flex-col gap-4">
              <div className="space-y-2">
                <h1 className="text-2xl font-semibold text-foreground">
                  {t("Configuration Transfer")}
                </h1>
                <p className="text-sm text-default-500">{t("TransferDesc")}</p>
              </div>

              <div className="rounded-large border border-divider bg-content2 px-4 py-4">
                <p className="text-base font-medium text-foreground">
                  {t("ExportSettings")}
                </p>
                <p className="mt-2 text-sm text-default-500">{t("ExportDesc")}</p>
                <p className="mt-2 text-sm text-warning">{t("ExportTips")}</p>
                <div className="mt-4 flex justify-end">
                  <Button
                    color="primary"
                    onPress={() => void handleExport()}
                    isLoading={actionLoading === "export"}
                    isDisabled={actionLoading !== null}
                  >
                    {t("ExportSettings")}
                  </Button>
                </div>
              </div>

              <div className="rounded-large border border-divider bg-content2 px-4 py-4">
                <p className="text-base font-medium text-foreground">
                  {t("ImportSettings")}
                </p>
                <p className="mt-2 text-sm text-default-500">{t("ImportDesc")}</p>
                <p className="mt-2 text-sm text-warning">
                  {t("The app will restart after import succeeds.")}
                </p>
                <div className="mt-4 flex justify-end">
                  <Button
                    color="primary"
                    variant="flat"
                    onPress={() => void handleImport()}
                    isLoading={actionLoading === "import"}
                    isDisabled={actionLoading !== null}
                  >
                    {t("ImportSettings")}
                  </Button>
                </div>
              </div>
            </CardBody>
          </Card>
        </div>
      </Layout>
    </>
  );
}

export default TransferPage;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "settings"]);

// eslint-disable-next-line react-refresh/only-export-components
export { getStaticPaths };

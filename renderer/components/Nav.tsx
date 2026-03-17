import {
  Navbar,
  NavbarBrand,
  NavbarContent,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Button,
} from "@heroui/react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import Ipc from "../lib/ipc";
import pkg from '../../package.json';

type NavSection = "home" | "settings";

type NavProps = {
  current?: NavSection;
  isLogined?: boolean;
};


const CloseIcon = () => {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-6">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
    </svg>
  );
};

const getCurrentSection = (
  pathname: string,
  current?: NavSection
): NavSection => {
  if (current) {
    return current;
  }

  if (
    pathname.endsWith("/settings") ||
    pathname.endsWith("/map") ||
    pathname.endsWith("/test") ||
    pathname.endsWith("/transfer")
  ) {
    return "settings";
  }

  return "home";
};

const isSettingsSubpage = (pathname: string) => {
  return (
    pathname.endsWith("/map") ||
    pathname.endsWith("/test") ||
    pathname.endsWith("/transfer")
  );
};

const Nav = ({ current }: NavProps) => {
  const router = useRouter();

  const { t, i18n: { language: locale } } = useTranslation("common");
  const newVersions = null;
  const currentSection = getCurrentSection(router.pathname, current);
  const showBackToSettings = isSettingsSubpage(router.pathname);

  const navItems: Array<{
    key: NavSection;
    label: string;
    href: string;
  }> = [
    {
      key: "home",
      label: t("Home"),
      href: `/${locale}/home`,
    },
    {
      key: "settings",
      label: t("Settings"),
      href: `/${locale}/settings`,
    },
  ];

  const handleExit = () => {
    void Ipc.send("app", "quit");
  };

  const handleNavigate = (href: string) => {
    if (router.asPath === href) {
      return;
    }

    void router.push(href);
  };

  const handleBackToSettings = () => {
    handleNavigate(`/${locale}/settings`);
  };

  const renderBrandInfo = () => (
    <div className="flex items-center gap-2 whitespace-nowrap">
      <p className="font-bold text-inherit">PeaSyo</p>
      {
        newVersions ? (
          <Popover color="default" placement="bottom">
            <PopoverTrigger>
              <Button color="success" size="sm" variant="light">
                {t('newVersion')}
              </Button>
            </PopoverTrigger>
            <PopoverContent>
              <div className="px-1 py-2">
                <div className="text-small">{t('curVerson')}: <span className="text-yellow-500 pl-1">v{newVersions.version}</span></div>
                <div className="text-small">{t('latestVerson')}: <span className="text-green-500 pl-1">v{newVersions.latestVer}</span></div>
                <div className="text-center">
                  <Button color="success" size="sm" variant="light" onPress={() => {
                    window.open(newVersions.url, '_blank')
                  }}>
                    {t('Download')}
                  </Button>
                </div>

              </div>
            </PopoverContent>
          </Popover>
        ) : (
          <span className="text-small text-gray-500">v{pkg.version}</span>
        )
      }
    </div>
  )

  return (
    <Navbar maxWidth="full" className="bg-background border-b border-divider" style={{ zIndex: 100 }}>

      <NavbarBrand className="grow-0 shrink-0 px-2">
        {renderBrandInfo()}
      </NavbarBrand>

      <NavbarContent as="div" justify="end" className="flex-1 basis-0 gap-5">
        {showBackToSettings ? (
          <Button
            size="sm"
            radius="full"
            variant="flat"
            onPress={handleBackToSettings}
          >
            {t("Back")}
          </Button>
        ) : null}

        <div className="flex items-center gap-5">
          {navItems.map((item) => {
            const isActive = item.key === currentSection;

            return (
              <Button
                key={item.key}
                size="sm"
                radius="full"
                color={isActive ? "primary" : "default"}
                variant={isActive ? "solid" : "light"}
                className={isActive ? "font-semibold" : "text-default-600"}
                onPress={() => handleNavigate(item.href)}
              >
                {item.label}
              </Button>
            );
          })}
        </div>

        <Button size="sm" isIconOnly aria-label="close" color="danger" onPress={handleExit}>
          <CloseIcon />
        </Button>

        {/* <Button
          size="sm"
          radius="full"
          color="danger"
          variant="flat"
          className="min-w-0 px-3 font-semibold"
          aria-label={t("Exit")}
          onPress={handleExit}
        >
          x
        </Button> */}
      </NavbarContent>

    </Navbar >
  );
};

export default Nav;

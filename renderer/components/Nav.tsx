import {
  Navbar,
  NavbarBrand,
  NavbarContent,
  DropdownItem,
  DropdownTrigger,
  Dropdown,
  DropdownMenu,
  Avatar,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Button,
} from "@heroui/react";

import { useTranslation } from "next-i18next";
import Ipc from "../lib/ipc";
import pkg from '../../package.json';

const Nav = () => {

  const { t, i18n: { language: locale } } = useTranslation("common");
  const newVersions = null;

  const handleExit = () => {
    Ipc.send("app", "quit")
  }

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

      <NavbarContent as="div" justify="end" className="flex-1 basis-0 gap-2">

        <Dropdown
          placement="bottom-end"
          shouldBlockScroll={false}
          classNames={{
            content: "bg-content1 border border-divider text-foreground min-w-[200px]"
          }}
        >
          <DropdownTrigger>
            <Button
              variant="flat"
              className="bg-content1/50 border border-divider hover:bg-content2 h-10 px-2 pl-1 shadow-sm transition-all rounded-full"
            >
              <Avatar
                isBordered
                color="success"
                name={'Geocld'}
                size="sm"
                src={'https://i.pravatar.cc/150?u=a042581f4e29026024d'}
                className="w-7 h-7"
              />
            </Button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label="Profile Actions"
            variant="flat"
            itemClasses={{
              base: [
                "data-[hover=true]:bg-content2",
                "data-[hover=true]:text-foreground",
                "text-default-700 font-medium py-2"
              ]
            }}
          >
            <DropdownItem key="settings" onPress={() => window.location.assign(`/${locale}/settings`)} showDivider>
              {t('Settings')}
            </DropdownItem>
            <DropdownItem key="exit" className="text-danger" color="danger" onPress={handleExit}>
              {t('Exit')}
            </DropdownItem>
          </DropdownMenu>
        </Dropdown>
      </NavbarContent>

    </Navbar >
  );
};

export default Nav;

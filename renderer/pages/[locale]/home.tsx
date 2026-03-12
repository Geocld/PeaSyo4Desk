import {
  Button,
  Card,
  CardBody,
  CardFooter,
  Chip,
  Divider,
} from "@heroui/react";
import { useTranslation } from "next-i18next";
import { useTheme } from "next-themes";
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from "react";
import Layout from "../../components/Layout";
import Loading from "../../components/Loading";
import Nav from "../../components/Nav";
import { useSettings } from "../../context/userContext";
import Ipc from "../../lib/ipc";

import Image from "next/image";
import { FOCUS_ELEMS } from '../../common/constans';

import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";

const LOCAL_CONSOLES = 'local-consoles';

function Home() {
  const { t, i18n: { language: locale } } = useTranslation('home');

  const { theme, setTheme } = useTheme();
  const [isLogined, setIsLogined] = useState(false);

  useEffect(() => {
    const localTheme = localStorage.getItem('theme');
    if (localTheme === 'xbox-light') {
      setTheme(localTheme)
    }

    const localFontSize = localStorage.getItem('fontSize');
    if (localFontSize && localFontSize !== '16') {
      document.documentElement.style.fontSize = localFontSize + 'px';
    }
  }, [t, setTheme]);

  return (
    <>
      <Nav isLogined={isLogined} />

      <Layout>
        <div className="gap-4 grid grid-cols-3">
          home
        </div>
      </Layout>
    </>
  );
}

export default Home;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "home"]);

// eslint-disable-next-line react-refresh/only-export-components
export { getStaticPaths };
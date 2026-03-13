import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import Nav from "../../components/Nav";
import PsnLoginModals from "../../components/PsnLoginModals";

import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";

const PSN_LOGIN_STORAGE_KEY = "psn-login-info";

const hasLoginCredential = (loginInfo: any) => {
  return Boolean(loginInfo?.accessToken || loginInfo?.userInfo?.account_id);
};

function Home() {
  const { setTheme } = useTheme();
  const [isLogined, setIsLogined] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);

  useEffect(() => {
    const localTheme = localStorage.getItem('theme');
    if (localTheme === 'xbox-light') {
      setTheme(localTheme)
    }

    const localFontSize = localStorage.getItem('fontSize');
    if (localFontSize && localFontSize !== '16') {
      document.documentElement.style.fontSize = localFontSize + 'px';
    }

    const localLoginInfo = localStorage.getItem(PSN_LOGIN_STORAGE_KEY);
    if (!localLoginInfo) {
      window.sessionStorage.setItem("isLogined", "0");
      setIsLogined(false);
      setShowLoginModal(true);
      return;
    }

    try {
      const parsedLoginInfo = JSON.parse(localLoginInfo);
      if (hasLoginCredential(parsedLoginInfo)) {
        window.sessionStorage.setItem("isLogined", "1");
        setIsLogined(true);
        setShowLoginModal(false);
      } else {
        localStorage.removeItem(PSN_LOGIN_STORAGE_KEY);
        window.sessionStorage.setItem("isLogined", "0");
        setIsLogined(false);
        setShowLoginModal(true);
      }
    } catch (error) {
      console.error("Invalid login cache:", error);
      localStorage.removeItem(PSN_LOGIN_STORAGE_KEY);
      window.sessionStorage.setItem("isLogined", "0");
      setIsLogined(false);
      setShowLoginModal(true);
    }
  }, [setTheme]);

  const handleLoginSuccess = (loginInfo: any) => {
    if (!hasLoginCredential(loginInfo)) {
      throw new Error("Failed to get valid PSN login info.");
    }

    localStorage.setItem(PSN_LOGIN_STORAGE_KEY, JSON.stringify(loginInfo));
    window.sessionStorage.setItem("isLogined", "1");
    setIsLogined(true);
    setShowLoginModal(false);
  };

  return (
    <>
      <Nav isLogined={isLogined} />

      <Layout>
        <div className="gap-4 grid grid-cols-3">
          home
        </div>
      </Layout>

      <PsnLoginModals show={showLoginModal} onLoginSuccess={handleLoginSuccess} />
    </>
  );
}

export default Home;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "home"]);

// eslint-disable-next-line react-refresh/only-export-components
export { getStaticPaths };

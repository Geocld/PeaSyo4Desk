import Layout from "../../components/Layout";
import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";

function StreamPage() {
  return (
    <Layout>
      <div className="flex flex-col gap-4 h-[calc(100vh-120px)]">
        111
      </div>
    </Layout>
  );
}

export default StreamPage;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "home"]);

// eslint-disable-next-line react-refresh/only-export-components
export { getStaticPaths };

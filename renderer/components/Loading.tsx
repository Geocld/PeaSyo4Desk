import { HashLoader } from "react-spinners";

const Loading = ({ loadingText }) => {
  return (
    <div className="loading user-select-none">
      <HashLoader
        color={'#DF6069'}
        loading={true}
        size={50}
        aria-label="Loading Spinner"
        data-testid="loader"
      />
      <div className="loadingText">{loadingText}</div>
    </div>
  );
};

export default Loading;

import {Spinner} from "@heroui/react";

const Loading = ({ loadingText }) => {
  return (
    <div className="loading user-select-none">
      <Spinner color="danger"/>
      <div className="loadingText">{loadingText}</div>
    </div>
  );
};

export default Loading;

import { useEffect, useRef, useState } from "react";
import Layout from "../../components/Layout";
import { getStaticPaths, makeStaticProperties } from "../../lib/get-static";
import Ipc from "../../lib/ipc";

function StreamPage() {
  const [status, setStatus] = useState("initializing");
  const [wsUrl, setWsUrl] = useState("");
  const [lastMessage, setLastMessage] = useState("");
  const [outgoingMessage, setOutgoingMessage] = useState("hello websocket");
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let active = true;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const start = async () => {
      try {
        const serverInfo: any = await Ipc.send("app", "startStreamWebSocketServer");
        if (!active) return;

        const url = `ws://${serverInfo.host}:${serverInfo.port}${serverInfo.path}`;
        setWsUrl(url);
        setStatus("connecting");

        const socket = new WebSocket(url);
        socketRef.current = socket;

        socket.onopen = () => {
          if (!active) return;
          setStatus("connected");
          socket?.send(JSON.stringify({ type: "ping" }));
          pingTimer = setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "ping" }));
            }
          }, 15000);
        };

        socket.onmessage = (event) => {
          if (!active) return;
          setLastMessage(String(event.data));
        };

        socket.onerror = () => {
          if (!active) return;
          setStatus("error");
        };

        socket.onclose = () => {
          if (!active) return;
          setStatus("closed");
          if (socketRef.current === socket) {
            socketRef.current = null;
          }
        };
      } catch (error: any) {
        setStatus(`failed: ${error?.message || String(error)}`);
      }
    };

    start();

    return () => {
      active = false;
      if (pingTimer) {
        clearInterval(pingTimer);
      }
      if (socketRef.current && socketRef.current.readyState < WebSocket.CLOSING) {
        socketRef.current.close();
      }
      socketRef.current = null;
      Ipc.send("app", "stopStreamWebSocketServer").catch(() => undefined);
    };
  }, []);

  const sendTestMessage = () => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStatus("socket not connected");
      return;
    }

    const payload = {
      type: "client_message",
      message: outgoingMessage,
      ts: Date.now(),
    };
    socket.send(JSON.stringify(payload));
  };

  return (
    <Layout>
      <div className="flex flex-col gap-2 h-[calc(100vh-120px)] p-4 text-sm max-w-2xl">
        <div>WebSocket status: {status}</div>
        <div>WebSocket url: {wsUrl || "-"}</div>
        <div>Last message: {lastMessage || "-"}</div>
        <div className="flex gap-2 mt-2">
          <input
            className="border rounded px-2 py-1 flex-1 bg-transparent"
            value={outgoingMessage}
            onChange={(event) => setOutgoingMessage(event.target.value)}
            placeholder="message to websocket"
          />
          <button
            type="button"
            className="border rounded px-3 py-1"
            onClick={sendTestMessage}
          >
            Send
          </button>
        </div>
      </div>
    </Layout>
  );
}

export default StreamPage;

// eslint-disable-next-line react-refresh/only-export-components
export const getStaticProps = makeStaticProperties(["common", "home"]);

// eslint-disable-next-line react-refresh/only-export-components
export { getStaticPaths };

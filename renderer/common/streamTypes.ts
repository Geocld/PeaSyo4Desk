// Shared type definitions used by both stream.tsx and webStream.tsx

import type { StreamTouchPoint as TouchPoint } from "../components/stream/Touchpad";

export type PendingStreamConfig = {
  streamHost?: string;
  isRemote?: boolean;
  autoRemote?: boolean;
  consoleInfo?: {
    apName?: string;
    host?: string;
    remoteHost?: string;
    parsedRemoteHost?: string;
    rpRegistKey?: string;
    rpKey?: string;
    registKey?: string;
    morning?: string;
  };
};

export type ControllerStatePayload = {
  buttons: number;
  l2State: number;
  r2State: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
  touchIdNext: number;
  touches: [TouchPoint, TouchPoint];
};

export type ControllerInputButtonLike = {
  pressed?: boolean;
  value?: number;
} | null | undefined;

export type ControllerInputSource = {
  axes: ArrayLike<number>;
  buttons: ArrayLike<ControllerInputButtonLike>;
};

export type VideoDisplayFormat = "default" | "stretch" | "zoom";
export type ControllerInputKernel = "web" | "node";
export type TouchpadVerticalPosition = "top" | "center" | "bottom";

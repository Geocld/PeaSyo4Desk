import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MAX_CONTROLLER_TOUCH_ID } from "../common/streamConstants";
import type {
  StreamTouchPoint,
  StreamTouchState,
} from "../components/stream/Touchpad";

const TOUCHPAD_WIDTH_DS4 = 1920;
const TOUCHPAD_HEIGHT_DS4 = 942;
const TOUCHPAD_WIDTH_DS5 = 1919;
const TOUCHPAD_HEIGHT_DS5 = 1079;
const PRIMARY_MOUSE_BUTTON = 0;
const PRIMARY_MOUSE_BUTTON_MASK = 1;

type PointerTarget = HTMLDivElement;

type PointerCoordinates = {
  clientX: number;
  clientY: number;
};

type ActiveMouseTouch = PointerCoordinates & {
  pointerId: number;
  touchId: number;
};

type UseStreamMouseTouchpadFallbackOptions = {
  active: boolean;
  isPs5: boolean;
  getTouchIdNext?: () => number;
  onTap: () => void;
  onTouchStateChange: (state: StreamTouchState) => void;
};

const clamp = (value: number, min: number, max: number) => {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const normalizeTouchIdNext = (value: number) => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const normalized = Math.trunc(value) % (MAX_CONTROLLER_TOUCH_ID + 1);
  return normalized < 0 ? normalized + MAX_CONTROLLER_TOUCH_ID + 1 : normalized;
};

const buildIdleTouchState = (touchIdNext: number): StreamTouchState => ({
  touchIdNext,
  touches: [{ id: -1 }, { id: -1 }],
});

const resolveTouchpadSize = (isPs5: boolean) => {
  if (isPs5) {
    return {
      width: TOUCHPAD_WIDTH_DS5,
      height: TOUCHPAD_HEIGHT_DS5,
    };
  }

  return {
    width: TOUCHPAD_WIDTH_DS4,
    height: TOUCHPAD_HEIGHT_DS4,
  };
};

export function useStreamMouseTouchpadFallback({
  active,
  isPs5,
  getTouchIdNext,
  onTap,
  onTouchStateChange,
}: UseStreamMouseTouchpadFallbackOptions) {
  const containerRef = useRef<PointerTarget | null>(null);
  const activeTouchRef = useRef<ActiveMouseTouch | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const nextTouchIdRef = useRef(0);

  const allocateTouchId = useCallback(() => {
    const currentTouchId = normalizeTouchIdNext(
      getTouchIdNext?.() ?? nextTouchIdRef.current
    );
    nextTouchIdRef.current = normalizeTouchIdNext(currentTouchId + 1);
    return currentTouchId;
  }, [getTouchIdNext]);

  const toTouchPoint = useCallback(
    (coordinates: PointerCoordinates, touchId: number): StreamTouchPoint => {
      const element = containerRef.current;
      const touchpadSize = resolveTouchpadSize(isPs5);
      if (!element) {
        return { id: touchId, x: 0, y: 0 };
      }

      const rect = element.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const localX = clamp(coordinates.clientX - rect.left, 0, width);
      const localY = clamp(coordinates.clientY - rect.top, 0, height);

      return {
        id: touchId,
        x: Math.round((localX / width) * (touchpadSize.width - 1)),
        y: Math.round((localY / height) * (touchpadSize.height - 1)),
      };
    },
    [isPs5]
  );

  const emitActiveTouch = useCallback(
    (touch: ActiveMouseTouch) => {
      onTouchStateChange({
        touchIdNext: nextTouchIdRef.current,
        touches: [toTouchPoint(touch, touch.touchId), { id: -1 }],
      });
    },
    [onTouchStateChange, toTouchPoint]
  );

  const releasePointerCapture = useCallback((pointerId: number) => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    try {
      if (element.hasPointerCapture(pointerId)) {
        element.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore renderer/platform pointer-capture edge cases.
    }
  }, []);

  const releaseTouch = useCallback(() => {
    const activePointerId = activePointerIdRef.current;
    if (activePointerId !== null) {
      activePointerIdRef.current = null;
      releasePointerCapture(activePointerId);
    }

    if (activeTouchRef.current) {
      activeTouchRef.current = null;
      onTouchStateChange(buildIdleTouchState(nextTouchIdRef.current));
    }
  }, [onTouchStateChange, releasePointerCapture]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<PointerTarget>) => {
      if (!active || event.pointerType !== "mouse") {
        return;
      }

      event.preventDefault();
      if (event.button !== PRIMARY_MOUSE_BUTTON) {
        onTap();
        return;
      }

      activePointerIdRef.current = event.pointerId;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Ignore capture failures; window-level release listeners still clean up.
      }
    },
    [active, onTap]
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<PointerTarget>) => {
      if (!active || event.pointerType !== "mouse") {
        return;
      }

      if (event.buttons !== PRIMARY_MOUSE_BUTTON_MASK) {
        const touch = activeTouchRef.current;
        if (touch && touch.pointerId === event.pointerId) {
          releaseTouch();
        }
        return;
      }

      if (activePointerIdRef.current === null) {
        activePointerIdRef.current = event.pointerId;
      }
      if (activePointerIdRef.current !== event.pointerId) {
        return;
      }

      let touch = activeTouchRef.current;
      if (!touch || touch.pointerId !== event.pointerId) {
        touch = {
          pointerId: event.pointerId,
          touchId: allocateTouchId(),
          clientX: event.clientX,
          clientY: event.clientY,
        };
        activeTouchRef.current = touch;
      } else {
        touch.clientX = event.clientX;
        touch.clientY = event.clientY;
      }

      event.preventDefault();
      emitActiveTouch(touch);
    },
    [active, allocateTouchId, emitActiveTouch, releaseTouch]
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<PointerTarget>) => {
      if (event.pointerType !== "mouse" || event.button !== PRIMARY_MOUSE_BUTTON) {
        return;
      }

      const activePointerId = activePointerIdRef.current;
      if (activePointerId !== null && activePointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      releaseTouch();
    },
    [releaseTouch]
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<PointerTarget>) => {
      const touch = activeTouchRef.current;
      const activePointerId = activePointerIdRef.current;
      if (
        (touch && touch.pointerId === event.pointerId) ||
        activePointerId === event.pointerId
      ) {
        releaseTouch();
      }
    },
    [releaseTouch]
  );

  const onContextMenu = useCallback(
    (event: ReactMouseEvent<PointerTarget>) => {
      if (active) {
        event.preventDefault();
      }
    },
    [active]
  );

  useEffect(() => {
    if (!active) {
      releaseTouch();
    }
  }, [active, releaseTouch]);

  useEffect(() => {
    const handleBlur = () => {
      releaseTouch();
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        releaseTouch();
      }
    };

    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      releaseTouch();
    };
  }, [releaseTouch]);

  useEffect(() => {
    const handleWindowPointerUp = (event: PointerEvent) => {
      if (
        event.pointerType === "mouse" &&
        event.button === PRIMARY_MOUSE_BUTTON &&
        activePointerIdRef.current === event.pointerId
      ) {
        releaseTouch();
      }
    };
    const handleWindowPointerCancel = (event: PointerEvent) => {
      if (
        event.pointerType === "mouse" &&
        activePointerIdRef.current === event.pointerId
      ) {
        releaseTouch();
      }
    };

    window.addEventListener("pointerup", handleWindowPointerUp, true);
    window.addEventListener("pointercancel", handleWindowPointerCancel, true);

    return () => {
      window.removeEventListener("pointerup", handleWindowPointerUp, true);
      window.removeEventListener("pointercancel", handleWindowPointerCancel, true);
      releaseTouch();
    };
  }, [releaseTouch]);

  return {
    containerRef,
    onContextMenu,
    onPointerCancel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}

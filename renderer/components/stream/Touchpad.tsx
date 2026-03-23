import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";

const TOUCHPAD_WIDTH_DS4 = 1920;
const TOUCHPAD_HEIGHT_DS4 = 942;
const TOUCHPAD_WIDTH_DS5 = 1919;
const TOUCHPAD_HEIGHT_DS5 = 1079;
const MAX_TOUCH_ID = 127;
const TAP_MAX_DURATION_MS = 220;
const TAP_MAX_DISTANCE_PX = 16;
const GRID_SPACING_PX = 18;
const TRAIL_MAX_POINTS = 56;
const RIPPLE_DURATION_MS = 240;

type Point = {
  x: number;
  y: number;
};

type ActivePointer = {
  pointerId: number;
  slot: 0 | 1;
  touchId: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  startedAt: number;
  trail: Point[];
};

type RippleEffect = {
  x: number;
  y: number;
  startedAt: number;
};

export type StreamTouchPoint = {
  id: number;
  x?: number;
  y?: number;
};

export type StreamTouchState = {
  touchIdNext: number;
  touches: [StreamTouchPoint, StreamTouchPoint];
};

type TouchpadProps = {
  className?: string;
  isPs5?: boolean;
  scale?: number;
  opacity?: number;
  visible: boolean;
  onActivity?: () => void;
  onTap?: () => void;
  onTouchStateChange: (state: StreamTouchState) => void;
};

const BASE_WIDTH_PX = 280;
const BASE_HEIGHT_PX = 160;

const clamp = (value: number, min: number, max: number) => {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const buildIdleTouchState = (touchIdNext: number): StreamTouchState => ({
  touchIdNext,
  touches: [{ id: -1 }, { id: -1 }],
});

export default function Touchpad({
  className = "",
  isPs5 = true,
  scale = 1,
  opacity = 0.6,
  visible,
  onActivity,
  onTap,
  onTouchStateChange,
}: TouchpadProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activePointersRef = useRef<Map<number, ActivePointer>>(new Map());
  const rippleEffectsRef = useRef<RippleEffect[]>([]);
  const nextTouchIdRef = useRef(0);
  const visibleRef = useRef(visible);
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef({
    width: BASE_WIDTH_PX,
    height: BASE_HEIGHT_PX,
    dpr: 1,
  });
  const normalizedScale = clamp(scale, 0.5, 2);
  const normalizedOpacity = clamp(opacity, 0, 0.8);
  const targetWidth = Math.round(BASE_WIDTH_PX * normalizedScale);
  const targetHeight = Math.round(BASE_HEIGHT_PX * normalizedScale);

  const resolveTouchpadSize = () => {
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

  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) {
      return;
    }

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      const { width, height, dpr } = sizeRef.current;
      if (width < 1 || height < 1) {
        return;
      }

      const now = performance.now();
      const activePointers = Array.from(activePointersRef.current.values());
      rippleEffectsRef.current = rippleEffectsRef.current.filter(
        (ripple) => now - ripple.startedAt <= RIPPLE_DURATION_MS
      );

      const hasTransientVisual =
        activePointers.length > 0 || rippleEffectsRef.current.length > 0;
      if (!visibleRef.current && !hasTransientVisual) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = "rgba(17, 24, 39, 0.45)";
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
      for (let x = 0; x <= width; x += GRID_SPACING_PX) {
        for (let y = 0; y <= height; y += GRID_SPACING_PX) {
          ctx.fillRect(x, y, 1.5, 1.5);
        }
      }

      const colors = ["#f87171", "#60a5fa"] as const;
      for (const pointer of activePointers) {
        const color = colors[pointer.slot];

        if (pointer.trail.length > 1) {
          ctx.beginPath();
          ctx.lineWidth = 5;
          ctx.strokeStyle = color;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.moveTo(pointer.trail[0].x, pointer.trail[0].y);
          for (let i = 1; i < pointer.trail.length; i += 1) {
            const point = pointer.trail[i];
            ctx.lineTo(point.x, point.y);
          }
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.9;
        ctx.arc(pointer.x, pointer.y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      for (const ripple of rippleEffectsRef.current) {
        const progress = clamp((now - ripple.startedAt) / RIPPLE_DURATION_MS, 0, 1);
        const radius = 8 + progress * 26;
        const alpha = 0.5 * (1 - progress);
        ctx.beginPath();
        ctx.strokeStyle = `rgba(248, 113, 113, ${alpha})`;
        ctx.lineWidth = 2;
        ctx.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (visibleRef.current || hasTransientVisual) {
        scheduleDraw();
      }
    });
  }, []);

  const resizeCanvas = useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    sizeRef.current = {
      width,
      height,
      dpr,
    };

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }, []);

  const getSlotForPointer = (pointerType: string): 0 | 1 | null => {
    const activeSlots = new Set(
      Array.from(activePointersRef.current.values()).map((pointer) => pointer.slot)
    );

    if (pointerType === "mouse") {
      return activeSlots.has(0) ? null : 0;
    }

    if (!activeSlots.has(0)) {
      return 0;
    }
    if (!activeSlots.has(1)) {
      return 1;
    }

    return null;
  };

  const allocateTouchId = () => {
    const currentTouchId = nextTouchIdRef.current;
    nextTouchIdRef.current = (currentTouchId + 1) % (MAX_TOUCH_ID + 1);
    return currentTouchId;
  };

  const toLocalPoint = (event: ReactPointerEvent<HTMLDivElement>): Point => {
    const element = containerRef.current;
    if (!element) {
      return { x: 0, y: 0 };
    }

    const rect = element.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    return { x, y };
  };

  const toNormalizedTouchPoint = (point: Point): StreamTouchPoint => {
    const { width: domWidth, height: domHeight } = sizeRef.current;
    const touchpadSize = resolveTouchpadSize();
    const normalizedX = Math.round((point.x / domWidth) * (touchpadSize.width - 1));
    const normalizedY = Math.round((point.y / domHeight) * (touchpadSize.height - 1));
    return {
      id: 0,
      x: clamp(normalizedX, 0, touchpadSize.width - 1),
      y: clamp(normalizedY, 0, touchpadSize.height - 1),
    };
  };

  const emitTouchState = () => {
    const touches: [StreamTouchPoint, StreamTouchPoint] = [{ id: -1 }, { id: -1 }];
    for (const pointer of activePointersRef.current.values()) {
      const normalized = toNormalizedTouchPoint({
        x: pointer.x,
        y: pointer.y,
      });
      touches[pointer.slot] = {
        id: pointer.touchId,
        x: normalized.x,
        y: normalized.y,
      };
    }

    onTouchStateChange({
      touchIdNext: nextTouchIdRef.current,
      touches,
    });
  };

  const releasePointer = (
    pointerId: number,
    pointerType: string,
    point?: Point
  ) => {
    const pointer = activePointersRef.current.get(pointerId);
    if (!pointer) {
      return;
    }

    if (point) {
      pointer.x = point.x;
      pointer.y = point.y;
      pointer.trail.push(point);
      if (pointer.trail.length > TRAIL_MAX_POINTS) {
        pointer.trail.shift();
      }
    }

    const duration = performance.now() - pointer.startedAt;
    const travel = Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY);
    const isTap = duration <= TAP_MAX_DURATION_MS && travel <= TAP_MAX_DISTANCE_PX;

    rippleEffectsRef.current.push({
      x: pointer.x,
      y: pointer.y,
      startedAt: performance.now(),
    });
    activePointersRef.current.delete(pointerId);
    emitTouchState();

    if (isTap && pointerType !== "pen") {
      onTap?.();
    }

    scheduleDraw();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    onActivity?.();

    const slot = getSlotForPointer(event.pointerType);
    if (slot === null) {
      return;
    }

    const point = toLocalPoint(event);
    const touchId = allocateTouchId();
    const pointer: ActivePointer = {
      pointerId: event.pointerId,
      slot,
      touchId,
      x: point.x,
      y: point.y,
      startX: point.x,
      startY: point.y,
      startedAt: performance.now(),
      trail: [point],
    };

    activePointersRef.current.set(event.pointerId, pointer);
    if (containerRef.current) {
      try {
        containerRef.current.setPointerCapture(event.pointerId);
      } catch {
        // ignore capture failures
      }
    }

    emitTouchState();
    scheduleDraw();

    if (event.pointerType !== "mouse") {
      event.preventDefault();
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = activePointersRef.current.get(event.pointerId);
    if (!pointer) {
      return;
    }

    if (event.pointerType === "mouse" && (event.buttons & 1) !== 1) {
      releasePointer(event.pointerId, event.pointerType, toLocalPoint(event));
      return;
    }

    onActivity?.();

    const point = toLocalPoint(event);
    pointer.x = point.x;
    pointer.y = point.y;

    const lastPoint = pointer.trail[pointer.trail.length - 1];
    if (!lastPoint || Math.hypot(lastPoint.x - point.x, lastPoint.y - point.y) > 1) {
      pointer.trail.push(point);
      if (pointer.trail.length > TRAIL_MAX_POINTS) {
        pointer.trail.shift();
      }
    }

    emitTouchState();
    scheduleDraw();

    if (event.pointerType !== "mouse") {
      event.preventDefault();
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    releasePointer(event.pointerId, event.pointerType, toLocalPoint(event));
    if (event.pointerType !== "mouse") {
      event.preventDefault();
    }
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    releasePointer(event.pointerId, event.pointerType);
  };

  useEffect(() => {
    visibleRef.current = visible;
    scheduleDraw();
  }, [scheduleDraw, visible]);

  useEffect(() => {
    resizeCanvas();
    scheduleDraw();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && containerRef.current) {
      observer = new ResizeObserver(() => {
        resizeCanvas();
        scheduleDraw();
      });
      observer.observe(containerRef.current);
    }

    const onResize = () => {
      resizeCanvas();
      scheduleDraw();
    };
    window.addEventListener("resize", onResize);

    return () => {
      if (observer) {
        observer.disconnect();
      }
      window.removeEventListener("resize", onResize);
    };
  }, [resizeCanvas, scheduleDraw]);

  useEffect(() => {
    resizeCanvas();
    scheduleDraw();
  }, [resizeCanvas, scheduleDraw, targetWidth, targetHeight]);

  useEffect(() => {
    const activePointers = activePointersRef.current;
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      activePointers.clear();
      rippleEffectsRef.current = [];
      onTouchStateChange(buildIdleTouchState(nextTouchIdRef.current));
    };
  }, [onTouchStateChange]);

  return (
    <div className={`${visible ? "pointer-events-auto" : "pointer-events-none"} ${className}`}>
      <div
        ref={containerRef}
        className={`relative overflow-hidden rounded-2xl border border-white/30 transition-opacity duration-200 ${
          visible ? "pointer-events-auto" : "pointer-events-none"
        } ${
          visible ? "opacity-100" : "opacity-0"
        }`}
        style={{
          width: `${targetWidth}px`,
          height: `${targetHeight}px`,
          opacity: visible ? normalizedOpacity : 0,
          touchAction: "none",
          background:
            "linear-gradient(135deg, rgba(30,41,59,0.52) 0%, rgba(15,23,42,0.35) 100%)",
        }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        <canvas ref={canvasRef} className="h-full w-full" />
      </div>
    </div>
  );
}

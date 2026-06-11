import { app as ElectronApp } from "electron";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from "node:fs";
import path from "node:path";

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_LOG_FILES = 3;
const LOG_FILE_PREFIX = "stream-";
const LOG_FILE_SUFFIX = ".log";
const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_PATTERN =
  /access_?token|refresh_?token|token|authorization|secret|password|account_?id|duid|rp_?key|rp_?regist_?key|regist_?key|morning|pin$/i;

const sanitizeText = (value: string) => {
  return value
    .replace(/(accessToken|refreshToken|token|authorization|rpKey|rpRegistKey|registKey|morning|account_id|duid|pin)\s*[:=]\s*["']?[^"',\s}]+/gi, `$1=${REDACTED}`)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
};

const sanitizeValue = (value: unknown, key = "", depth = 0): unknown => {
  if (SENSITIVE_KEY_PATTERN.test(key) || key === "text") {
    return REDACTED;
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return sanitizeText(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer:${value.byteLength}]`;
  }

  if (value instanceof Uint8Array) {
    return `[Uint8Array:${value.byteLength}]`;
  }

  if (Array.isArray(value)) {
    if (depth > 4) {
      return "[MaxDepth]";
    }
    return value.slice(0, 64).map((item) => sanitizeValue(item, "", depth + 1));
  }

  if (typeof value === "object") {
    if (depth > 4) {
      return "[MaxDepth]";
    }

    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = sanitizeValue(entryValue, entryKey, depth + 1);
    }
    return output;
  }

  return String(value);
};

const formatTimestampForFile = (date: Date) => {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "-",
    pad(date.getMilliseconds(), 3),
  ].join("");
};

const rotateLogFiles = (logsDir: string) => {
  const entries = readdirSync(logsDir)
    .filter((entry) => entry.startsWith(LOG_FILE_PREFIX) && entry.endsWith(LOG_FILE_SUFFIX))
    .map((entry) => {
      const filePath = path.join(logsDir, entry);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        // ignore stat failures
      }
      return { filePath, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const entry of entries.slice(MAX_LOG_FILES - 1)) {
    try {
      unlinkSync(entry.filePath);
    } catch {
      // ignore cleanup failures
    }
  }
};

export type VerboseStreamLogFile = {
  filePath: string;
  fileName: string;
  mtimeMs: number;
  size: number;
};

export type VerboseStreamLogger = {
  enabled: boolean;
  filePath?: string;
  write(scope: string, message: string, details?: unknown): void;
  close(): void;
};

export const getVerboseStreamLogsDir = () => ElectronApp.getPath("logs");

export const getVerboseStreamLogFiles = (): VerboseStreamLogFile[] => {
  const logsDir = getVerboseStreamLogsDir();
  if (!existsSync(logsDir)) {
    return [];
  }

  return readdirSync(logsDir)
    .filter((entry) => entry.startsWith(LOG_FILE_PREFIX) && entry.endsWith(LOG_FILE_SUFFIX))
    .map((entry) => {
      const filePath = path.join(logsDir, entry);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) {
          return null;
        }
        return {
          filePath,
          fileName: entry,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is VerboseStreamLogFile => !!entry)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
};

export const startVerboseStreamLog = (
  enabled: boolean,
  context: Record<string, unknown>
): VerboseStreamLogger => {
  if (!enabled) {
    return {
      enabled: false,
      write: () => undefined,
      close: () => undefined,
    };
  }

  const logsDir = getVerboseStreamLogsDir();
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  rotateLogFiles(logsDir);

  const startedAt = Date.now();
  const filePath = path.join(
    logsDir,
    `${LOG_FILE_PREFIX}${formatTimestampForFile(new Date(startedAt))}-${process.pid}${LOG_FILE_SUFFIX}`
  );
  const stream = createWriteStream(filePath, { flags: "a" });
  let bytesWritten = 0;
  let capped = false;
  let closed = false;

  const writeLine = (scope: string, message: string, details?: unknown) => {
    if (closed || capped) {
      return;
    }

    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        scope,
        message: sanitizeText(message),
        ...(details === undefined ? {} : { details: sanitizeValue(details) }),
      }) + "\n";
    const lineBytes = Buffer.byteLength(line);

    if (bytesWritten + lineBytes > MAX_LOG_BYTES) {
      capped = true;
      const cappedLine =
        JSON.stringify({
          ts: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          scope: "logger",
          message: `verbose log reached ${MAX_LOG_BYTES} bytes and was capped`,
        }) + "\n";
      if (bytesWritten + Buffer.byteLength(cappedLine) <= MAX_LOG_BYTES) {
        (stream as WriteStream).write(cappedLine);
      }
      return;
    }

    bytesWritten += lineBytes;
    (stream as WriteStream).write(line);
  };

  const logger: VerboseStreamLogger = {
    enabled: true,
    filePath,
    write: writeLine,
    close: () => {
      if (closed) {
        return;
      }
      writeLine("logger", "stream verbose log closed");
      closed = true;
      stream.end();
    },
  };

  writeLine("logger", "stream verbose log started", {
    filePath,
    maxBytes: MAX_LOG_BYTES,
    maxFiles: MAX_LOG_FILES,
    context,
  });

  return logger;
};

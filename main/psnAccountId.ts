import { Buffer } from "node:buffer";

export const PSN_ACCOUNT_ID_INVALID_CODE = "PSN_ACCOUNT_ID_INVALID";
export const PSN_ACCOUNT_ID_INVALID_MESSAGE =
  "PSN account id format is invalid. Please sign in again, or enter a valid Base64 PSN account id.";

const PSN_ACCOUNT_ID_BYTES = 8;

export const createPsnAccountIdFormatError = () => {
  return Object.assign(new Error(PSN_ACCOUNT_ID_INVALID_MESSAGE), {
    code: PSN_ACCOUNT_ID_INVALID_CODE,
  });
};

export const isValidPsnAccountId = (value: unknown) => {
  const input = String(value || "").replace(/[ \r\n\t]/g, "");
  if (!input || input.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input)) {
    return false;
  }

  const paddingIndex = input.indexOf("=");
  if (paddingIndex >= 0 && !/^=+$/.test(input.slice(paddingIndex))) {
    return false;
  }

  try {
    return Buffer.from(input, "base64").length === PSN_ACCOUNT_ID_BYTES;
  } catch {
    return false;
  }
};

export const isPsnAccountIdFormatError = (error: unknown) => {
  const code = String((error as { code?: unknown })?.code || "").trim();
  const message =
    typeof error === "string"
      ? error
      : String((error as { message?: unknown })?.message || "");

  return (
    code === PSN_ACCOUNT_ID_INVALID_CODE ||
    /invalid base64 input/i.test(message) ||
    /psnAccountId must be 8 bytes/i.test(message) ||
    /PSN account id format is invalid/i.test(message)
  );
};

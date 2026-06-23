export const DUALSENSE_BT_AUDIO_REPORT_ID = 0x36;
export const OPUS_FRAME_BYTES = 200;
export const HAPTIC_FRAME_BYTES = 64;
export const REPORT_36_PAYLOAD_BYTES = 397;

let crcTable: number[] | null = null;

const getCrcTable = () => {
  if (crcTable) {
    return crcTable;
  }

  crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crcTable[n] = value >>> 0;
  }
  return crcTable;
};

const crc32 = (prefixBytes: number[], view: DataView) => {
  const table = getCrcTable();
  let crc = (-1 >>> 0) as number;

  for (const byte of prefixBytes) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }

  for (let i = 0; i < view.byteLength; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ view.getUint8(i)) & 0xff];
  }

  return (crc ^ -1) >>> 0;
};

const fillOutputReportChecksum = (reportId: number, reportData: Uint8Array) => {
  const crc = crc32(
    [0xa2, reportId],
    new DataView(reportData.buffer, reportData.byteOffset, reportData.byteLength - 4)
  );
  reportData[reportData.byteLength - 4] = crc & 0xff;
  reportData[reportData.byteLength - 3] = (crc >>> 8) & 0xff;
  reportData[reportData.byteLength - 2] = (crc >>> 16) & 0xff;
  reportData[reportData.byteLength - 1] = (crc >>> 24) & 0xff;
};

export const buildDualSenseBluetoothReport36 = (
  opusFrame: Uint8Array,
  hapticFrame: Uint8Array,
  seq: number,
  frameCounter: number
) => {
  const payload = new Uint8Array(REPORT_36_PAYLOAD_BYTES);
  payload[0] = (seq & 0x0f) << 4;

  payload[1] = 0x90;
  payload[2] = 0x3f;
  payload[3] = 0xa0;
  payload[4] = 0x00;
  payload[8] = 0x4b;
  payload[10] = 0x09;

  payload[66] = 0x91;
  payload[67] = 0x07;
  payload[68] = 0xfe;
  payload[69] = 0x40;
  payload[70] = 0x40;
  payload[71] = 0x40;
  payload[72] = 0x40;
  payload[73] = 0x40;
  payload[74] = frameCounter & 0xff;
  payload[75] = 0x93;
  payload[76] = 0xc8;
  payload.set(opusFrame.subarray(0, OPUS_FRAME_BYTES), 77);

  payload[277] = 0x92;
  payload[278] = HAPTIC_FRAME_BYTES;
  payload.set(hapticFrame.subarray(0, HAPTIC_FRAME_BYTES), 279);

  fillOutputReportChecksum(DUALSENSE_BT_AUDIO_REPORT_ID, payload);
  return payload;
};

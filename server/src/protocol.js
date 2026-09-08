'use strict';
// 火山引擎大模型流式语音识别（SAUC）二进制协议编解码
// 协议头 4 字节: [version<<4|headerSize, type<<4|flags, serialization<<4|compression, reserved]

const zlib = require('zlib');

const MsgType = {
  FULL_CLIENT_REQUEST: 0x1,
  AUDIO_ONLY_REQUEST: 0x2,
  FULL_SERVER_RESPONSE: 0x9,
  SERVER_ERROR: 0xf,
};

const Flags = {
  NONE: 0x0,
  POSITIVE_SEQUENCE: 0x1,
  NEGATIVE_SEQUENCE: 0x2, // 最后一包，sequence 为负值
};

function header(msgType, flags, serialization, compression) {
  const buf = Buffer.alloc(4);
  buf[0] = (0x1 << 4) | 0x1; // protocol v1, header size = 1 (单位4字节)
  buf[1] = (msgType << 4) | flags;
  buf[2] = (serialization << 4) | compression;
  buf[3] = 0;
  return buf;
}

// 首包：全量配置（JSON）
function encodeFullRequest(configJson) {
  const payload = Buffer.from(JSON.stringify(configJson), 'utf8');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  return Buffer.concat([header(MsgType.FULL_CLIENT_REQUEST, Flags.NONE, 0x1, 0x0), size, payload]);
}

// 音频包：gzip 压缩 PCM，带递增序号；最后一包序号取负
function encodeAudioFrame(pcmBuffer, sequence, isLast) {
  const payload = zlib.gzipSync(pcmBuffer);
  const flags = isLast ? Flags.NEGATIVE_SEQUENCE : Flags.POSITIVE_SEQUENCE;
  const seq = Buffer.alloc(4);
  seq.writeInt32BE(isLast ? -sequence : sequence);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  return Buffer.concat([
    header(MsgType.AUDIO_ONLY_REQUEST, flags, 0x0, 0x1),
    seq,
    size,
    payload,
  ]);
}

// 解析服务端消息，返回 { type, sequence?, errorCode?, json? }
function decodeServerMessage(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const headerSize = (buf[0] & 0x0f) * 4;
  const msgType = (buf[1] & 0xf0) >> 4;
  const flags = buf[1] & 0x0f;
  const compression = buf[2] & 0x0f;
  let offset = headerSize;

  let sequence = null;
  if (flags === Flags.POSITIVE_SEQUENCE || flags === Flags.NEGATIVE_SEQUENCE) {
    sequence = buf.readInt32BE(offset);
    offset += 4;
  }

  if (msgType === MsgType.SERVER_ERROR) {
    const errorCode = buf.readUInt32BE(offset);
    offset += 4;
    const size = buf.readUInt32BE(offset);
    offset += 4;
    const payload = buf.subarray(offset, offset + size);
    return { type: 'error', errorCode, message: payload.toString('utf8') };
  }

  if (msgType === MsgType.FULL_SERVER_RESPONSE) {
    const size = buf.readUInt32BE(offset);
    offset += 4;
    let payload = buf.subarray(offset, offset + size);
    if (compression === 0x1) payload = zlib.gunzipSync(payload);
    return { type: 'response', sequence, json: JSON.parse(payload.toString('utf8')) };
  }

  return { type: 'unknown', msgType };
}

module.exports = { encodeFullRequest, encodeAudioFrame, decodeServerMessage };

'use strict';
// 美团内部智能语音平台流式 ASR 会话（保底链路）
// 协议：每 ~200ms 音频一个 HTTP POST（数据报式），SessionID 串联，index 从 1 递增、负数结尾
// 响应按包返回：status 0无说话/1开始/2正在/3结束说话；text 为当前子句累计文本
// 不支持说话人分离（平台暂不支持），speaker 恒为 null

const crypto = require('crypto');
const { authHeaders } = require('./mtAuth');
const { translateZhToEn } = require('./mtTranslate');

const ASR_URL = process.env.MT_ASR_URL || 'https://speech.meituan.com/asr/v1/long_stream_recognize';
const ASR_URI = new URL(ASR_URL).pathname;
const PACKET_BYTES = 6400; // 200ms @16k/16bit/mono

function buildAsrParams(index) {
  const params = {
    audio_format: 'pcm',
    sample_rate: 16000,
    channel_num: 1,
    index,
    enable_vad: 1,
    enable_include_vad_result: 1,
    stream_type: 2, // 实时上屏 + 整句精修
    extend_params: JSON.stringify({ silence_duration: 800 }), // 气口判停 800ms
  };
  return Buffer.from(JSON.stringify(params), 'utf8').toString('base64');
}

class MtAsrSession {
  constructor(send) {
    this.send = send;
    this.sessionId = crypto.randomUUID();
    this.buffer = Buffer.alloc(0);
    this.index = 0;
    this.queue = Promise.resolve(); // 串行发送保证 index 有序
    this.finished = false;
    this.currentSub = null; // 当前子句 subSessionId
    this.utteranceSeq = 0;
    this.translated = new Set();
    // 内部 ASR 无说话人分离，speaker 恒 null（小程序显示无边条）
  }

  connect() {
    // 无长连接，直接就绪
    this.send({ type: 'session_started' });
  }

  pushAudio(pcmBuffer) {
    if (this.finished) return;
    this.buffer = Buffer.concat([this.buffer, pcmBuffer]);
    while (this.buffer.length >= PACKET_BYTES) {
      const packet = this.buffer.subarray(0, PACKET_BYTES);
      this.buffer = this.buffer.subarray(PACKET_BYTES);
      this.enqueue(packet, false);
    }
  }

  finishAudio() {
    if (this.finished) return;
    this.finished = true;
    // 剩余不足一包的补零凑整，负数 index 标识最后一包
    if (this.buffer.length > 0) {
      const last = Buffer.alloc(PACKET_BYTES);
      this.buffer.copy(last);
      this.buffer = Buffer.alloc(0);
      this.enqueue(last, true);
    } else {
      this.enqueue(Buffer.alloc(0), true);
    }
  }

  enqueue(packet, isLast) {
    const index = isLast ? -(this.index + 1) : ++this.index;
    this.queue = this.queue
      .then(() => this.postPacket(packet, index))
      .catch((e) => this.send({ type: 'error', message: `ASR 请求失败: ${e.message}` }));
  }

  async postPacket(packet, index) {
    const doPost = () =>
      fetch(ASR_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          SessionID: this.sessionId,
          'Asr-Params': buildAsrParams(index),
          ...this.cachedAuth,
        },
        body: packet,
      });

    if (!this.cachedAuth) {
      this.authMode = process.env.MT_AUTH_MODE || 'ba';
      this.cachedAuth = await authHeaders('POST', ASR_URI, this.authMode);
    }
    let res = await doPost();
    let text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    // BA 被拒（400102 TOKEN无效）时自动降级 Token 模式重试一次
    if (body.errcode === 400102 && this.authMode === 'ba') {
      this.authMode = 'token';
      this.cachedAuth = await authHeaders('POST', ASR_URI, 'token');
      res = await doPost();
      text = await res.text();
      body = JSON.parse(text);
    }
    if (body.errcode !== 0) {
      throw new Error(`errcode ${body.errcode}: ${body.errmsg}`);
    }
    this.handleResult(body.data, index < 0);
  }

  handleResult(data, isLastPacket) {
    if (!data) return;
    const subId = data.subSessionId || 'default';
    if (subId !== this.currentSub) {
      this.currentSub = subId;
      this.utteranceId = data.startTime ?? this.utteranceSeq++;
    }

    const text = (data.text || '').trim();
    if (!text) return;

    const isSentenceEnd = data.status === 3; // 结束说话 = 子句定稿
    this.send({
      type: 'interim',
      utterances: [
        { id: this.utteranceId, text, definite: isSentenceEnd, speaker: null },
      ],
    });

    if ((isSentenceEnd || isLastPacket) && !this.translated.has(this.utteranceId)) {
      this.translated.add(this.utteranceId);
      const id = this.utteranceId;
      translateZhToEn(text)
        .then((en) => this.send({ type: 'translation', id, zh: text, en, final: true }))
        .catch((e) =>
          this.send({ type: 'translation', id, zh: text, en: `[翻译失败] ${e.message}`, final: true })
        );
    }
  }

  closeUpstream() {
    this.finished = true;
  }
}

module.exports = { MtAsrSession };

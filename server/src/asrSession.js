'use strict';
// 单条小程序会话：管理一条到火山引擎的上行 WebSocket

const WebSocket = require('ws');
const crypto = require('crypto');
const { encodeFullRequest, encodeAudioFrame, decodeServerMessage } = require('./protocol');
const { translateZhToEn } = require('./translate');

const VOLC_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';

function buildConfig() {
  return {
    user: { uid: 'meeting-translator' },
    audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel',
      result_type: 'full',
      show_utterances: true,
      enable_itn: true,
      enable_punc: true,
      enable_speaker_info: true, // 说话人分离
      enable_nonstream: true, // 二遍识别：流式快上屏 + 定句精修
      end_window_size: 800, // 气口判停：静音 800ms 视为一句结束
    },
  };
}

class AsrSession {
  // send(obj) 回调：把消息推回小程序
  constructor(send) {
    this.send = send;
    this.sequence = 0;
    this.upstream = null;
    this.translated = new Set(); // 已翻译的定句 start_time
    this.pendingTranslations = 0;
  }

  connect() {
    this.upstream = new WebSocket(VOLC_URL, {
      headers: {
        'X-Api-App-Key': process.env.VOLC_APP_KEY,
        'X-Api-Access-Key': process.env.VOLC_ACCESS_KEY,
        'X-Api-Resource-Id': process.env.VOLC_RESOURCE_ID || 'volc.seedasr.sauc.duration',
        'X-Api-Connect-Id': crypto.randomUUID(),
      },
    });

    this.upstream.on('open', () => {
      this.upstream.send(encodeFullRequest(buildConfig()));
    });

    this.upstream.on('message', (data) => {
      let msg;
      try {
        msg = decodeServerMessage(data);
      } catch (e) {
        console.error('decode error', e);
        return;
      }
      if (msg.type === 'error') {
        this.send({ type: 'error', code: msg.errorCode, message: msg.message });
        this.closeUpstream();
        return;
      }
      if (msg.type !== 'response') return;
      this.handleResult(msg.json);
    });

    this.upstream.on('close', () => this.send({ type: 'asr_closed' }));
    this.upstream.on('error', (e) => this.send({ type: 'error', message: String(e.message || e) }));
  }

  handleResult(payload) {
    const result = payload.result;
    if (!result) return;
    const utterances = result.utterances || [];

    // 中间态（未落句）整段上屏
    this.send({
      type: 'interim',
      text: result.text || '',
      utterances: utterances.map((u) => ({
        id: u.start_time,
        text: u.text,
        definite: !!u.definite,
        speaker: u.speaker_id ?? u.speaker ?? u.speaker_info?.speaker_id ?? null,
      })),
    });

    // 定句触发翻译
    for (const u of utterances) {
      if (!u.definite || !u.text || this.translated.has(u.start_time)) continue;
      this.translated.add(u.start_time);
      this.pendingTranslations++;
      translateZhToEn(u.text)
        .then((en) =>
          this.send({ type: 'translation', id: u.start_time, zh: u.text, en })
        )
        .catch((e) =>
          this.send({ type: 'translation', id: u.start_time, zh: u.text, en: `[翻译失败] ${e.message}` })
        )
        .finally(() => this.pendingTranslations--);
    }
  }

  pushAudio(pcmBuffer) {
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) return;
    this.sequence++;
    this.upstream.send(encodeAudioFrame(pcmBuffer, this.sequence, false));
  }

  finishAudio() {
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) return;
    this.upstream.send(encodeAudioFrame(Buffer.alloc(0), this.sequence, true));
  }

  closeUpstream() {
    if (this.upstream && this.upstream.readyState === WebSocket.OPEN) this.upstream.close();
    this.upstream = null;
  }
}

module.exports = { AsrSession };

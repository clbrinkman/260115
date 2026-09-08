'use strict';
// 豆包同传 AST v2 会话：一条流完成 识别+翻译+说话人切换检测+分句
// 协议：TranslateRequest/TranslateResponse protobuf 二进制帧直连 WebSocket
// proto 定义见 server/protos/（来自火山引擎官方 client demo）

const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');
const protobuf = require('protobufjs');
const { summarizeMeeting } = require('./summarize');

const AST_URL = 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate';
const RESOURCE_ID = 'volc.service_type.10053';

const PROTOS_DIR = path.join(__dirname, '../protos');
const root = new protobuf.Root();
root.resolvePath = (origin, target) => path.join(PROTOS_DIR, target);
protobuf.loadSync('products/understanding/ast/ast_service.proto', root);
const TranslateRequest = root.lookupType('data.speech.ast.TranslateRequest');
const TranslateResponse = root.lookupType('data.speech.ast.TranslateResponse');
const EventType = root.lookupEnum('data.speech.event.Type').values;

// 暂停保活：超过该间隔没发音频就补 80ms 静音帧，防止上游因空闲断流
const SILENCE_FRAME = Buffer.alloc(2560);
const KEEPALIVE_AFTER_MS = 10000;
const KEEPALIVE_INTERVAL_MS = 3000;

function buildAuthHeaders() {
  // 新版控制台只需 X-Api-Key；旧版用 App Key + Access Key
  if (process.env.VOLC_API_KEY) {
    return {
      'X-Api-Key': process.env.VOLC_API_KEY,
      'X-Api-Resource-Id': RESOURCE_ID,
    };
  }
  return {
    'X-Api-App-Key': process.env.VOLC_APP_KEY,
    'X-Api-Access-Key': process.env.VOLC_ACCESS_KEY,
    'X-Api-Resource-Id': RESOURCE_ID,
  };
}

class AstSession {
  constructor(send) {
    this.send = send;
    this.sessionId = crypto.randomUUID();
    this.connectionId = crypto.randomUUID();
    this.sequence = 0;
    this.upstream = null;
    this.speakerIndex = 0; // spk_chg 信号累加成说话人编号
    this.currentUtteranceId = 0;
    this.lastSourceId = null;
    this.zhAcc = '';
    this.enAcc = '';
    this.zhByUtterance = new Map(); // start_time -> 原文定句
    this.lastAudioAt = 0;
    this.keepalive = null;
    this.transcript = []; // 定句累积：{speaker, text}，供会议纪要
  }

  meta() {
    return {
      Endpoint: RESOURCE_ID,
      AppKey: process.env.VOLC_APP_KEY || undefined,
      ResourceID: RESOURCE_ID,
      ConnectionID: this.connectionId,
      SessionID: this.sessionId,
      Sequence: this.sequence++,
    };
  }

  sendRequest(payload) {
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) return;
    this.upstream.send(Buffer.from(TranslateRequest.encode(payload).finish()));
  }

  connect() {
    this.upstream = new WebSocket(AST_URL, { headers: buildAuthHeaders() });

    this.upstream.on('open', () => {
      this.sendRequest({
        requestMeta: this.meta(),
        event: EventType.StartSession,
        user: { uid: 'meeting-translator', platform: 'miniprogram' },
        sourceAudio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
        request: {
          mode: 's2t',
          sourceLanguage: process.env.SOURCE_LANG || 'zh',
          targetLanguage: process.env.TARGET_LANG || 'en',
        },
      });
      this.keepalive = setInterval(() => {
        if (this.lastAudioAt && Date.now() - this.lastAudioAt > KEEPALIVE_AFTER_MS) {
          this.sendRequest({
            requestMeta: this.meta(),
            event: EventType.TaskRequest,
            sourceAudio: { binaryData: SILENCE_FRAME },
          });
        }
      }, KEEPALIVE_INTERVAL_MS);
    });

    this.upstream.on('message', (data) => {
      let res;
      try {
        res = TranslateResponse.decode(Buffer.from(data));
      } catch (e) {
        console.error('protobuf decode error', e);
        return;
      }
      this.handleEvent(res);
    });

    this.upstream.on('close', () => {
      clearInterval(this.keepalive);
      this.send({ type: 'asr_closed' });
    });
    this.upstream.on('error', (e) =>
      this.send({ type: 'error', message: String(e.message || e) })
    );
  }

  handleEvent(res) {
    const ev = res.event;
    if (ev === EventType.SessionStarted) {
      this.send({ type: 'session_started' });
      return;
    }
    if (ev === EventType.SessionFailed) {
      this.send({
        type: 'error',
        code: res.responseMeta?.StatusCode,
        message: res.responseMeta?.Message || '会话失败',
      });
      return;
    }
    if (ev === EventType.SessionFinished) {
      this.send({ type: 'asr_closed' });
      return;
    }

    if (ev === EventType.SourceSubtitleStart) {
      if (res.spkChg) this.speakerIndex++;
      this.currentUtteranceId = res.startTime;
      this.zhAcc = ''; // 651 的 text 是增量，服务端累加成累计文本再下发
      return;
    }
    if (ev === EventType.SourceSubtitleResponse) {
      this.zhAcc += res.text || '';
      this.send({
        type: 'interim',
        utterances: [
          {
            id: this.currentUtteranceId,
            text: this.zhAcc,
            definite: false,
            speaker: this.speakerIndex,
          },
        ],
      });
      return;
    }
    if (ev === EventType.SourceSubtitleEnd) {
      const id = res.startTime ?? this.currentUtteranceId;
      this.lastSourceId = id;
      this.zhByUtterance.set(id, res.text || this.zhAcc);
      const finalText = res.text || this.zhAcc;
      if (finalText) this.transcript.push({ speaker: this.speakerIndex, text: finalText });
      this.send({
        type: 'interim',
        utterances: [
          { id, text: finalText, definite: true, speaker: this.speakerIndex },
        ],
      });
      return;
    }
    if (ev === EventType.TranslationSubtitleStart) {
      this.enAcc = '';
      return;
    }
    if (
      ev === EventType.TranslationSubtitleResponse ||
      ev === EventType.TranslationSubtitleEnd
    ) {
      const isFinal = ev === EventType.TranslationSubtitleEnd;
      // 译文事件挂到最近一句原文的 id 上，保证小程序端能配对
      const id = this.lastSourceId ?? this.currentUtteranceId;
      const en = isFinal ? res.text || this.enAcc : (this.enAcc += res.text || '');
      this.send({
        type: 'translation',
        id,
        zh: this.zhByUtterance.get(id) || '',
        en,
        final: isFinal,
      });
      return;
    }
    // UsageResponse(154)/AudioMuted(250) 等忽略
  }

  summarize() {
    this.send({ type: 'summary_loading' });
    summarizeMeeting(this.transcript)
      .then((text) => this.send({ type: 'summary', text }))
      .catch((e) => this.send({ type: 'summary', text: '', error: e.message }));
  }

  pushAudio(pcmBuffer) {
    this.lastAudioAt = Date.now();
    this.sendRequest({
      requestMeta: this.meta(),
      event: EventType.TaskRequest,
      sourceAudio: { binaryData: pcmBuffer },
    });
  }

  finishAudio() {
    this.sendRequest({ requestMeta: this.meta(), event: EventType.FinishSession });
  }

  closeUpstream() {
    clearInterval(this.keepalive);
    if (this.upstream && this.upstream.readyState === WebSocket.OPEN) this.upstream.close();
    this.upstream = null;
  }
}

module.exports = { AstSession };

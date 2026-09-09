const { SERVER_URL, TOKEN } = require('../../utils/config');

// R ColorBrewer Set3 12 色，见 index.wxss .c0~.c11
const SPEAKER_CLASSES = Array.from({ length: 12 }, (_, i) => `c${i}`);

Page({
  data: {
    theme: 'dark',
    recording: false, // 正在采集
    paused: false, // 暂停中（会话保留，可继续）
    connecting: false,
    items: [],
    interim: null,
    scrollInto: '',
    seq: 0,
    statusText: '点击开始',
    summaryVisible: false,
    summaryLoading: false,
    summaryText: '',
    audioMode: 'speaker', // speaker: 外放半双工防回声；headphones: 耳机全双工
  },

  onLoad() {
    this.recorder = wx.getRecorderManager();
    this.socketOpen = false;
    this.audioFrameCount = 0;
    this.audioFrameTimer = null;
    this.speakerMap = new Map();
    this.transcript = []; // {speaker, text} 定句累积，会后纪要兜底用
    this.ttsQueue = [];
    this.ttsPlaying = false;
    this.ttsSerial = 0;
    this.suppressMicUpload = false;

    this.recorder.onFrameRecorded((res) => {
      this.audioFrameCount += 1;
      if (this.socketOpen && this.data.recording && !this.suppressMicUpload) {
        wx.sendSocketMessage({ data: res.frameBuffer });
      }
    });
    this.recorder.onStart(() => {
      this.audioFrameCount = 0;
      clearTimeout(this.audioFrameTimer);
      this.setData({ recording: true, paused: false, statusText: '转写中…' });
      this.audioFrameTimer = setTimeout(() => {
        if (this.data.recording && this.audioFrameCount === 0) {
          this.setData({ statusText: '未收到声音，请检查麦克风权限' });
        }
      }, 3000);
    });
    this.recorder.onStop(() => clearTimeout(this.audioFrameTimer));
    this.recorder.onError((err) => {
      this.setData({ statusText: `录音错误: ${err.errMsg}`, recording: false, paused: false });
    });
    this.recorder.onInterruptionBegin(() => this.pause());

    // onSocket* 是全局监听，只注册一次；重复注册会叠加回调
    wx.onSocketOpen(() => {
      this.socketOpen = true;
      wx.sendSocketMessage({ data: JSON.stringify({ type: 'start' }) });
    });
    wx.onSocketMessage((res) => this.onServerMessage(JSON.parse(res.data)));
    wx.onSocketError(() => {
      this.socketOpen = false;
      this.setData({ statusText: '连接失败，检查服务器地址', connecting: false });
    });
    wx.onSocketClose(() => {
      this.socketOpen = false;
      this.setData({ recording: false, paused: false, statusText: '连接已断开' });
    });
  },

  toggleTheme() {
    this.setData({ theme: this.data.theme === 'dark' ? 'light' : 'dark' });
  },

  toggleAudioMode() {
    const audioMode = this.data.audioMode === 'speaker' ? 'headphones' : 'speaker';
    this.suppressMicUpload = audioMode === 'speaker' && this.ttsPlaying;
    this.setData({ audioMode });
    wx.showToast({
      title: audioMode === 'speaker' ? '外放防回声' : '耳机全双工',
      icon: 'none',
    });
  },

  onSummary() {
    this.setData({ summaryVisible: true, summaryLoading: true, summaryText: '' });
    if (this.socketOpen) {
      wx.sendSocketMessage({ data: JSON.stringify({ type: 'summarize' }) });
      return;
    }
    // 会话已结束：用本地累积的转写走 HTTP 接口换纪要
    if (!this.transcript.length) {
      this.setData({ summaryLoading: false, summaryText: '还没有转写内容。' });
      return;
    }
    const base = SERVER_URL.replace(/^ws/, 'http');
    wx.request({
      url: TOKEN ? `${base}/summarize?token=${TOKEN}` : `${base}/summarize`,
      method: 'POST',
      data: { transcript: this.transcript },
      success: (res) => {
        const text = res.data && res.data.error
          ? `生成失败：${res.data.error}`
          : (res.data && res.data.text) || '生成失败';
        this.setData({ summaryLoading: false, summaryText: text });
      },
      fail: () => this.setData({ summaryLoading: false, summaryText: '生成失败：网络错误' }),
    });
  },

  closeSummary() {
    this.setData({ summaryVisible: false });
  },

  onMainButton() {
    if (this.data.recording) this.pause();
    else if (this.data.paused) this.resume();
    else this.start();
  },

  speakerStyle(speakerId) {
    if (speakerId == null) return { speakerLabel: '', colorClass: 'c8' };
    if (!this.speakerMap.has(speakerId)) {
      this.speakerMap.set(speakerId, this.speakerMap.size);
    }
    const idx = this.speakerMap.get(speakerId);
    return {
      speakerLabel: `说话人 ${idx + 1}`,
      colorClass: SPEAKER_CLASSES[idx % SPEAKER_CLASSES.length],
    };
  },

  startRecorder() {
    this.recorder.start({
      duration: 600000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 96000,
      format: 'PCM',
      frameSize: 1,
    });
  },

  start() {
    wx.authorize({
      scope: 'scope.record',
      success: () => {
        this.setData({ connecting: true, statusText: '连接中…', items: [], interim: null });
        this.speakerMap.clear();
        this.transcript = [];
        this.connect();
      },
      fail: () => {
        this.setData({ connecting: false, recording: false, statusText: '需要麦克风权限' });
        wx.showModal({
          title: '需要麦克风权限',
          content: '请在设置中允许录音，否则无法转写。',
          confirmText: '去设置',
          success: (res) => {
            if (res.confirm) wx.openSetting();
          },
        });
      },
    });
  },

  connect() {
    wx.connectSocket({
      url: TOKEN ? `${SERVER_URL}?token=${TOKEN}` : SERVER_URL,
    });
  },

  pause() {
    this.recorder.stop();
    this.setData({
      recording: false,
      paused: true,
      interim: null,
      statusText: '已暂停 · 点击继续',
    });
  },

  resume() {
    if (!this.socketOpen) {
      // 暂停太久上游可能已断开，重新开一条会话（保留字幕不清屏）
      this.setData({ connecting: true, statusText: '重新连接…' });
      this.connect();
      return;
    }
    this.startRecorder();
    this.setData({ statusText: '正在启动麦克风…' });
  },

  onServerMessage(msg) {
    if (msg.type === 'session_started') {
      this.startRecorder();
      this.setData({ connecting: false, statusText: '正在启动麦克风…' });
      return;
    }

    if (msg.type === 'interim') {
      const items = this.data.items.slice();
      const definiteSet = new Set(items.map((i) => i.id));
      let interimText = '';
      let interimSpeaker = null;
      for (const u of msg.utterances) {
        if (u.definite) {
          if (!definiteSet.has(u.id)) {
            items.push({ id: u.id, zh: u.text, en: '', ...this.speakerStyle(u.speaker) });
            definiteSet.add(u.id);
            this.transcript.push({ speaker: u.speaker, text: u.text });
          }
        } else {
          interimText += u.text;
          interimSpeaker = u.speaker;
        }
      }
      const seq = this.data.seq + 1;
      this.setData({
        items,
        interim: interimText
          ? { text: interimText, ...this.speakerStyle(interimSpeaker) }
          : null,
        seq,
        scrollInto: `tail-${seq}`,
      });
      return;
    }

    if (msg.type === 'translation') {
      const found = this.data.items.some((i) => i.id === msg.id);
      const items = found
        ? this.data.items.map((i) => (i.id === msg.id ? { ...i, en: msg.en } : i))
        : // 译文先于原文到达的兜底：直接补一条
          [...this.data.items, { id: msg.id, zh: msg.zh, en: msg.en, ...this.speakerStyle(null) }];
      const seq = this.data.seq + 1;
      this.setData({ items, seq, scrollInto: `tail-${seq}` });
      return;
    }

    if (msg.type === 'tts_audio' && msg.audio) {
      this.ttsQueue.push({ audio: msg.audio, format: msg.format || 'ogg' });
      this.playNextTts();
      return;
    }

    if (msg.type === 'summary_loading') {
      this.setData({ summaryLoading: true });
      return;
    }

    if (msg.type === 'summary') {
      this.setData({
        summaryLoading: false,
        summaryText: msg.error ? `生成失败：${msg.error}` : msg.text,
      });
      return;
    }

    if (msg.type === 'error') {
      this.setData({ statusText: `识别出错: ${msg.message || msg.code}` });
      this.pause();
      return;
    }

    if (msg.type === 'asr_closed' && this.data.recording) {
      this.setData({ recording: false, paused: true, statusText: '上游已断开 · 点击重连' });
    }
  },

  playNextTts() {
    if (this.ttsPlaying || !this.ttsQueue.length) return;
    this.ttsPlaying = true;
    if (this.data.audioMode === 'speaker') {
      this.suppressMicUpload = true;
      this.setData({ statusText: '播放译音 · 防回声中' });
    }
    const item = this.ttsQueue.shift();
    const filePath = `${wx.env.USER_DATA_PATH}/translation-${Date.now()}-${this.ttsSerial++}.${item.format}`;
    const fs = wx.getFileSystemManager();
    fs.writeFile({
      filePath,
      data: item.audio,
      encoding: 'base64',
      success: () => {
        const player = wx.createInnerAudioContext();
        this.ttsPlayer = player;
        player.src = filePath;
        const done = () => {
          player.destroy();
          fs.unlink({ filePath, fail: () => {} });
          this.ttsPlaying = false;
          if (this.ttsQueue.length) {
            this.playNextTts();
          } else {
            // 扬声器和麦克风之间存在声学尾音，稍等再恢复上传。
            setTimeout(() => {
              this.suppressMicUpload = false;
              if (this.data.recording) this.setData({ statusText: '转写中…' });
            }, this.data.audioMode === 'speaker' ? 350 : 0);
          }
        };
        player.onEnded(done);
        player.onError((err) => {
          console.error('译音播放失败', err);
          done();
        });
        player.play();
      },
      fail: (err) => {
        console.error('译音文件写入失败', err);
        this.ttsPlaying = false;
        this.suppressMicUpload = false;
        this.playNextTts();
      },
    });
  },

  endSession() {
    if (this.data.recording) this.recorder.stop();
    if (this.socketOpen) {
      wx.sendSocketMessage({
        data: JSON.stringify({ type: 'stop' }),
        complete: () => setTimeout(() => wx.closeSocket(), 3000),
      });
    }
  },

  onUnload() {
    this.endSession();
    if (this.ttsPlayer) this.ttsPlayer.destroy();
  },
});

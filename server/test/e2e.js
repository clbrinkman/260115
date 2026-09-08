'use strict';
// 端到端测试：把 speech.wav 的 PCM 按 80ms 实时节奏推给 AST，打印原文/译文事件
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { AstSession } = require('../src/astSession');

// 解析 wav：跳过 RIFF 头找 data chunk（兼容非 44 字节头）
function readPcm(wavPath) {
  const buf = fs.readFileSync(wavPath);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const pcm = readPcm(path.join(__dirname, 'speech.wav'));
console.log(`[test] pcm ${pcm.length} bytes = ${(pcm.length / 32 / 1000).toFixed(1)}s`);

const CHUNK = 2560; // 80ms @16k/16bit/mono
const session = new AstSession((msg) => {
  if (msg.type === 'interim') {
    for (const u of msg.utterances) {
      console.log(`[原文${u.definite ? '·定' : '·中'}][spk${u.speaker}] ${u.text}`);
    }
  } else if (msg.type === 'translation') {
    console.log(`[译文${msg.final ? '·定' : '·中'}] ${msg.en}`);
  } else {
    console.log('[event]', JSON.stringify(msg));
  }
});

session.connect();

let off = 0;
const started = Date.now();
const timer = setInterval(() => {
  if (off >= pcm.length) {
    clearInterval(timer);
    session.finishAudio();
    console.log('[test] all audio sent, waiting for final events...');
    setTimeout(() => {
      session.closeUpstream();
      process.exit(0);
    }, 8000);
    return;
  }
  session.pushAudio(pcm.subarray(off, off + CHUNK));
  off += CHUNK;
}, 80);

setTimeout(() => {
  console.error('[test] timeout');
  process.exit(1);
}, pcm.length / 32 + 20000);

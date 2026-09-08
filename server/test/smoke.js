'use strict';
// AST 链路冒烟测试：连真服务，发静音帧，验证鉴权+协议（不产生识别内容属正常）
require('dotenv').config();
const { AstSession } = require('../src/astSession');

const session = new AstSession((msg) => console.log('[event]', JSON.stringify(msg)));
session.connect();

// SessionStarted 后连续发 2 秒静音帧（80ms/包），再 FinishSession
let packets = 0;
const timer = setInterval(() => {
  packets++;
  session.pushAudio(Buffer.alloc(2560));
  if (packets >= 25) {
    clearInterval(timer);
    session.finishAudio();
    console.log('[test] sent 2s silence + FinishSession, waiting for events...');
    setTimeout(() => {
      session.closeUpstream();
      process.exit(0);
    }, 5000);
  }
}, 80);

setTimeout(() => {
  console.error('[test] 15s timeout, no SessionFinished — check output above');
  process.exit(1);
}, 15000);

'use strict';
require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const { AstSession } = require('./astSession');

const PORT = Number(process.env.PORT || 8080);
const AUTH_TOKEN = process.env.AUTH_TOKEN; // 小程序连接时 ?token=xxx 简单鉴权

// HTTP 层仅用于健康检查/唤醒（Render 免费档休眠后浏览器访问一次即可唤醒）
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'meeting-translator-relay' }));
});

const wss = new WebSocketServer({ server });

server.listen(PORT, () => {
  console.log(`relay server listening on :${PORT}`);
});

wss.on('connection', (ws, req) => {
  if (AUTH_TOKEN) {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (token !== AUTH_TOKEN) {
      ws.close(4001, 'unauthorized');
      return;
    }
  }

  let session = null;
  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      session?.pushAudio(data); // PCM 音频帧直接转发
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'start') {
      session = new AstSession(send);
      session.connect();
    } else if (msg.type === 'stop') {
      session?.finishAudio(); // 发最后一包，等定句结果回来
    } else if (msg.type === 'summarize') {
      session?.summarize();
    }
  });

  ws.on('close', () => session?.closeUpstream());
  ws.on('error', () => session?.closeUpstream());
});

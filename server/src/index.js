'use strict';
require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const { AstSession } = require('./astSession');
const { summarizeMeeting } = require('./summarize');

const PORT = Number(process.env.PORT || 8080);
const AUTH_TOKEN = process.env.AUTH_TOKEN; // 小程序连接时 ?token=xxx 简单鉴权

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// HTTP 层：健康检查/唤醒（Render 免费档休眠后浏览器访问一次即可唤醒）+ 会后纪要
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // 会后纪要：WS 已断开也能用本地转写换纪要
  if (req.method === 'POST' && url.pathname === '/summarize') {
    if (AUTH_TOKEN && url.searchParams.get('token') !== AUTH_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    readBody(req)
      .then((body) => {
        const { transcript } = JSON.parse(body || '{}');
        if (!Array.isArray(transcript)) throw new Error('缺少 transcript');
        return summarizeMeeting(transcript);
      })
      .then((text) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
      })
      .catch((e) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    service: 'meeting-translator-relay',
    env: {
      AUTH_TOKEN: Boolean(process.env.AUTH_TOKEN),
      VOLC_API_KEY: Boolean(process.env.VOLC_API_KEY),
      LLM_API_KEY: Boolean(process.env.LLM_API_KEY),
    },
  }));
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
      session?.closeUpstream(); // 二次 start 先释放旧会话（keepalive/上游连接）
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

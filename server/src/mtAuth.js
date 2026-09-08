'use strict';
// 美团内部智能语音平台 - AIAUTH 鉴权
// BA：Authorization = "AIAUTH-V1 " + appKey + ":" + base64(HMAC-SHA1(verb + " " + uri + "\n" + date, secretKey))
// Token：client_credentials 换 access_token（约2h），请求头带 Token

const crypto = require('crypto');

const TOKEN_URL = process.env.MT_TOKEN_URL || 'https://auth-ai.vip.sankuai.com/oauth/v2/token';

// Date 格式 "EEE, d MMM yyyy HH:mm:00 'GMT'"，注意秒必须置 0
function gmtDate() {
  return new Date().toUTCString().replace(/:\d{2} GMT$/, ':00 GMT');
}

function baHeaders(verb, uri) {
  const date = gmtDate();
  const stringToSign = `${verb} ${uri}\n${date}`;
  const signature = crypto
    .createHmac('sha1', process.env.MT_SECRET_KEY || '')
    .update(stringToSign, 'utf8')
    .digest('base64');
  return {
    Date: date,
    Authorization: `AIAUTH-V1 ${process.env.MT_APP_KEY}:${signature}`,
  };
}

let cachedToken = null;
let tokenExpireAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpireAt - 60000) return cachedToken;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.MT_APP_KEY,
      client_secret: process.env.MT_SECRET_KEY || '',
    }),
  });
  const body = await res.json();
  if (body.errcode !== 0) throw new Error(`取 Token 失败 ${body.errcode}: ${body.errmsg}`);
  cachedToken = body.data.access_token;
  tokenExpireAt = Date.now() + Number(body.data.expires_in || 7200000);
  return cachedToken;
}

// 默认 BA；显式传 mode='token' 走 Token（BA 被服务端拒绝时调用方降级）
async function authHeaders(verb, uri, mode = process.env.MT_AUTH_MODE || 'ba') {
  if (mode === 'token') {
    return { Token: await getToken() };
  }
  return baHeaders(verb, uri);
}

module.exports = { authHeaders, baHeaders, getToken };

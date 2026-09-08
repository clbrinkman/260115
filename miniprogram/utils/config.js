// 联调时改这里。开发者工具勾选「不校验合法域名」可直接用 ws://；
// 真机/上线必须 wss:// + ICP 备案域名，并配置进小程序后台 socket 合法域名
module.exports = {
  SERVER_URL: 'ws://192.168.1.100:8080',
  TOKEN: '', // 与 server .env 的 AUTH_TOKEN 一致
};

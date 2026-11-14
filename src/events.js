// 实时刷新（SSE）：同步进了新东西、媒体文件落了盘，开着的页面自己刷新。单用户、服务端权威数据，用浏览器原生 EventSource 就够。
const clients = new Set();

export function addClient(res) {
  const c = { res, id: Math.random().toString(36).slice(2) };
  clients.add(c);
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, clients: clients.size })}\n\n`);
  return () => clients.delete(c);
}
export function broadcast(type, payload = {}) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) { try { c.res.write(msg); } catch { clients.delete(c); } }
}
export const clientCount = () => clients.size;

// 心跳：防止代理/手机休眠时连接被静默掐断
setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch { clients.delete(c); } } }, 15000).unref?.();

// SSRF 防护：任何"服务端替用户去抓一个 URL"的地方（下封面、下图、下视频）都先过这一关——
// 否则拿到 token 的人能让服务器去探内网。
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function isPrivateIp(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    return s === '::1' || s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.') || s.startsWith('::ffff:192.168.');
  }
  return true;   // 解析不出来就当作不安全
}

// 抛错则拒绝抓取；不抛就是安全的，调用方可以继续 fetch。
export async function assertSafeUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('URL 格式不对'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('只支持 http/https 链接');
  if (u.hostname === 'localhost') throw new Error('不能抓取本机地址');
  let addr;
  try { addr = await lookup(u.hostname); } catch { throw new Error('域名解析失败'); }
  if (isPrivateIp(addr.address)) throw new Error('不能抓取内网/本机地址');
}

#!/bin/bash
# 把抖音收藏里还没下的媒体一批一批补完（在跑着 FavSync 的服务器本机上执行）。
#   每批 60 条，批间歇 2–4 分钟；碰到限流（403/验证码）歇 15 分钟；上一轮同步还在跑（409）就等。
#   直链过期（抖音视频地址只活十几个小时）：服务端会把过期的跳过并报 stale；这里一看"没新鲜的可下、只剩过期的"
#   就去把收藏夹和收藏列表重新翻一遍（地址跟着刷新），然后接着下。全部账号一起（account=all）。
# 用法：nohup scripts/douyin-media-loop.sh > douyin-media-loop.log 2>&1 &
API=localhost:${PORT:-3460}
post() { curl -s --max-time "${2:-2400}" -X POST -H "Content-Type: application/json" -d "$1" "$API/api/douyin/sync"; }
num() { echo "$1" | sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p" | head -1; }
refreshes=0
for i in $(seq 1 400); do
  st=$(curl -s "$API/api/douyin/status")
  pending=$(num "$st" media_pending)
  echo "$(date +%H:%M:%S) 第 $i 批，待下 ${pending:-?}"
  [ "${pending:-0}" -eq 0 ] && { echo "全部下完"; break; }
  out=$(post '{"skip_list":true,"media_limit":60,"video":true,"account":"all"}')
  echo "$out" | head -c 300; echo
  if echo "$out" | grep -q "上一轮还在跑"; then echo "在等上一轮，歇 10 分钟"; sleep 600; continue; fi
  if echo "$out" | grep -q "停下"; then echo "被限流，歇 15 分钟"; sleep 900; fi
  tried=$(num "$out" tried); stale=$(num "$out" stale)
  if [ "${tried:-0}" -eq 0 ] && [ "${stale:-0}" -gt 0 ]; then
    refreshes=$((refreshes + 1))
    if [ "$refreshes" -gt 6 ]; then echo "刷新了 6 次还是全过期，停下让人看看"; break; fi
    echo "$(date +%H:%M:%S) 待下的直链都过期了（$stale 条），去重翻收藏夹 + 收藏列表刷新地址…"
    r=$(post '{"mode":"folders","media_limit":0,"max_ms":1500000,"account":"all"}' 1800); echo "$r" | head -c 300; echo
    sleep $((60 + RANDOM % 60))
    r=$(post '{"full":true,"max_items":600,"max_ms":600000,"media_limit":0,"account":"all"}' 900); echo "$r" | head -c 300; echo
    sleep $((120 + RANDOM % 120))
    continue
  fi
  sleep $((120 + RANDOM % 120))
done

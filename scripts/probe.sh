#!/usr/bin/env bash
# One-off discovery: save flood.larry-cctv.com's page, its scripts, and any JSON endpoints they
# reference into probe/ so the data format can be inspected. Nothing fetched here is executed.
set -u
BASE="https://flood.larry-cctv.com"
UA="Mozilla/5.0 (flood-map probe; +https://github.com/LupangSyS/Flood)"
OUT=probe; rm -rf "$OUT"; mkdir -p "$OUT/files"
log() { echo "$*" | tee -a "$OUT/log.txt"; }
get() { # url -> file; records status, type and size
  local url="$1" f="$2"
  local meta; meta=$(curl -sS -L -m 30 -A "$UA" --max-filesize 3000000 -o "$f" -w '%{http_code} %{content_type} %{size_download}' "$url" 2>&1)
  log "$meta  $url -> $f"
}
get "$BASE/" "$OUT/files/index.html"
# scripts and stylesheets referenced by the page
grep -oiE '(src|href)="[^"]+\.(js|json)[^"]*"' "$OUT/files/index.html" 2>/dev/null | sed -E 's/^[^"]*"//; s/"$//' | sort -u | head -40 > "$OUT/assets.txt"
n=0; while read -r a; do n=$((n+1)); case "$a" in http*) u="$a";; /*) u="$BASE$a";; *) u="$BASE/$a";; esac
  get "$u" "$OUT/files/asset$n.$(echo "$a" | grep -oE '\.(js|json)' | head -1 | tr -d .)"; done < "$OUT/assets.txt"
# endpoint-looking strings in everything fetched
cat "$OUT"/files/* 2>/dev/null | grep -oE '["'"'"'`](https?://[^"'"'"'` ]+|/[A-Za-z0-9_./-]*(api|json|data|sensor|flood|station|level)[A-Za-z0-9_./?=&-]*)["'"'"'`]' \
  | tr -d '"'"'"'`' | sort -u | head -80 > "$OUT/endpoints.txt"
m=0; while read -r e; do m=$((m+1)); case "$e" in http*) case "$e" in *larry-cctv*) u="$e";; *) continue;; esac;; *) u="$BASE$e";; esac
  get "$u" "$OUT/files/ep$m.out"; done < "$OUT/endpoints.txt"
# common guesses
for p in /api /api/sensors /api/stations /api/data /data.json /sensors.json /api/flood /api/v1/sensors; do
  get "$BASE$p" "$OUT/files/guess$(echo "$p" | tr '/.' '__').out"; done
# drop empty/huge files so the commit stays small
find "$OUT/files" -type f \( -size 0 -o -size +2M \) -delete
exit 0

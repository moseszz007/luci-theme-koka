#!/bin/sh
# Remove the Koka Modern skin and return to the stock footstrap look.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
CSS=/www/luci-static/footstrap/cascade.css
HEAD=/usr/share/ucode/luci/template/themes/footstrap/partials/head.ut
IFACE_JS=/www/luci-static/resources/view/network/interfaces.js

[ -f "$CSS.bak-koka" ] && cp "$CSS.bak-koka" "$CSS"
[ -f "$HEAD.bak-koka" ] && cp "$HEAD.bak-koka" "$HEAD"
[ -f "$IFACE_JS.bak-koka" ] && cp "$IFACE_JS.bak-koka" "$IFACE_JS"

# Restore the stock interface icons.
for icon in /www/luci-static/resources/icons/*.bak-koka; do
	[ -e "$icon" ] || continue
	cp "$icon" "${icon%.bak-koka}"
done
# Remove icons the skin added that LuCI did not ship.
[ -f /www/luci-static/resources/icons/amneziawg_disabled.svg.bak-koka ] || \
	rm -f /www/luci-static/resources/icons/amneziawg_disabled.svg

uci set footstrap.settings.wallpaper='file'
uci set footstrap.settings.rounding='12'
uci set footstrap.settings.content_width='1280'
uci set footstrap.settings.density='normal'
uci commit footstrap

# Put the original design label back.
uci set luci.themes.Footstrap='/luci-static/footstrap'
uci -q delete luci.themes.Koka 2>/dev/null || true
uci commit luci

rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache

echo 'Koka skin removed. Hard-refresh the browser (Ctrl+F5).'

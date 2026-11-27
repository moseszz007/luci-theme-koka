#!/bin/sh
# Install the Koka Modern CSS-only skin on top of luci-theme-footstrap.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
CSS=/www/luci-static/footstrap/cascade.css
HEAD=/usr/share/ucode/luci/template/themes/footstrap/partials/head.ut

# If the file is already skinned, rebuild it from the stock backup. Otherwise
# this is a fresh (or freshly upgraded) stock file: back it up first.
if grep -q 'KOKA-SKIN-START' "$CSS"; then
	[ -f "$CSS.bak-koka" ] || { echo "missing $CSS.bak-koka" >&2; exit 1; }
	cp "$CSS.bak-koka" "$CSS"
else
	cp "$CSS" "$CSS.bak-koka"
fi

if grep -q 'cascade.css?v=koka-' "$HEAD"; then
	[ -f "$HEAD.bak-koka" ] || { echo "missing $HEAD.bak-koka" >&2; exit 1; }
	cp "$HEAD.bak-koka" "$HEAD"
else
	cp "$HEAD" "$HEAD.bak-koka"
fi

printf '\n\n/* KOKA-SKIN-START */\n' >> "$CSS"
cat "$DIR/koka-skin.css" >> "$CSS"

# Replace the Tango-era interface icons with the Koka line set. Keep a stock
# backup next to each file; on reinstall the backup is left untouched.
ICONS=/www/luci-static/resources/icons
for icon in "$DIR"/icons/*.svg; do
	[ -e "$icon" ] || continue
	name=$(basename "$icon")
	if [ -f "$ICONS/$name" ] && [ ! -f "$ICONS/$name.bak-koka" ]; then
		cp "$ICONS/$name" "$ICONS/$name.bak-koka"
	fi
	cp "$icon" "$ICONS/$name"
done

# LuCI hardcodes the same grey plug for every interface row. Use a per-protocol
# icon (AmneziaWG/WireGuard/bridge/tunnel) instead.
IFACE_JS=/www/luci-static/resources/view/network/interfaces.js
[ -f "$IFACE_JS.bak-koka" ] || cp "$IFACE_JS" "$IFACE_JS.bak-koka"
cp "$DIR/koka-interfaces.js" "$IFACE_JS"

# Bust the browser cache for the stylesheet and for every icon URL on each install.
TOKEN="koka-$(date +%s)"
sed -i "s#cascade.css?v=[^\"]*#cascade.css?v=$TOKEN#" "$HEAD"

cp "$DIR/koka-icon-bust.js" /www/luci-static/footstrap/koka-icon-bust.js
if ! grep -q 'koka-icon-bust.js' "$HEAD"; then
	sed -i "s#</head>#<script src=\"{{ media }}/koka-icon-bust.js?v=$TOKEN\"></script></head>#" "$HEAD"
fi

# pkgs_update_time is the mtime of the package DB and is the ?v= token on
# luci.js. Touching it invalidates every cached JS module without a manual
# "disable cache" reload.
touch /usr/lib/opkg/status 2>/dev/null || touch /lib/apk/db/installed 2>/dev/null || true

uci set footstrap.settings.wallpaper='off'
uci set footstrap.settings.rounding='16'
uci set footstrap.settings.content_width='1440'
uci set footstrap.settings.density='normal'
uci commit footstrap

rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache

echo 'Koka skin installed. Hard-refresh the browser (Ctrl+F5).'

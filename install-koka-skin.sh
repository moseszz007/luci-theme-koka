#!/bin/sh
# Apply the standalone Koka theme: icon set, interface icons, LuCI activation.
# Runs from the package postinst and from a manual install.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

# 1. Clean up the old "skin over footstrap" install (r19 and older).
CSS=/www/luci-static/footstrap/cascade.css
HEAD=/usr/share/ucode/luci/template/themes/footstrap/partials/head.ut
if [ -f "$CSS.bak-koka" ]; then
	cp "$CSS.bak-koka" "$CSS"
	rm -f "$CSS.bak-koka"
fi
if [ -f "$HEAD.bak-koka" ]; then
	cp "$HEAD.bak-koka" "$HEAD"
	rm -f "$HEAD.bak-koka"
fi
rm -f /www/luci-static/footstrap/koka-icon-bust.js
rm -f /www/luci-static/resources/view/status/koka_[0-9]*.js

# 2. Koka icon set; back up the stock icons once.
ICONS=/www/luci-static/resources/icons
mkdir -p "$ICONS"
for icon in "$DIR"/icons/*.svg; do
	[ -e "$icon" ] || continue
	name=$(basename "$icon")
	if [ -f "$ICONS/$name" ] && [ ! -f "$ICONS/$name.bak-koka" ]; then
		cp "$ICONS/$name" "$ICONS/$name.bak-koka"
	fi
	cp "$icon" "$ICONS/$name"
done

# 3. Protocol-aware icons in the network interface list.
IFACE_JS=/www/luci-static/resources/view/network/interfaces.js
if [ -f "$IFACE_JS" ] && [ -f "$DIR/koka-interfaces.js" ]; then
	[ -f "$IFACE_JS.bak-koka" ] || cp "$IFACE_JS" "$IFACE_JS.bak-koka"
	cp "$DIR/koka-interfaces.js" "$IFACE_JS"
fi

# 4. Runtime directory for the appearance page uploads.
mkdir -p /etc/koka

# 5. Register the theme and make it active.
uci set luci.themes.Koka='/luci-static/koka'
uci set luci.main.mediaurlbase='/luci-static/koka'
uci commit luci

# 6. Drop LuCI caches so new templates and CSS are picked up.
rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache

echo 'Koka theme applied. Hard-refresh the browser (Ctrl+F5).'

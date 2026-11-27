#!/bin/sh
# Manual install of the standalone Koka theme (without the package manager).
#   scp -r luci-theme-koka root@192.168.1.1:/root/
#   ssh root@192.168.1.1
#   sh /root/luci-theme-koka/install-koka-theme.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
THEME="$DIR/theme"

[ -d "$THEME/www/luci-static/koka" ] || {
	echo "theme/ not found next to this script" >&2
	exit 1
}

# Keep the existing theme settings on reinstall.
if [ -f /etc/config/koka ]; then
	cp /etc/config/koka /tmp/koka-config.save
fi

cp -a "$THEME"/. /

if [ -f /tmp/koka-config.save ]; then
	cp /tmp/koka-config.save /etc/config/koka
	rm -f /tmp/koka-config.save
fi

# Stylesheet = unskinned engine + Koka skin.
cat "$DIR/engine/cascade.base.css" "$DIR/koka-skin.css" > /www/luci-static/koka/cascade.css

# Runtime helpers used by the apply/rollback steps.
mkdir -p /usr/share/koka
cp "$DIR/install-koka-skin.sh" "$DIR/rollback-koka-skin.sh" "$DIR/koka-interfaces.js" /usr/share/koka/
cp -a "$DIR/icons" /usr/share/koka/icons

sh /usr/share/koka/install-koka-skin.sh

#!/bin/sh
# Add a separate "Dashboard" page under Status, leaving Overview untouched.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
VIEWDIR=/www/luci-static/resources/view/status
MENU=/usr/share/luci/menu.d/luci-app-koka-dashboard.json
TEMPLATE=/usr/share/ucode/luci/template/admin_status/index.ut
NAME="koka_$(date +%s)"

# If an earlier version replaced the Overview template, put the stock one back.
[ -f "$TEMPLATE.bak-koka-dashboard" ] && cp "$TEMPLATE.bak-koka-dashboard" "$TEMPLATE"

cp "$DIR/koka-dashboard.js" "$VIEWDIR/$NAME.js"

cat > "$MENU" <<EOF
{
	"admin/status/koka": {
		"title": "Дашборд",
		"order": 0,
		"action": {
			"type": "view",
			"path": "status/$NAME"
		},
		"depends": {
			"acl": [ "luci-mod-status-index" ]
		}
	}
}
EOF

for f in "$VIEWDIR"/koka*.js; do
	[ -e "$f" ] || continue
	[ "$f" = "$VIEWDIR/$NAME.js" ] && continue
	rm -f "$f"
done

rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache

echo "Koka dashboard added under Status (view: $NAME)."

"""Patch LuCI's Interfaces view so every interface row shows a fitting Koka icon.

Stock LuCI picks the icon from the L3 device type only, so AmneziaWG, PPPoE
and ZeroTier rows all fell back to the grey ethernet plug. The icon helper now
also looks at the interface protocol.
"""
from pathlib import Path
import sys

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name('interfaces.stock.js')
DST = Path(__file__).with_name('koka-interfaces.js')

s = SRC.read_text(encoding='utf-8')

old_fn = (
    "function render_iface(dev,alias){"
    "var type=dev?dev.getType():'ethernet',up=dev?dev.isUp():false;"
)
assert s.count(old_fn) == 1, s.count(old_fn)
new_fn = (
    "function render_iface(dev,alias,proto){"
    "var type=dev?dev.getType():'ethernet';"
    "if(proto=='amneziawg')type='amneziawg';"
    "else if(proto=='wireguard')type='wireguard';"
    "else if(proto=='pppoe'||proto=='ppp')type='ethernet';"
    "else if(proto=='none'&&dev&&/^zt/.test(dev.getName()))type='tunnel';"
    "var up=dev?dev.isUp():false;"
)
s = s.replace(old_fn, new_fn, 1)

old_call = "c=[render_iface(dev,ifc.isAlias())]"
assert s.count(old_call) == 1, s.count(old_call)
s = s.replace(old_call, "c=[render_iface(dev,ifc.isAlias(),ifc.getProtocol())]", 1)

DST.write_text(s, encoding='utf-8')
print('wrote', DST, len(s))

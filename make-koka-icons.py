"""Generate the Koka interface icon set (SVG, 24x24 line art).

Colors are baked in because LuCI renders these files through <img>, where
currentColor does not inherit from the page.
"""
from pathlib import Path

OUT = Path(__file__).with_name('icons')
NORMAL = '#A9B8D8'
DIM = '#61738F'
ACCENT = '#6EA8FE'
MUTED = '#3D4C67'


def svg(body: str, color: str = NORMAL, size: int = 32) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="1.8" '
        f'stroke-linecap="round" stroke-linejoin="round">{body}</svg>\n'
    )


def dot(cx: float, cy: float, r: float = 1) -> str:
    return f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="currentColor" stroke="none"/>'


def dots(color: str) -> str:
    return (
        f'<circle cx="7" cy="15" r="1" fill="{color}" stroke="none"/>'
        f'<circle cx="12" cy="15" r="1" fill="{color}" stroke="none"/>'
        f'<circle cx="17" cy="15" r="1" fill="{color}" stroke="none"/>'
    )


icons = {}

# --- physical / logical interface types -----------------------------------
icons['ethernet.svg'] = svg(
    '<path d="M9 2v5M15 2v5"/>'
    '<path d="M6 7h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6V7Z"/>'
    '<path d="M12 17v5"/>'
)

icons['bridge.svg'] = svg(
    '<rect x="2.5" y="8.5" width="6" height="7" rx="1.6"/>'
    '<rect x="15.5" y="8.5" width="6" height="7" rx="1.6"/>'
    '<path d="M8.5 12h7"/>'
    '<path d="M18.5 5.5v-2M5.5 20.5v-2" opacity=".45"/>'
)

icons['alias.svg'] = svg(
    '<path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z"/>'
    '<path d="m3 12 9 4.5 9-4.5"/>'
    '<path d="m3 16.5 9 4.5 9-4.5"/>'
)

icons['switch.svg'] = svg(
    '<rect x="2.5" y="6.5" width="19" height="11" rx="2.2"/>'
    '<path d="M6.5 11v2.5M9.83 11v2.5M13.17 11v2.5M16.5 11v2.5"/>'
    '<path d="M6.5 6.5V4M17.5 6.5V4" opacity=".45"/>'
)

icons['vlan.svg'] = svg(
    '<path d="M3 7a2 2 0 0 1 2-2h5l9 9-6 6-9-9V7Z"/>'
    '<circle cx="7.6" cy="7.6" r="1.1"/>'
)

icons['vrf.svg'] = svg(
    '<rect x="2.5" y="3.5" width="19" height="17" rx="2.2"/>'
    '<path d="M2.5 8.5h19M8 8.5V20.5"/>'
    '<path d="M11.5 12.5h6M11.5 16h4"/>'
)

icons['tunnel.svg'] = svg(
    '<path d="M3.5 20V10a8.5 8.5 0 0 1 17 0v10"/>'
    '<path d="M8 20v-9.5a4 4 0 0 1 8 0V20"/>'
)

# --- VPN flavours ---------------------------------------------------------
def shield(inner: str) -> str:
    return (
        '<path d="M12 2.8 4.6 5.7v5.2c0 4.9 3.1 8.4 7.4 10.3 4.3-1.9 7.4-5.4 7.4-10.3V5.7L12 2.8Z"/>'
        + inner
    )


icons['wireguard.svg'] = svg(
    shield('<path d="m8.4 10.8 1.7 4.8 1.9-4.1 1.9 4.1 1.7-4.8"/>')
)
icons['amneziawg.svg'] = svg(
    shield(f'<path d="M13.2 9.5 9.8 14h3.4l-2.2 4.8 5.4-6.2h-3.4l1.2-3.1Z" fill="{NORMAL}" stroke="none"/>')
)
icons['wifi.svg'] = svg(
    '<path d="M2.6 8.4a15 15 0 0 1 18.8 0"/>'
    '<path d="M5.7 12.2a10 10 0 0 1 12.6 0"/>'
    f'<path d="M8.8 15.9a5 5 0 0 1 6.4 0"/>'
    f'<circle cx="12" cy="19.3" r="1.15" fill="{NORMAL}" stroke="none"/>'
)

# --- port diagram ---------------------------------------------------------
icons['port_up.svg'] = svg(
    '<rect x="2.5" y="9.5" width="19" height="10.5" rx="2.2"/>'
    '<path d="M12 8V3m-3 3 3-3 3 3"/>'
    '<path d="M7 15h.01M12 15h.01M17 15h.01"/>'
)
icons['port_down.svg'] = svg(
    '<rect x="2.5" y="4" width="19" height="10.5" rx="2.2"/>'
    '<path d="M12 16v5m-3-3 3 3 3-3"/>'
    '<path d="M7 9.5h.01M12 9.5h.01M17 9.5h.01"/>',
    DIM,
)

# --- signal strength: three Wi-Fi arcs plus the dot, lit by level ---------
ARCS = [
    ('M2.6 9a15 15 0 0 1 18.8 0', 4),
    ('M5.9 12.6a10 10 0 0 1 12.2 0', 3),
    ('M9.1 16.1a5 5 0 0 1 5.8 0', 2),
]
TITLES = {
    'signal-000-000.svg': 0,
    'signal-000-025.svg': 1,
    'signal-025-050.svg': 2,
    'signal-050-075.svg': 3,
    'signal-075-100.svg': 4,
}
for name, level in TITLES.items():
    body = ''
    if level >= 1:
        body += f'<circle cx="12" cy="19.2" r="1.5" fill="{ACCENT}" stroke="none"/>'
    else:
        body += f'<circle cx="12" cy="19.2" r="1.5" fill="{MUTED}" stroke="none"/>'
    for path, need in ARCS:
        color = ACCENT if level >= need else MUTED
        body += f'<path d="{path}" stroke="{color}"/>'
    icons[name] = svg(body, ACCENT)

icons['signal-none.svg'] = svg(
    '<path d="M2.6 9a15 15 0 0 1 18.8 0"/>'
    '<path d="M5.9 12.6a10 10 0 0 1 12.2 0"/>'
    '<path d="M9.1 16.1a5 5 0 0 1 5.8 0"/>'
    '<circle cx="12" cy="19.2" r="1.5" fill="' + DIM + '" stroke="none"/>'
    '<path d="M2.8 2.8 21.2 21.2"/>',
    DIM,
)

icons['loading.svg'] = svg(
    '<path d="M21 12a9 9 0 1 1-6.2-8.55" stroke="' + ACCENT + '"/>',
    ACCENT,
)

# --- disabled variants: same geometry, dimmer ink -------------------------
for name in ('ethernet', 'bridge', 'alias', 'switch', 'vlan', 'vrf', 'tunnel',
             'wireguard', 'amneziawg', 'wifi'):
    icons[name + '_disabled.svg'] = icons[name + '.svg'].replace(
        f'stroke="{NORMAL}"', f'stroke="{DIM}"'
    ).replace(f'fill="{NORMAL}"', f'fill="{DIM}"')

OUT.mkdir(parents=True, exist_ok=True)
for name, content in icons.items():
    (OUT / name).write_text(content, encoding='utf-8')
print('generated', len(icons), 'icons in', OUT)

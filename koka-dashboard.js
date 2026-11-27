'use strict';
'require view';
'require poll';
'require rpc';
'require fs';
'require dom';
'require ui';

const callBoard = rpc.declare({ object: 'system', method: 'board' });
const callInfo = rpc.declare({ object: 'system', method: 'info' });
const callHostHints = rpc.declare({ object: 'luci-rpc', method: 'getHostHints', expect: { '': {} } });
const callLeases = rpc.declare({ object: 'luci-rpc', method: 'getDHCPLeases', expect: { '': {} } });
const callInet = rpc.declare({ object: 'luci.internet-detector', method: 'InetStatus', expect: { '': {} } });

const state = {
	cpu: null,
	net: { wan: null, lan: null },
	samples: { wan: { rx: [], tx: [] }, lan: { rx: [], tx: [] } }
};

function noBatch() {
	if (rpc.__kokaNoBatch)
		return;

	const original = rpc.call;

	rpc.call = function(request, callback) {
		return original.call(this, request, callback, true);
	};

	rpc.__kokaNoBatch = true;
}

function withTimeout(promise, timeout, fallback) {
	return Promise.race([
		Promise.resolve(promise),
		new Promise(function(resolve) {
			window.setTimeout(function() {
				resolve(fallback);
			}, timeout);
		})
	]);
}

function readFile(path) {
	return L.resolveDefault(withTimeout(fs.read(path), 4000, ''), '');
}

function pct(value, total) {
	return total > 0 ? Math.max(0, Math.min(100, 100 * value / total)) : 0;
}

function fmtBytes(value) {
	if (value == null || isNaN(value))
		return '—';

	const units = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ];
	let number = Math.max(0, Number(value));
	let unit = 0;

	while (number >= 1024 && unit < units.length - 1) {
		number /= 1024;
		unit++;
	}

	return (unit === 0 ? Math.round(number) : number.toFixed(number >= 10 ? 1 : 2)) + ' ' + units[unit];
}

function fmtRate(value) {
	if (value == null || isNaN(value))
		return '—';

	return fmtBytes(value) + '/s';
}

function fmtDuration(value) {
	if (value == null || value < 0)
		return '—';

	return '%t'.format(value);
}

function fmtSpeed(value) {
	if (!value)
		return '—';

	return value + ' Mb/s';
}

function cpuUsage(text) {
	const line = (text || '').split('\n')[0];
	const parts = line.trim().split(/\s+/).slice(1).map(Number);

	if (parts.length < 4 || parts.some(isNaN))
		return null;

	const idle = parts[3] + (parts[4] || 0);
	const total = parts.reduce(function(a, b) { return a + b; }, 0);
	let usage = null;

	if (state.cpu && total > state.cpu.total) {
		const dt = total - state.cpu.total;
		const di = idle - state.cpu.idle;

		usage = Math.max(0, Math.min(100, 100 * (1 - di / dt)));
	}

	state.cpu = { total: total, idle: idle };

	return usage;
}

function netRate(dev, key) {
	if (!dev)
		return null;

	const now = Date.now();
	const rx = dev.getRXBytes() || 0;
	const tx = dev.getTXBytes() || 0;
	const prev = state.net[key];

	state.net[key] = { rx: rx, tx: tx, time: now };

	if (!prev || now <= prev.time)
		return null;

	const dt = Math.max(1, (now - prev.time) / 1000);

	return {
		rx: Math.max(0, (rx - prev.rx) / dt),
		tx: Math.max(0, (tx - prev.tx) / dt)
	};
}

function addSample(key, rate) {
	if (!rate)
		return;

	const samples = state.samples[key];

	samples.rx.push(rate.rx);
	samples.tx.push(rate.tx);

	if (samples.rx.length > 24) {
		samples.rx.shift();
		samples.tx.shift();
	}
}

function parseArp(text) {
	const arp = {};

	(text || '').split('\n').slice(1).forEach(function(line) {
		const parts = line.trim().split(/\s+/);

		if (parts.length >= 4 && parts[3] !== '0x0')
			arp[parts[0]] = parts[3].toUpperCase();
	});

	return arp;
}

function fetchAll() {
	return L.require('network').then(function(network) {
		return Promise.all([
		L.resolveDefault(withTimeout(callBoard(), 4000, {}), {}),
		L.resolveDefault(withTimeout(callInfo(), 4000, {}), {}),
		L.resolveDefault(withTimeout(network.getWANNetworks(), 4000, []), []),
		L.resolveDefault(withTimeout(network.getNetworks(), 4000, []), []),
		L.resolveDefault(withTimeout(network.getDevices(), 4000, []), []),
		L.resolveDefault(withTimeout(callHostHints(), 4000, {}), {}),
		L.resolveDefault(withTimeout(callLeases(), 4000, { dhcp_leases: [] }), { dhcp_leases: [] }),
		L.resolveDefault(withTimeout(callInet(), 4000, { instances: [] }), { instances: [] }),
		readFile('/proc/stat'),
		readFile('/proc/net/arp'),
		readFile('/proc/sys/net/netfilter/nf_conntrack_count'),
		readFile('/proc/sys/net/netfilter/nf_conntrack_max'),
		readFile('/sys/class/thermal/thermal_zone0/temp')
	]);
	}).then(function(res) {
		const board = res[0] || {};
		const info = res[1] || {};
		const wans = res[2] || [];
		const nets = res[3] || [];
		const devs = res[4] || [];
		const hints = res[5] || {};
		const leases = (res[6] && res[6].dhcp_leases) || [];
		const detector = (res[7] && res[7].instances) || [];
		const cpuText = res[8] || '';
		const arp = parseArp(res[9] || '');
		const ctCount = parseInt(res[10]) || 0;
		const ctMax = parseInt(res[11]) || 0;
		const tempRaw = parseInt(res[12]);
		const temp = isNaN(tempRaw) ? null : tempRaw / 1000;

		const wan = wans.find(function(n) { return n.getName() === 'wan'; }) || wans[0] || null;
		const lan = nets.find(function(n) { return n.getName() === 'lan'; }) || null;
		const wanDev = wan && wan.getL3Device ? wan.getL3Device() : null;
		const lanDev = lan && lan.getL3Device ? lan.getL3Device() : null;

		const hintsU = {};
		Object.keys(hints).forEach(function(mac) {
			hintsU[mac.toUpperCase()] = hints[mac];
		});

		const clients = leases.map(function(lease) {
			const mac = (lease.macaddr || '').toUpperCase();
			const hint = hintsU[mac] || {};

			return {
				name: hint.name || lease.hostname || mac || '?',
				ip: lease.ipaddr || '—',
				mac: mac,
				online: !!arp[lease.ipaddr]
			};
		}).sort(function(a, b) {
			if (a.online !== b.online)
				return a.online ? -1 : 1;

			return a.name.localeCompare(b.name);
		});

		const vpns = nets.filter(function(n) {
			const proto = (n.getProtocol() || '').toLowerCase();
			const dev = n.getL3Device ? n.getL3Device() : null;
			return n.isUp() && dev && (!dev.isUp || dev.isUp()) && n.getName() !== 'lan' && n.getName() !== 'wan'
				&& /amnezia|wireguard|openvpn|zerotier|vpn/.test(proto);
		}).map(function(n) {
			const addr = n.getIPAddr ? n.getIPAddr() : null;
			return { name: n.getName(), ip: addr, proto: n.getI18n() };
		});

		const ports = devs.filter(function(d) {
			return /^eth\d+$/.test(d.getName());
		}).map(function(d) {
			return {
				name: d.getName(),
				speed: d.getSpeed ? d.getSpeed() : null,
				carrier: d.getCarrier ? d.getCarrier() : null,
				rx: d.getRXBytes ? d.getRXBytes() : 0,
				tx: d.getTXBytes ? d.getTXBytes() : 0
			};
		});

		const cpu = cpuUsage(cpuText);
		const wanRate = netRate(wanDev, 'wan');
		const lanRate = netRate(lanDev, 'lan');

		addSample('wan', wanRate);
		addSample('lan', lanRate);

		const mainDetector = detector.find(function(i) { return i.instance === 'internet'; }) || detector[0] || null;

		let status = 'bad';

		if (mainDetector) {
			if (mainDetector.inet == 0)
				status = 'ok';
			else if (mainDetector.inet == -1)
				status = 'warn';
		}
		else if (wan && wan.isUp()) {
			status = 'ok';
		}

		return {
			board: board,
			info: info,
			wan: wan,
			lan: lan,
			wanDev: wanDev,
			lanDev: lanDev,
			wans: wans,
			vpns: vpns,
			ports: ports,
			clients: clients,
			detector: detector,
			status: status,
			cpu: cpu,
			wanRate: wanRate,
			lanRate: lanRate,
			ctCount: ctCount,
			ctMax: ctMax,
			temp: temp,
			arp: arp,
			samples: state.samples
		};
	});
}

function makeSpark() {
	return E('<svg class="koka-spark" viewBox="0 0 100 30" preserveAspectRatio="none">'
		+ '<polyline class="rx" fill="none" stroke-width="1.6" points=""></polyline>'
		+ '<polyline class="tx" fill="none" stroke-width="1.6" points=""></polyline>'
		+ '</svg>');
}

function updateSpark(svg, data) {
	if (!svg || !data)
		return;

	const rx = data.rx.slice();
	const tx = data.tx.slice();
	const pad = 24 - rx.length;

	while (rx.length < 24)
		rx.unshift(0);
	while (tx.length < 24)
		tx.unshift(0);

	const max = Math.max(1, Math.max.apply(null, rx.concat(tx)));
	const points = function(values) {
		return values.map(function(value, index) {
			return (index / 23 * 100).toFixed(2) + ',' + (28 - value / max * 26).toFixed(2);
		}).join(' ');
	};

	const rxLine = svg.querySelector('.rx');
	const txLine = svg.querySelector('.tx');

	if (rxLine)
		rxLine.setAttribute('points', points(rx));
	if (txLine)
		txLine.setAttribute('points', points(tx));
}

function pill(text) {
	return E('span', { 'class': 'koka-pill' }, [
		E('i'),
		E('span', {}, text || '—')
	]);
}

function row(label, value) {
	return E('div', { 'class': 'koka-row' }, [
		E('span', { 'class': 'koka-label' }, label),
		value
	]);
}

function card(icon, title, extra) {
	const section = E('section', { 'class': 'koka-card' }, [
		E('header', { 'class': 'koka-card-head' }, [
			E('span', { 'class': 'koka-card-ico koka-ico ' + icon }),
			E('span', { 'class': 'koka-card-title' }, title),
			extra || ''
		]),
		E('div', { 'class': 'koka-card-body' })
	]);

	return { el: section, body: section.lastElementChild };
}

function action(href, icon, label) {
	return E('a', { 'class': 'koka-action', 'href': href }, [
		E('span', { 'class': 'koka-ico ' + icon }),
		E('span', {}, label)
	]);
}

function ensureStyles() {
	if (document.getElementById('koka-dash-style'))
		return;

	document.head.appendChild(E('style', { 'id': 'koka-dash-style' }, `
:root{
--kd-router:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='20' height='8' x='2' y='14' rx='2'/%3E%3Cpath d='M6.01 18H6'/%3E%3Cpath d='M10.01 18H10'/%3E%3Cpath d='M15 10v4'/%3E%3Cpath d='M17.84 7.17a4 4 0 0 0-5.66 0'/%3E%3Cpath d='M20.66 4.34a8 8 0 0 0-11.31 0'/%3E%3C/svg%3E");
--kd-globe:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='M2 12h20'/%3E%3Cpath d='M12 2a15.3 15.3 0 0 1 0 20a15.3 15.3 0 0 1 0-20'/%3E%3C/svg%3E");
--kd-cpu:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='4' y='4' width='16' height='16' rx='2'/%3E%3Crect x='9' y='9' width='6' height='6' rx='1'/%3E%3Cpath d='M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3'/%3E%3C/svg%3E");
--kd-users:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'/%3E%3Ccircle cx='9' cy='7' r='4'/%3E%3Cpath d='M22 21v-2a4 4 0 0 0-3-3.87'/%3E%3Cpath d='M16 3.13a4 4 0 0 1 0 7.75'/%3E%3C/svg%3E");
--kd-link:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'/%3E%3Cpath d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'/%3E%3C/svg%3E");
--kd-plug:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2' y='14' width='20' height='6' rx='1'/%3E%3Cpath d='M6 18h.01M10 18h.01M14 18h.01M18 18h.01'/%3E%3Cpath d='M12 10V4'/%3E%3C/svg%3E");
--kd-bolt:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M13 2 3 14h9l-1 8 10-12h-9l1-8Z'/%3E%3C/svg%3E");
--kd-net:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2' y='2' width='6' height='6' rx='1'/%3E%3Crect x='16' y='2' width='6' height='6' rx='1'/%3E%3Crect x='9' y='16' width='6' height='6' rx='1'/%3E%3Cpath d='M5 8v4h14V8M12 12v4'/%3E%3C/svg%3E");
--kd-shield:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z'/%3E%3C/svg%3E");
--kd-dns:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2' y='3' width='20' height='7' rx='2'/%3E%3Crect x='2' y='14' width='20' height='7' rx='2'/%3E%3Cpath d='M6 6.5h.01M6 17.5h.01'/%3E%3C/svg%3E");
--kd-dhcp:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M8 6h13M8 12h13M8 18h13'/%3E%3Cpath d='M3 6h.01M3 12h.01M3 18h.01'/%3E%3C/svg%3E");
--kd-reboot:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M18.36 6.64a9 9 0 1 1-12.73 0'/%3E%3Cpath d='M12 2v10'/%3E%3C/svg%3E");
}
[data-page="admin-status-overview"] h2[name="content"]{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
#view .koka-dash{display:flex;flex-direction:column;gap:16px;color:var(--d)}
.koka-hero{position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;padding:22px;border:1px solid color-mix(in srgb,var(--S) 70%,transparent);border-radius:18px;background:linear-gradient(120deg,color-mix(in srgb,var(--a) 14%,var(--an)),var(--an) 55%);box-shadow:0 14px 40px rgba(2,8,23,.16),inset 0 1px 0 rgba(255,255,255,.05)}
.koka-hero::after{content:"";position:absolute;right:-120px;top:-150px;width:380px;height:380px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--a) 28%,transparent),transparent 70%);pointer-events:none}
.koka-hero-main{display:flex;align-items:center;gap:16px;min-width:0;position:relative;z-index:1}
.koka-hero-ico{width:54px;height:54px;border-radius:16px;display:grid;place-items:center;background:color-mix(in srgb,var(--a) 16%,var(--V));border:1px solid color-mix(in srgb,var(--a) 35%,transparent);color:var(--a);flex:0 0 auto}
.koka-hero-ico .koka-ico{width:28px;height:28px}
.koka-kicker{font-size:.68rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--a);margin-bottom:2px}
.koka-hero-name{margin:0;font-size:1.5rem;line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.koka-hero-sub{font-size:.8rem;color:var(--c);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.koka-hero-status{position:relative;z-index:1;align-self:start}
.koka-hero-metrics{grid-column:1/-1;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;position:relative;z-index:1}
.koka-metric{padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--V) 55%,transparent);border:1px solid color-mix(in srgb,var(--S) 45%,transparent);min-width:0}
.koka-metric-label{display:block;font-size:.68rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--c);margin-bottom:3px}
.koka-metric b{display:block;font-size:1.02rem;font-weight:700;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.koka-hero-actions{grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap;position:relative;z-index:1}
.koka-hero-actions .koka-action{flex:0 0 auto}
.koka-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px}
.koka-card{grid-column:span 6;display:flex;flex-direction:column;border:1px solid color-mix(in srgb,var(--S) 70%,transparent);border-radius:16px;background:linear-gradient(180deg,color-mix(in srgb,var(--an) 94%,#fff 6%),var(--an));box-shadow:0 10px 30px rgba(2,8,23,.13),inset 0 1px 0 rgba(255,255,255,.04);overflow:hidden}
.koka-card.span7{grid-column:span 7}
.koka-card.span5{grid-column:span 5}
.koka-card-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid color-mix(in srgb,var(--S) 45%,transparent)}
.koka-card-ico{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:color-mix(in srgb,var(--a) 13%,var(--V));color:var(--a);flex:0 0 auto}
.koka-card-ico .koka-ico,.koka-card-ico.koka-ico{width:19px;height:19px}
.koka-card-title{font-weight:700;font-size:.95rem;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.koka-card-body{padding:14px 16px;display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-width:0}
.koka-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0}
.koka-label{color:var(--c);font-size:.8rem;white-space:nowrap}
.koka-value{font-size:.86rem;font-weight:600;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.koka-value.mono{font-family:var(--M);font-size:.82rem}
.koka-pill{display:inline-flex;align-items:center;gap:.4em;padding:.28em .62em;border-radius:999px;border:1px solid transparent;font-size:.74rem;font-weight:700;line-height:1.3;white-space:nowrap}
.koka-pill i{width:.5em;height:.5em;border-radius:50%;background:currentColor;flex:0 0 auto}
.koka-pill.ok{color:var(--O);background:color-mix(in srgb,var(--O) 14%,var(--an));border-color:color-mix(in srgb,var(--O) 35%,transparent)}
.koka-pill.bad{color:var(--K);background:color-mix(in srgb,var(--K) 14%,var(--an));border-color:color-mix(in srgb,var(--K) 35%,transparent)}
.koka-pill.warn{color:var(--R);background:color-mix(in srgb,var(--R) 14%,var(--an));border-color:color-mix(in srgb,var(--R) 35%,transparent)}
.koka-pill.muted{color:var(--c);background:color-mix(in srgb,var(--c) 10%,var(--an));border-color:color-mix(in srgb,var(--S) 55%,transparent)}
.koka-spark{width:100%;height:44px;display:block;margin-top:2px;opacity:.95}
.koka-spark .rx{stroke:var(--a)}
.koka-spark .tx{stroke:var(--O)}
.koka-sys-top{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.koka-ring{--p:0;position:relative;width:94px;height:94px;border-radius:50%;background:conic-gradient(var(--a) calc(var(--p)*1%),var(--E) 0);display:grid;place-items:center;flex:0 0 auto}
.koka-ring::before{content:"";position:absolute;inset:7px;border-radius:50%;background:var(--an)}
.koka-ring-val{position:relative;z-index:1;text-align:center;line-height:1.05}
.koka-ring-val b{display:block;font-size:1.05rem}
.koka-ring-val small{display:block;font-size:.58rem;text-transform:uppercase;letter-spacing:.08em;color:var(--c);margin-top:2px}
.koka-bars{flex:1 1 180px;display:flex;flex-direction:column;gap:9px;min-width:0}
.koka-bar-head{display:flex;justify-content:space-between;gap:8px;font-size:.72rem;color:var(--c);margin-bottom:4px}
.koka-bar-head b{color:var(--d);font-weight:600}
.koka-bar{height:7px;border-radius:999px;background:var(--E);overflow:hidden}
.koka-bar i{display:block;height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,var(--a),#a78bfa);transition:width .4s ease}
.koka-bar.good i{background:linear-gradient(90deg,var(--O),#14b8a6)}
.koka-bar.warn i{background:linear-gradient(90deg,var(--R),#f97316)}
.koka-clients{display:flex;flex-direction:column;gap:2px}
.koka-client{display:flex;align-items:center;gap:9px;padding:6px 0;border-bottom:1px solid color-mix(in srgb,var(--S) 35%,transparent);min-width:0}
.koka-client:last-child{border-bottom:0}
.koka-dot{width:8px;height:8px;border-radius:50%;background:var(--c);flex:0 0 auto;box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 12%,transparent)}
.koka-dot.on{background:var(--O);box-shadow:0 0 0 3px color-mix(in srgb,var(--O) 15%,transparent)}
.koka-client-main{flex:1 1 auto;min-width:0}
.koka-client-name{display:block;font-size:.83rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.koka-client-ip{display:block;font-family:var(--M);font-size:.68rem;color:var(--c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.koka-ports{display:flex;flex-direction:column;gap:4px}
.koka-port{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid color-mix(in srgb,var(--S) 35%,transparent);min-width:0}
.koka-port:last-child{border-bottom:0}
.koka-port-name{font-family:var(--M);font-size:.8rem;font-weight:600;flex:0 0 auto}
.koka-role{font-size:.6rem;font-weight:700;letter-spacing:.08em;padding:.12em .4em;border-radius:6px;background:color-mix(in srgb,var(--a) 12%,var(--V));color:var(--a);flex:0 0 auto}
.koka-port-main{flex:1 1 auto;min-width:0}
.koka-port-speed{display:block;font-size:.72rem;color:var(--c)}
.koka-port-bytes{display:block;font-size:.68rem;color:var(--c);font-family:var(--M);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.koka-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.koka-action{display:flex;align-items:center;gap:9px;padding:10px;border-radius:11px;border:1px solid color-mix(in srgb,var(--S) 50%,transparent);background:color-mix(in srgb,var(--V) 45%,transparent);color:var(--d);text-decoration:none;font-size:.8rem;font-weight:600;min-width:0;transition:background .15s,border-color .15s,transform .15s}
.koka-action:hover{background:color-mix(in srgb,var(--a) 10%,var(--V));border-color:color-mix(in srgb,var(--a) 35%,transparent);transform:translateY(-1px)}
.koka-action .koka-ico{width:17px;height:17px;color:var(--a);flex:0 0 auto}
.koka-action span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.koka-empty{color:var(--c);font-size:.8rem;font-style:italic}
.koka-vpns{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
.koka-vpn{font-size:.7rem;padding:.2em .55em;border-radius:999px;background:color-mix(in srgb,var(--V) 60%,transparent);border:1px solid color-mix(in srgb,var(--S) 45%,transparent);color:var(--c);font-family:var(--M)}
.koka-ico{display:inline-block;background:currentColor;-webkit-mask-position:center;-webkit-mask-size:contain;-webkit-mask-repeat:no-repeat;mask-position:center;mask-size:contain;mask-repeat:no-repeat}
.koka-ico-router{-webkit-mask-image:var(--kd-router);mask-image:var(--kd-router);width:28px;height:28px}
.koka-ico-net{-webkit-mask-image:var(--kd-globe);mask-image:var(--kd-globe)}
.koka-ico-sys{-webkit-mask-image:var(--kd-cpu);mask-image:var(--kd-cpu)}
.koka-ico-users{-webkit-mask-image:var(--kd-users);mask-image:var(--kd-users)}
.koka-ico-link{-webkit-mask-image:var(--kd-link);mask-image:var(--kd-link)}
.koka-ico-plug{-webkit-mask-image:var(--kd-plug);mask-image:var(--kd-plug)}
.koka-ico-bolt{-webkit-mask-image:var(--kd-bolt);mask-image:var(--kd-bolt)}
.koka-ico-refresh{-webkit-mask-image:var(--koka-ico-reset);mask-image:var(--koka-ico-reset)}
.koka-ico-net2{-webkit-mask-image:var(--kd-net);mask-image:var(--kd-net)}
.koka-ico-shield{-webkit-mask-image:var(--kd-shield);mask-image:var(--kd-shield)}
.koka-ico-dns{-webkit-mask-image:var(--kd-dns);mask-image:var(--kd-dns)}
.koka-ico-dhcp{-webkit-mask-image:var(--kd-dhcp);mask-image:var(--kd-dhcp)}
.koka-ico-reboot{-webkit-mask-image:var(--kd-reboot);mask-image:var(--kd-reboot)}
@media (max-width:1100px){.koka-card.span7,.koka-card.span5{grid-column:span 6}.koka-hero-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:760px){.koka-card,.koka-card.span7,.koka-card.span5{grid-column:span 12}.koka-hero{grid-template-columns:1fr;padding:16px}.koka-hero-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.koka-grid{gap:12px}.koka-card{border-radius:14px}.koka-actions{grid-template-columns:1fr}.koka-hero-name{font-size:1.3rem}.koka-hero-actions .koka-action{flex:1 1 auto;justify-content:center}.koka-ring{width:84px;height:84px}}
@media (prefers-reduced-motion:reduce){.koka-action,.koka-bar i{transition:none}}
	`));
}

return view.extend({
	load: function() {
		return null;
	},

	render: function() {
		noBatch();
		ensureStyles();

		const refs = this.refs = {};

		const heroPill = pill('—');
		const heroName = E('h2', { 'class': 'koka-hero-name' }, '—');
		const heroModel = E('div', { 'class': 'koka-hero-sub' }, '—');
		const heroFw = E('div', { 'class': 'koka-hero-sub' }, '—');
		const hero = E('section', { 'class': 'koka-hero' }, [
			E('div', { 'class': 'koka-hero-main' }, [
				E('span', { 'class': 'koka-hero-ico' }, E('span', { 'class': 'koka-ico koka-ico-router' })),
				E('div', { style: 'min-width:0' }, [
					E('div', { 'class': 'koka-kicker' }, 'Роутер'),
					heroName,
					heroModel,
					heroFw
				])
			]),
			E('div', { 'class': 'koka-hero-status' }, heroPill),
			E('div', { 'class': 'koka-hero-metrics' })
		]);

		function metric(label) {
			const value = E('b', {}, '—');
			const metric = E('div', { 'class': 'koka-metric' }, [
				E('span', { 'class': 'koka-metric-label' }, label),
				value
			]);

			return { el: metric, value: value };
		}

		const mWan = metric(_('WAN IP'));
		const mClients = metric('Клиенты');
		const mCpu = metric(_('CPU'));
		const mRam = metric('ОЗУ');
		const mTemp = metric('Температура');

		[ mWan, mClients, mCpu, mRam, mTemp ].forEach(function(m) {
			hero.lastElementChild.appendChild(m.el);
		});

		const actions = E('div', { 'class': 'koka-hero-actions' }, [
			E('button', {
				'class': 'koka-action',
				'type': 'button',
				'click': ui.createHandlerFn(this, function() {
					return fetchAll().then(L.bind(this.update, this));
				})
			}, [
				E('span', { 'class': 'koka-ico koka-ico-refresh' }),
				E('span', {}, 'Обновить')
			]),
			action(L.url('admin/network/network'), 'koka-ico-net2', _('Interfaces')),
			action(L.url('admin/services/dnsproxy'), 'koka-ico-dns', _('DNS Proxy')),
			action(L.url('admin/system/reboot'), 'koka-ico-reboot', _('Reboot'))
		]);

		hero.appendChild(actions);

		Object.assign(refs, {
			heroPill: heroPill,
			heroPillText: heroPill.lastElementChild,
			heroName: heroName,
			heroModel: heroModel,
			heroFw: heroFw,
			wanIp: mWan.value,
			clientsMetric: mClients.value,
			cpuMetric: mCpu.value,
			ramMetric: mRam.value,
			tempMetric: mTemp.value
		});

		const internet = card('koka-ico-net', 'Интернет');
		const internetPill = pill('—');
		internet.el.classList.add('span7');
		internet.el.firstElementChild.appendChild(internetPill);
		refs.netPill = internetPill;
		refs.netPillText = internetPill.lastElementChild;

		refs.wanProto = E('span', { 'class': 'koka-value' }, '—');
		refs.wanIpCard = E('span', { 'class': 'koka-value mono' }, '—');
		refs.wanGw = E('span', { 'class': 'koka-value mono' }, '—');
		refs.wanDns = E('span', { 'class': 'koka-value mono' }, '—');
		refs.wanUptime = E('span', { 'class': 'koka-value' }, '—');
		refs.wanRx = E('span', { 'class': 'koka-value' }, '—');
		refs.wanTx = E('span', { 'class': 'koka-value' }, '—');
		internet.body.appendChild(row('Подключение', refs.wanProto));
		internet.body.appendChild(row(_('WAN IP'), refs.wanIpCard));
		internet.body.appendChild(row('Шлюз', refs.wanGw));
		internet.body.appendChild(row('DNS', refs.wanDns));
		internet.body.appendChild(row('Время работы', refs.wanUptime));
		internet.body.appendChild(row('Входящий', refs.wanRx));
		internet.body.appendChild(row('Исходящий', refs.wanTx));

		const spark = makeSpark();
		internet.body.appendChild(spark);
		refs.wanSpark = spark;

		refs.detector = E('div', { 'class': 'koka-vpns' });
		internet.body.appendChild(refs.detector);

		const system = card('koka-ico-sys', 'Система');
		system.el.classList.add('span5');
		const ring = E('div', { 'class': 'koka-ring' }, [
			E('div', { 'class': 'koka-ring-val' }, [
				E('b', {}, '—'),
				E('small', {}, _('CPU'))
			])
		]);
		const bars = E('div', { 'class': 'koka-bars' });
		system.body.appendChild(E('div', { 'class': 'koka-sys-top' }, [ ring, bars ]));

		function bar(label, cls) {
			const value = E('b', {}, '—');
			const fill = E('i');
			const bar = E('div', { 'class': 'koka-bar ' + (cls || '') }, [ fill ]);
			const row = E('div', {}, [
				E('div', { 'class': 'koka-bar-head' }, [
					E('span', {}, label),
					value
				]),
				bar
			]);
			bars.appendChild(row);
			return { value: value, fill: fill };
		}

		const ram = bar('ОЗУ');
		const disk = bar('Rootfs');
		refs.cpuRing = ring;
		refs.cpuRingVal = ring.querySelector('b');
		refs.ram = ram;
		refs.disk = disk;

		refs.load = E('span', { 'class': 'koka-value' }, '—');
		refs.temp = E('span', { 'class': 'koka-value' }, '—');
		system.body.appendChild(row('Средняя нагрузка', refs.load));
		system.body.appendChild(row('Температура', refs.temp));

		const clients = card('koka-ico-users', 'Клиенты');
		clients.el.classList.add('span7');
		refs.clientsCount = E('span', { 'class': 'koka-pill muted' }, '—');
		clients.el.firstElementChild.appendChild(refs.clientsCount);
		refs.clients = E('div', { 'class': 'koka-clients' });
		clients.body.appendChild(refs.clients);
		clients.body.appendChild(E('a', {
			'class': 'koka-action',
			'href': L.url('admin/network/dhcp')
		}, [
			E('span', { 'class': 'koka-ico koka-ico-users' }),
			E('span', {}, 'Все адреса')
		]));

		const conn = card('koka-ico-link', 'Соединения');
		conn.el.classList.add('span5');
		refs.ctVal = E('span', { 'class': 'koka-value' }, '—');
		conn.body.appendChild(row('Активные', refs.ctVal));
		refs.ctFill = E('i');
		conn.body.appendChild(E('div', { 'class': 'koka-bar' }, [ refs.ctFill ]));
		refs.ctHint = E('div', { 'class': 'koka-empty' }, '—');
		conn.body.appendChild(refs.ctHint);

		const ports = card('koka-ico-plug', 'Порты');
		ports.el.classList.add('span7');
		refs.ports = E('div', { 'class': 'koka-ports' });
		ports.body.appendChild(refs.ports);

		const quick = card('koka-ico-bolt', 'Быстрые действия');
		quick.el.classList.add('span5');
		quick.body.appendChild(E('div', { 'class': 'koka-actions' }, [
			action(L.url('admin/network/network'), 'koka-ico-net2', _('Interfaces')),
			action(L.url('admin/network/dhcp'), 'koka-ico-dhcp', _('DHCP')),
			action(L.url('admin/network/firewall'), 'koka-ico-shield', _('Firewall')),
			action(L.url('admin/services/dnsproxy'), 'koka-ico-dns', _('DNS Proxy')),
			action(L.url('admin/services/internet-detector'), 'koka-ico-net', _('Internet Detector')),
			action(L.url('admin/system/reboot'), 'koka-ico-reboot', _('Reboot'))
		]));

		const grid = E('div', { 'class': 'koka-grid' }, [
			internet.el,
			system.el,
			clients.el,
			conn.el,
			ports.el,
			quick.el
		]);

		const dash = E('div', { 'class': 'koka-dash' }, [ hero, grid ]);

		const self = this;

		withTimeout(fetchAll(), 12000, null).then(function(data) {
			if (data)
				self.update(data);
		}).catch(function() {});

		poll.add(L.bind(this.tick, this), 5);

		return dash;
	},

	tick: function() {
		return fetchAll().then(L.bind(this.update, this)).catch(function() {});
	},

	update: function(data) {
		const refs = this.refs;

		if (!refs)
			return;

		const status = data.status;
		const info = data.info || {};
		const board = data.board || {};
		const wan = data.wan;
		const clients = data.clients || [];
		const detector = data.detector || [];
		const temp = data.temp;

		const setText = function(el, value) {
			if (el)
				el.textContent = value;
		};

		const setPill = function(pill, state, text) {
			if (!pill)
				return;

			pill.className = 'koka-pill ' + state;
			pill.lastElementChild.textContent = text;
		};

		const statusText = status === 'ok' ? 'Онлайн' : (status === 'warn' ? 'Неизвестно' : 'Офлайн');

		setPill(refs.heroPill, status, statusText);
		setPill(refs.netPill, status, statusText);
		setText(refs.heroName, board.hostname || 'KokaWRT');
		setText(refs.heroModel, board.model || '—');
		setText(refs.heroFw, (board.release && board.release.description) || '—');

		const wanIp = wan && (wan.getIPAddr ? wan.getIPAddr() : null) || '—';
		const onlineClients = clients.filter(function(c) { return c.online; }).length;
		const ramPercent = pct((info.memory ? info.memory.total - info.memory.available : 0), (info.memory ? info.memory.total : 0));

		setText(refs.wanIp, wanIp);
		setText(refs.clientsMetric, onlineClients + ' / ' + clients.length);
		setText(refs.cpuMetric, data.cpu == null ? '—' : Math.round(data.cpu) + '%');
		setText(refs.ramMetric, Math.round(ramPercent) + '%');
		setText(refs.tempMetric, temp == null ? '—' : temp.toFixed(1) + ' °C');

		setText(refs.wanProto, wan ? (wan.getI18n() + ' / ' + (wan.getProtocol() || '')) : '—');
		setText(refs.wanIpCard, wanIp);
		setText(refs.wanGw, wan && wan.getGatewayAddr ? (wan.getGatewayAddr() || '—') : '—');
		setText(refs.wanDns, wan && wan.getDNSAddrs ? (wan.getDNSAddrs().join(', ') || 'Локальный') : 'Локальный');
		setText(refs.wanUptime, wan && wan.getUptime ? fmtDuration(wan.getUptime()) : '—');
		setText(refs.wanRx, data.wanRate ? fmtRate(data.wanRate.rx) : '—');
		setText(refs.wanTx, data.wanRate ? fmtRate(data.wanRate.tx) : '—');

		updateSpark(refs.wanSpark, data.samples.wan);

		dom.content(refs.detector, detector.length ? detector.map(function(item) {
			const cls = item.inet == 0 ? 'ok' : (item.inet == -1 ? 'warn' : 'bad');
			const text = item.inet == 0 ? 'Онлайн' : (item.inet == -1 ? 'Неизвестно' : 'Офлайн');
			return E('span', { 'class': 'koka-pill ' + cls }, [ E('i'), E('span', {}, item.instance + ': ' + text) ]);
		}) : E('span', { 'class': 'koka-empty' }, 'Internet Detector недоступен'));

		const cpu = data.cpu == null ? 0 : data.cpu;
		refs.cpuRing.style.setProperty('--p', cpu);
		setText(refs.cpuRingVal, data.cpu == null ? '—' : Math.round(cpu) + '%');

		const mem = info.memory || {};
		const memUsed = mem.total ? mem.total - (mem.available != null ? mem.available : mem.free || 0) : 0;
		const memPct = pct(memUsed, mem.total);
		refs.ram.fill.style.width = memPct + '%';
		setText(refs.ram.value, Math.round(memPct) + '%');

		const root = info.root || {};
		const rootPct = pct(root.used, root.total);
		refs.disk.fill.style.width = rootPct + '%';
		setText(refs.disk.value, Math.round(rootPct) + '%');

		const load = Array.isArray(info.load) ? info.load : [0, 0, 0];
		setText(refs.load, (load[0] / 65535).toFixed(2) + ' / ' + (load[1] / 65535).toFixed(2) + ' / ' + (load[2] / 65535).toFixed(2));
		setText(refs.temp, temp == null ? '—' : temp.toFixed(1) + ' °C');

		setText(refs.clientsCount, onlineClients + ' / ' + clients.length);
		dom.content(refs.clients, clients.length ? clients.slice(0, 7).map(function(client) {
			return E('div', { 'class': 'koka-client' }, [
				E('span', { 'class': 'koka-dot' + (client.online ? ' on' : '') }),
				E('div', { 'class': 'koka-client-main' }, [
					E('span', { 'class': 'koka-client-name' }, client.name),
					E('span', { 'class': 'koka-client-ip' }, client.ip)
				])
			]);
		}) : E('div', { 'class': 'koka-empty' }, 'Нет DHCP-аренд'));

		const ctPct = pct(data.ctCount, data.ctMax);
		setText(refs.ctVal, data.ctMax ? data.ctCount + ' / ' + data.ctMax : String(data.ctCount));
		refs.ctFill.style.width = ctPct + '%';
		setText(refs.ctHint, data.ctMax ? Math.round(ctPct) + '%' : '—');

		dom.content(refs.ports, data.ports.length ? data.ports.map(function(port) {
			const wanL2 = wan && wan.getL2Device ? wan.getL2Device() : null;
			const role = wanL2 && wanL2.getName() === port.name ? 'WAN' : (port.name === 'eth1' ? 'LAN' : '');
			return E('div', { 'class': 'koka-port' }, [
				E('span', { 'class': 'koka-dot' + (port.carrier ? ' on' : '') }),
				E('span', { 'class': 'koka-port-name' }, port.name),
				role ? E('span', { 'class': 'koka-role' }, role) : '',
				E('div', { 'class': 'koka-port-main' }, [
					E('span', { 'class': 'koka-port-speed' }, fmtSpeed(port.speed)),
					E('span', { 'class': 'koka-port-bytes' }, '↓ ' + fmtBytes(port.rx) + '  ↑ ' + fmtBytes(port.tx))
				])
			]);
		}) : E('div', { 'class': 'koka-empty' }, 'Нет Ethernet-портов'));
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});

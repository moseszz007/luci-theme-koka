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

const PROC_SCRIPT = 'awk \'FNR==1{pid=FILENAME;sub("/proc/","",pid);sub("/stat","",pid);line=$0;p=index(line,"(");q=index(line,")");comm=substr(line,p+1,q-p-1);rest=substr(line,q+2);n=split(rest,a," ");printf "%s\\t%s\\t%s\\t%s\\t%s\\n",pid,a[2],comm,a[12]+a[13],a[22]*4}\' /proc/[0-9]*/stat';

const state = {
	cpu: null,
	cpuTotal: 0,
	net: { wan: null, lan: null },
	samples: { wan: { rx: [], tx: [] }, lan: { rx: [], tx: [] } },
	zm: { prevTicks: {}, history: { cpu: [], ram: [], temp: [] } }
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

function glassPref() {
	try {
		return localStorage.getItem('koka-glass') !== 'off';
	} catch (e) {
		return true;
	}
}

function ensureAurora() {
	let aurora = document.querySelector('.koka-aurora');

	if (!aurora) {
		aurora = E('div', { 'class': 'koka-aurora', 'aria-hidden': 'true' }, [
			E('i'), E('i'), E('i')
		]);
		(document.getElementById('maincontent') || document.body).appendChild(aurora);
	}

	document.documentElement.classList.toggle('koka-glass', glassPref());
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

function cpuTotals(text) {
	const lines = (text || '').split('\n');
	const parts = lines[0].trim().split(/\s+/).slice(1).map(Number);
	let cores = 0;

	lines.forEach(function(line) {
		if (/^cpu\d+\s/.test(line))
			cores++;
	});

	return {
		total: parts.length ? parts.reduce(function(a, b) { return a + (b || 0); }, 0) : 0,
		cores: cores || 1
	};
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

/* Zapret Manager groups processes into services; keep the same idea, but with
 * the Koka palette and only the groups this router can actually run. */
const ZM_COMPS = [
	{ id: 'zapret2', name: 'Zapret2', color: '#a78bfa', rx: /\/opt\/zapret2\/|nfqws2/ },
	{ id: 'zapret', name: 'Zapret', color: '#7c9cff', rx: /\/opt\/zapret\/|(^|\/)nfqws( |$)|tpws/ },
	{ id: 'forkozz', name: 'Forkozz', color: '#60a5fa', rx: /sing-box|netshift/ },
	{ id: 'steer', name: 'Steer', color: '#38bdf8', rx: /(^|\/)steer/ },
	{ id: 'mixomo', name: 'Mixomo', color: '#2dd4bf', rx: /mihomo|magitrickle|hev-socks5-tunnel/ },
	{ id: 'bytetube', name: 'ByeTube', color: '#f87171', rx: /ciadpi|byedpi|bytetube/ },
	{ id: 'tg', name: 'TG WS Proxy', color: '#fb923c', rx: /tg-ws-proxy|(^|\/)s?tgws/ },
	{ id: 'ts', name: 'Tailscale', color: '#a3e635', rx: /(^|\/)tailscaled?( |$)/ },
	{ id: 'doh', name: 'DNS over HTTPS', color: '#22d3ee', rx: /https-dns-proxy/ },
	{ id: 'dnsproxy', name: 'DNS Proxy', color: '#2dd4bf', rx: /dnsproxy/ },
	{ id: 'zerotier', name: 'ZeroTier', color: '#84cc16', rx: /zerotier/ },
	{ id: 'awg', name: 'AmneziaWG', color: '#a78bfa', rx: /amnezia|awg|wireguard/ },
	{ id: 'dns', name: 'DNS (dnsmasq)', color: '#06b6d4', rx: /(^|\/)dnsmasq/ },
	{ id: 'term', name: 'Терминал', color: '#f59e0b', rx: /(^|\/)ttyd|(^|\/)htop/ },
	{ id: 'panel', name: 'Панель и LuCI', color: '#c084fc', rx: /uhttpd|(^|\/)rpcd|zapret-manager|backend\.sh/ },
	{ id: 'wifi', name: 'Wi-Fi', color: '#f472b6', rx: /hostapd|wpa_supplicant/ },
	{ id: 'kernel', name: 'Ядро Linux', color: '#64748b', rx: null },
	{ id: 'system', name: 'Система', color: '#94a3b8', rx: null }
];

const ZM_BY_ID = {};

ZM_COMPS.forEach(function(c) { ZM_BY_ID[c.id] = c; });

const KOKA_SERVICES = [
	{ id: 'dnsproxy', name: 'DNS Proxy', rx: /^dnsproxy$/, href: 'admin/services/dnsproxy' },
	{ id: 'dnsmasq', name: 'DNS (dnsmasq)', rx: /^dnsmasq$/, href: 'admin/network/dhcp' },
	{ id: 'zapret', name: 'Zapret', rx: /^nfqws$|^tpws$/, href: 'admin/services/zapret-manager/strategy' },
	{ id: 'steer', name: 'Steer', rx: /^steer/, href: 'admin/services/zapret-manager/steer' },
	{ id: 'zerotier', name: 'ZeroTier', rx: /^zerotier/, href: 'admin/network/network' },
	{ id: 'ssh', name: 'SSH', rx: /^dropbear$/, href: 'admin/system/admin' },
	{ id: 'luci', name: 'LuCI', rx: /^uhttpd$|^rpcd$/, href: 'admin/status/overview' }
];

function zmCompOf(name, ppid) {
	if (ppid === 2 || /^(kworker|ksoftirqd|kthreadd|migration|rcu_|irq\/|watchdog|cpuhp)/.test(name))
		return ZM_BY_ID.kernel;

	for (let i = 0; i < ZM_COMPS.length; i++) {
		if (ZM_COMPS[i].rx && ZM_COMPS[i].rx.test(name))
			return ZM_COMPS[i];
	}

	return ZM_BY_ID.system;
}

function pushHistory(list, value) {
	list.push(value == null ? null : value);

	if (list.length > 60)
		list.shift();
}

function resourceStats(procText, cpuDelta, cpu, ramPct, temp, info, ncpu, fmax) {
	const hist = state.zm.history;

	pushHistory(hist.cpu, cpu);
	pushHistory(hist.ram, ramPct);
	pushHistory(hist.temp, temp);

	const mem = info.memory || {};
	const memTotal = mem.total || 0;
	const memUsed = mem.total ? Math.max(0, mem.total - (mem.available != null ? mem.available : mem.free || 0)) : 0;

	const root = info.root || {};
	const flashTotal = (root.total || 0) * 1024;
	const flashUsed = (root.used || 0) * 1024;

	const components = {};
	const ticks = {};
	const procRows = [];
	const procByPid = {};

	(procText || '').split('\n').forEach(function(line) {
		if (!line)
			return;

		const f = line.split('\t');

		if (f.length < 5)
			return;

		const pid = f[0];
		const ppid = parseInt(f[1]) || 0;
		const name = f[2] || '?';
		const tk = parseInt(f[3]) || 0;
		const rss = parseInt(f[4]) || 0;
		const comp = zmCompOf(name, ppid);

		ticks[pid] = tk;

		if (!components[comp.id])
			components[comp.id] = { id: comp.id, name: comp.name, color: comp.color, cpu: 0, mem: 0, pids: 0 };

		components[comp.id].mem += rss * 1024;
		components[comp.id].pids++;

		const item = {
			pid: pid,
			name: name,
			comp: comp,
			mem: rss * 1024,
			cpu: 0
		};

		procRows.push(item);
		procByPid[pid] = item;
	});

	if (cpuDelta > 0) {
		Object.keys(components).forEach(function(id) {
			components[id].cpu = 0;
		});

		Object.keys(ticks).forEach(function(pid) {
			const prev = state.zm.prevTicks[pid];
			const item = procByPid[pid];

			if (prev != null && ticks[pid] > prev && item) {
				const value = (ticks[pid] - prev) / cpuDelta * 100;

				item.cpu = value;
				components[item.comp.id].cpu += value;
			}
		});
	}

	state.zm.prevTicks = ticks;

	const list = Object.keys(components).map(function(id) { return components[id]; })
		.filter(function(c) { return c.mem > 0 || c.cpu > 0.05; })
		.sort(function(a, b) { return b.mem - a.mem; });

	const top = list.slice(0, 4);
	const rest = list.slice(4);
	const other = rest.reduce(function(acc, c) {
		acc.mem += c.mem;
		acc.cpu += c.cpu;
		return acc;
	}, { id: 'other', name: 'Другое', color: '#475569', mem: 0, cpu: 0 });

	const procMem = list.reduce(function(acc, c) { return acc + c.mem; }, 0);

	const stack = list.map(function(c) {
		return { color: c.color, pct: procMem ? Math.max(c.mem / procMem * 100, 0.4) : 0 };
	});

	procRows.sort(function(a, b) {
		return b.mem - a.mem || b.cpu - a.cpu;
	});

	return {
		available: procRows.length > 0,
		memTotal: memTotal,
		memUsed: memUsed,
		procMem: procMem,
		flashTotal: flashTotal,
		flashUsed: flashUsed,
		temp: temp,
		cpu: cpu,
		ramPct: ramPct,
		ncpu: ncpu || 0,
		fmax: fmax || 0,
		components: top,
		other: other.mem > 0 || other.cpu > 0 ? other : null,
		stack: stack,
		processes: procRows,
		history: hist
	};
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
		readFile('/sys/class/thermal/thermal_zone0/temp'),
		L.resolveDefault(withTimeout(fs.exec_direct('/bin/sh', [ '-c', PROC_SCRIPT ]), 4000, ''), ''),
		readFile('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq')
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
		const procText = res[13] || '';
		const fmaxRaw = parseInt(res[14]);
		const fmax = isNaN(fmaxRaw) ? 0 : Math.round(fmaxRaw / 1000);

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

		const memInfo = info.memory || {};
		const memPctValue = memInfo.total ? pct(memInfo.total - memInfo.available, memInfo.total) : 0;
		const cpuNow = cpuTotals(cpuText);
		const cpuDelta = state.cpuTotal > 0 ? Math.max(0, cpuNow.total - state.cpuTotal) : 0;

		state.cpuTotal = cpuNow.total;

		const resources = resourceStats(procText, cpuDelta, cpu, memPctValue, temp, info, cpuNow.cores, fmax);

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
			resources: resources,
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

function updateResChart(svg, hist) {
	if (!svg || !hist)
		return;

	const W = 100, H = 34;

	const pad = function(values) {
		const clean = (values || []).slice(-60).map(function(v) {
			return v == null ? null : Math.max(0, Math.min(100, v));
		});
		let fill = 0;

		for (let i = 0; i < clean.length; i++) {
			if (clean[i] != null) {
				fill = clean[i];
				break;
			}
		}

		const out = clean.map(function(v) { return v == null ? fill : v; });

		while (out.length < 60)
			out.unshift(fill);

		return out;
	};

	const points = function(values, top) {
		return values.map(function(value, index) {
			return (index / 59 * W).toFixed(2) + ',' + (H - 1 - value / top * (H - 2)).toFixed(2);
		}).join(' ');
	};

	const cpuArr = pad(hist.cpu);
	const ramArr = pad(hist.ram);
	const top = Math.max(10, Math.ceil(Math.max.apply(null, cpuArr.concat(ramArr)) / 10) * 10);
	const cpu = points(cpuArr, top);
	const ram = points(ramArr, top);
	const area = svg.querySelector('.area');
	const cpuLine = svg.querySelector('.cpu');
	const ramLine = svg.querySelector('.ram');

	if (cpuLine)
		cpuLine.setAttribute('points', cpu);
	if (ramLine)
		ramLine.setAttribute('points', ram);
	if (area)
		area.setAttribute('d', 'M0,' + (H - 1) + ' L' + cpu.replace(/ /g, ' L') + ' L' + W + ',' + (H - 1) + ' Z');

	return top;
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
--kd-pulse:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M22 12h-4l-3 9L9 3l-3 9H2'/%3E%3C/svg%3E");
--kd-sliders:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3'/%3E%3Cpath d='M14 2v4M8 10v4M16 18v4'/%3E%3C/svg%3E");
--kd-services:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2' y='3' width='20' height='8' rx='2'/%3E%3Crect x='2' y='13' width='20' height='8' rx='2'/%3E%3Cpath d='M6 7h.01M6 17h.01'/%3E%3C/svg%3E");
}
[data-page="admin-status-overview"] h2[name="content"]{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.koka-aurora{position:fixed;inset:0;z-index:-1;display:none;overflow:hidden;pointer-events:none}
.koka-aurora::before{content:"";position:absolute;inset:0;background:linear-gradient(150deg,color-mix(in srgb,var(--koka-glow-b,#8ab4ff) 8%,transparent),transparent 45%,color-mix(in srgb,var(--koka-glow-c,#2dd4bf) 10%,transparent))}
.koka-glass .koka-aurora{display:block}
body[data-page="admin-status-koka"] .fs-main{background:transparent;position:relative;z-index:0;isolation:isolate}
body[data-page="admin-status-koka"] .fs-footer{background:transparent}
.koka-aurora i{position:absolute;width:85vmax;height:85vmax;border-radius:50%;opacity:.26;background:radial-gradient(circle at 50% 50%,var(--koka-glow-a,#7aa2ff) 0%,transparent 68%)}
.koka-aurora i:nth-child(1){top:-22%;left:-12%;animation:koka-drift-a 32s ease-in-out infinite alternate}
.koka-aurora i:nth-child(2){top:-18%;right:-16%;background:radial-gradient(circle at 50% 50%,var(--koka-glow-b,#8b5cf6) 0%,transparent 68%);animation:koka-drift-b 38s ease-in-out infinite alternate}
.koka-aurora i:nth-child(3){bottom:-22%;left:22%;background:radial-gradient(circle at 50% 50%,var(--koka-glow-c,#2dd4bf) 0%,transparent 68%);animation:koka-drift-c 44s ease-in-out infinite alternate}
@keyframes koka-drift-a{from{transform:translate3d(0,0,0) scale(1)}to{transform:translate3d(6vw,7vh,0) scale(1.12)}}
@keyframes koka-drift-b{from{transform:translate3d(0,0,0) scale(1.05)}to{transform:translate3d(-7vw,5vh,0) scale(.95)}}
@keyframes koka-drift-c{from{transform:translate3d(0,0,0) scale(.95)}to{transform:translate3d(4vw,-6vh,0) scale(1.1)}}
.koka-glass .koka-card{background:linear-gradient(160deg,color-mix(in srgb,var(--an) 60%,transparent),color-mix(in srgb,var(--an) 38%,transparent));border-color:rgba(255,255,255,.1);box-shadow:0 22px 48px rgba(2,8,23,.28),inset 0 1px 0 rgba(255,255,255,.08);-webkit-backdrop-filter:blur(18px) saturate(1.3);backdrop-filter:blur(18px) saturate(1.3)}
.koka-glass .koka-hero{background:linear-gradient(130deg,color-mix(in srgb,var(--a) 20%,transparent),color-mix(in srgb,var(--an) 50%,transparent));border-color:rgba(255,255,255,.12);-webkit-backdrop-filter:blur(20px) saturate(1.35);backdrop-filter:blur(20px) saturate(1.35)}
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
.koka-card.span12{grid-column:span 12}
button.koka-action{font:inherit;cursor:pointer}
.koka-edit-btn.active{background:color-mix(in srgb,var(--a) 18%,var(--V));border-color:color-mix(in srgb,var(--a) 45%,transparent)}
.koka-editing .koka-card{outline:1px dashed color-mix(in srgb,var(--a) 45%,transparent);outline-offset:2px}
.koka-card.koka-dragging{opacity:.5}
.koka-grip{cursor:grab;color:var(--c);font-size:.8rem;line-height:1;letter-spacing:-2px;flex:0 0 auto;user-select:none}
.koka-hide,.koka-move{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border-radius:8px;border:1px solid color-mix(in srgb,var(--S) 60%,transparent);background:color-mix(in srgb,var(--V) 60%,transparent);color:var(--c);font:inherit;font-size:.8rem;line-height:1;cursor:pointer;flex:0 0 auto}
.koka-hide:hover{border-color:#fb7185;color:#fb7185}
.koka-move:hover{border-color:var(--a);color:var(--d)}
.koka-tray{display:none}
.koka-editing .koka-tray{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 14px;border:1px dashed color-mix(in srgb,var(--a) 35%,transparent);border-radius:14px;background:color-mix(in srgb,var(--V) 40%,transparent)}
.koka-tray-label{font-size:.72rem;color:var(--c);font-weight:600}
.koka-tray-chip,.koka-tray-reset,.koka-tray-toggle{font:inherit;font-size:.72rem;padding:5px 10px;border-radius:8px;border:1px solid color-mix(in srgb,var(--S) 60%,transparent);background:color-mix(in srgb,var(--V) 60%,transparent);color:var(--d);cursor:pointer}
.koka-tray-chip span{color:var(--a);font-weight:700}
.koka-tray-reset{margin-inline-start:auto;color:var(--c)}
.koka-tray-chip:hover,.koka-tray-reset:hover{border-color:var(--a)}
.koka-card-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid color-mix(in srgb,var(--S) 45%,transparent)}
#view .koka-card-head{position:static;z-index:auto}
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
.koka-services{display:flex;flex-direction:column;gap:0;min-width:0}
.koka-service{display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid color-mix(in srgb,var(--S) 35%,transparent);text-decoration:none;color:var(--d);min-width:0;border-radius:0}
.koka-service:last-child{border-bottom:0}
.koka-service:hover{background:color-mix(in srgb,var(--a) 9%,transparent);border-radius:8px}
.koka-service-name{flex:1 1 auto;font-size:.8rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.koka-service-meta{font-size:.66rem;color:var(--c);font-variant-numeric:tabular-nums;white-space:nowrap}
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
.koka-action{display:flex;align-items:center;gap:9px;padding:10px;border-radius:12px;border:1px solid color-mix(in srgb,var(--S) 50%,transparent);background:color-mix(in srgb,var(--V) 45%,transparent);color:var(--d);text-decoration:none;font-size:.8rem;font-weight:600;min-width:0;transition:background .15s,border-color .15s,transform .15s}
.koka-action:hover{background:color-mix(in srgb,var(--a) 10%,var(--V));border-color:color-mix(in srgb,var(--a) 35%,transparent);transform:translateY(-1px)}
.koka-action .koka-ico{width:17px;height:17px;color:var(--a);flex:0 0 auto}
.koka-action span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.koka-res{display:flex;flex-direction:column;gap:14px}
.koka-gauges{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;padding:0;border:0;border-radius:0;background:none}
.koka-gauge{display:flex;align-items:center;gap:12px;padding:8px 18px;border:0;background:none;border-radius:0;min-width:0}
.koka-gauge + .koka-gauge{border-inline-start:1px solid color-mix(in srgb,var(--S) 25%,transparent)}
.koka-gauge .koka-gauge-ring{width:76px;height:76px;flex:0 0 auto;background:conic-gradient(var(--g,var(--a)) calc(var(--p)*1%),var(--E) 0)}
.koka-gauge .koka-gauge-ring::before{inset:6px}
.koka-gauge-ring .koka-ring-val b{font-size:.95rem}
.koka-gauge-ring .koka-ring-val small{display:none}
.koka-gauge-info{display:flex;flex-direction:column;gap:2px;min-width:0}
.koka-gauge-label{font-size:.6rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--c)}
.koka-gauge-sub{font-size:.66rem;color:var(--c);line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.koka-res-mid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:18px;align-items:start}
.koka-res-main{min-width:0}
.koka-res-head{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:.7rem;color:var(--c);margin-bottom:6px}
.koka-res-legend{display:inline-flex;align-items:center;gap:6px}
.koka-res-legend i{width:8px;height:8px;border-radius:3px;display:inline-block}
.koka-res-legend i.cpu{background:var(--a)}
.koka-res-legend i.ram{background:var(--O);margin-inline-start:4px}
.koka-res-scale{font-size:.62rem;color:var(--c);opacity:.75;margin-inline-start:6px;font-variant-numeric:tabular-nums}
.koka-res-chart{width:100%;height:100px;display:block;border:1px solid color-mix(in srgb,var(--S) 22%,transparent);border-radius:10px;background:color-mix(in srgb,var(--an) 20%,transparent)}
.koka-res-chart .area{fill:var(--a);opacity:.24}
.koka-res-chart .cpu{stroke:var(--a);fill:none;stroke-width:1.4;vector-effect:non-scaling-stroke}
.koka-res-chart .ram{stroke:var(--O);fill:none;stroke-width:1.4;vector-effect:non-scaling-stroke}
.koka-res-side{display:flex;flex-direction:column;gap:9px;min-width:0}
.koka-res-stack{display:flex;height:10px;border-radius:6px;overflow:hidden;background:var(--E);gap:2px}
.koka-res-stack i{display:block;height:100%;min-width:2px}
.koka-res-list{display:flex;flex-direction:column;gap:4px;min-width:0}
.koka-res-row{display:flex;align-items:center;gap:8px;font-size:.78rem;min-width:0}
.koka-res-row i{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
.koka-res-row span{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--c)}
.koka-res-row b{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.koka-res-row em{font-style:normal;font-size:.68rem;color:var(--c);min-width:3.7em;text-align:right;font-variant-numeric:tabular-nums}
.koka-res-note{font-size:.68rem;color:var(--c);min-height:1em}
.koka-proc{border-top:1px solid color-mix(in srgb,var(--S) 40%,transparent);padding-top:10px;min-width:0}
.koka-proc .koka-res-head{margin-bottom:4px}
.koka-proc-sort{display:inline-flex;gap:4px;margin-inline-start:auto;margin-inline-end:8px}
.koka-sort-btn{font:inherit;font-size:.64rem;font-weight:600;padding:3px 9px;border-radius:999px;border:1px solid color-mix(in srgb,var(--S) 50%,transparent);background:transparent;color:var(--c);cursor:pointer}
.koka-sort-btn.active{background:color-mix(in srgb,var(--a) 16%,transparent);border-color:color-mix(in srgb,var(--a) 45%,transparent);color:var(--d)}
.koka-proc-row{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) 54px 78px;gap:8px;align-items:center;padding:5px 0;border-top:1px solid color-mix(in srgb,var(--S) 30%,transparent);font-size:.74rem;min-width:0}
.koka-proc-head{border-top:0;padding:0 0 2px;font-size:.58rem;letter-spacing:.07em;text-transform:uppercase;color:var(--c)}
.koka-proc-row .r{text-align:right}
.koka-proc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--d)}
.koka-proc-comp{display:flex;align-items:center;gap:6px;min-width:0;color:var(--c);font-size:.7rem}
.koka-proc-comp i{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.koka-proc-comp span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.koka-proc-cpu,.koka-proc-mem{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.koka-proc-cpu{color:var(--c)}
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
.koka-ico-pulse{-webkit-mask-image:var(--kd-pulse);mask-image:var(--kd-pulse)}
.koka-ico-sliders{-webkit-mask-image:var(--kd-sliders);mask-image:var(--kd-sliders)}
.koka-ico-services{-webkit-mask-image:var(--kd-services);mask-image:var(--kd-services)}
@media (max-width:1100px){.koka-card.span7,.koka-card.span5{grid-column:span 6}.koka-hero-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.koka-gauges{grid-template-columns:repeat(2,minmax(0,1fr))}.koka-gauge:nth-child(3){border-inline-start:0;border-top:1px solid color-mix(in srgb,var(--S) 25%,transparent)}.koka-gauge:nth-child(4){border-top:1px solid color-mix(in srgb,var(--S) 25%,transparent)}}
@media (max-width:760px){.koka-card,.koka-card.span7,.koka-card.span5{grid-column:span 12}.koka-hero{grid-template-columns:1fr;padding:16px}.koka-hero-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.koka-grid{gap:12px}.koka-card{border-radius:14px}.koka-actions{grid-template-columns:1fr}.koka-hero-name{font-size:1.3rem}.koka-hero-actions .koka-action{flex:1 1 auto;justify-content:center}.koka-sys-top .koka-ring{width:84px;height:84px}.koka-gauges{grid-template-columns:repeat(2,minmax(0,1fr))}.koka-res-mid{grid-template-columns:1fr}.koka-res-chart{height:96px}.koka-proc-row{grid-template-columns:minmax(0,1fr) 50px 72px}.koka-proc-comp,.koka-proc-head span:nth-child(2){display:none}}
@media (prefers-reduced-motion:reduce){.koka-action,.koka-bar i{transition:none}.koka-aurora i{animation:none}}
@media (max-width:1023px),(pointer:coarse){.koka-aurora i{animation:none!important;will-change:auto!important}.koka-glass .koka-card,.koka-glass .koka-hero{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}.koka-glass .koka-card{background:color-mix(in srgb,var(--an) 92%,transparent)!important}.koka-glass .koka-hero{background:linear-gradient(130deg,color-mix(in srgb,var(--a) 22%,var(--an)),var(--an))!important}}
	`));
}

return view.extend({
	load: function() {
		return null;
	},

	render: function() {
		noBatch();
		ensureStyles();
		ensureAurora();

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

		const editBtn = E('button', {
			'class': 'koka-action koka-edit-btn',
			'type': 'button',
			'title': 'Настроить дашборд'
		}, [
			E('span', { 'class': 'koka-ico koka-ico-sliders' }),
			E('span', {}, 'Настроить')
		]);

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
			action(L.url('admin/system/reboot'), 'koka-ico-reboot', _('Reboot')),
			editBtn
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
		clients.el.classList.add('span5');
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

		const services = card('koka-ico-services', 'Сервисы');
		services.el.classList.add('span5');
		refs.services = E('div', { 'class': 'koka-services' });
		services.body.appendChild(refs.services);

		const ports = card('koka-ico-plug', 'Порты');
		ports.el.classList.add('span7');
		refs.ports = E('div', { 'class': 'koka-ports' });
		ports.body.appendChild(refs.ports);

		const quick = card('koka-ico-bolt', 'Быстрые действия');
		quick.el.classList.add('span7');
		quick.body.appendChild(E('div', { 'class': 'koka-actions' }, [
			action(L.url('admin/network/network'), 'koka-ico-net2', _('Interfaces')),
			action(L.url('admin/network/dhcp'), 'koka-ico-dhcp', _('DHCP')),
			action(L.url('admin/network/firewall'), 'koka-ico-shield', _('Firewall')),
			action(L.url('admin/services/dnsproxy'), 'koka-ico-dns', _('DNS Proxy')),
			action(L.url('admin/services/internet-detector'), 'koka-ico-net', _('Internet Detector')),
			action(L.url('admin/system/reboot'), 'koka-ico-reboot', _('Reboot'))
		]));

		/* Resource monitor built from /proc, no Zapret Manager dependency. */
		const res = card('koka-ico-pulse', 'Ресурсы');
		res.el.classList.add('span12');

		function gauge(label) {
			const ring = E('div', { 'class': 'koka-ring koka-gauge-ring' }, [
				E('div', { 'class': 'koka-ring-val' }, [
					E('b', {}, '—'),
					E('small', {}, '')
				])
			]);
			const sub = E('span', { 'class': 'koka-gauge-sub' }, '—');
			const el = E('div', { 'class': 'koka-gauge' }, [
				ring,
				E('div', { 'class': 'koka-gauge-info' }, [
					E('span', { 'class': 'koka-gauge-label' }, label),
					sub
				])
			]);

			return { el: el, ring: ring, value: ring.querySelector('b'), sub: sub };
		}

		const gCpu = gauge('Процессор');
		const gTemp = gauge('Температура');
		const gRam = gauge('Память');
		const gFlash = gauge('Флеш');
		const gauges = E('div', { 'class': 'koka-gauges' }, [ gCpu.el, gTemp.el, gRam.el, gFlash.el ]);

		const resChart = E('<svg class="koka-res-chart" viewBox="0 0 100 34" preserveAspectRatio="none">'
			+ '<path class="area" d=""></path>'
			+ '<polyline class="cpu" points=""></polyline>'
			+ '<polyline class="ram" points=""></polyline>'
			+ '</svg>');

		const resStack = E('div', { 'class': 'koka-res-stack' });
		const resList = E('div', { 'class': 'koka-res-list' });
		const resNote = E('div', { 'class': 'koka-res-note' }, '—');

		const procSort = E('div', { 'class': 'koka-proc-sort' });
		const procBody = E('div', { 'class': 'koka-proc-body' });
		const procMore = E('button', {
			'type': 'button',
			'class': 'koka-sort-btn',
			'click': function() {
				refs.procExpanded = !refs.procExpanded;
				procMore.textContent = refs.procExpanded ? 'Свернуть' : 'Ещё';
				if (refs.procData)
					renderProcs(refs.procData);
			}
		}, 'Ещё');

		function renderProcSort() {
			procSort.innerHTML = '';

			[ [ 'mem', 'Память' ], [ 'cpu', 'CPU' ] ].forEach(function(pair) {
				procSort.appendChild(E('button', {
					'type': 'button',
					'class': 'koka-sort-btn' + (refs.procSortBy === pair[0] ? ' active' : ''),
					'click': function() {
						refs.procSortBy = pair[0];
						renderProcSort();
						if (refs.procData)
							renderProcs(refs.procData);
					}
				}, pair[1]));
			});
		}

		function renderProcs(resData) {
			refs.procData = resData;

			const all = (resData.processes || []).filter(function(p) {
				return p.mem > 0;
			}).sort(function(a, b) {
				if (refs.procSortBy === 'cpu')
					return b.cpu - a.cpu || b.mem - a.mem;
				return b.mem - a.mem || b.cpu - a.cpu;
			});

			const list = all.slice(0, refs.procExpanded ? 24 : 8);

			procMore.style.display = all.length > 8 ? '' : 'none';
			if (!refs.procExpanded)
				procMore.textContent = 'Ещё';

			dom.content(procBody, list.length ? list.map(function(p) {
				return E('div', { 'class': 'koka-proc-row', 'title': p.cmd || p.name }, [
					E('span', { 'class': 'koka-proc-name' }, p.name),
					E('span', { 'class': 'koka-proc-comp' }, [
						E('i', { 'style': 'background:' + p.comp.color }),
						E('span', {}, p.comp.name)
					]),
					E('span', { 'class': 'koka-proc-cpu' }, p.cpu > 0.05 ? p.cpu.toFixed(1) + '%' : ''),
					E('span', { 'class': 'koka-proc-mem' }, fmtBytes(p.mem))
				]);
			}) : E('div', { 'class': 'koka-empty' }, 'Нет данных по процессам'));
		}

		refs.procSortBy = 'mem';
		refs.procExpanded = false;
		renderProcSort();

		const procBlock = E('div', { 'class': 'koka-proc' }, [
			E('div', { 'class': 'koka-res-head' }, [
				E('span', {}, 'Процессы'),
				procSort,
				procMore
			]),
			E('div', { 'class': 'koka-proc-row koka-proc-head' }, [
				E('span', {}, 'Процесс'),
				E('span', {}, 'Сервис'),
				E('span', { 'class': 'r' }, 'CPU'),
				E('span', { 'class': 'r' }, 'Память')
			]),
			procBody
		]);

		res.body.appendChild(E('div', { 'class': 'koka-res' }, [
			gauges,
			E('div', { 'class': 'koka-res-mid' }, [
				E('div', { 'class': 'koka-res-main' }, [
					E('div', { 'class': 'koka-res-head' }, [
						E('span', {}, 'Последние 5 минут'),
						E('span', { 'class': 'koka-res-legend' }, [
							E('i', { 'class': 'cpu' }), 'CPU',
							E('i', { 'class': 'ram' }), 'ОЗУ',
							E('span', { 'class': 'koka-res-scale' }, '0–100%')
						])
					]),
					resChart
				]),
				E('div', { 'class': 'koka-res-side' }, [
					resStack,
					resList,
					resNote
				])
			]),
			procBlock
		]));

		refs.resChart = resChart;
		refs.resCpuLine = resChart.querySelector('.cpu');
		refs.resRamLine = resChart.querySelector('.ram');
		refs.resScale = res.body.querySelector('.koka-res-scale');
		refs.gCpu = gCpu;
		refs.gTemp = gTemp;
		refs.gRam = gRam;
		refs.gFlash = gFlash;
		refs.resStack = resStack;
		refs.resList = resList;
		refs.resNote = resNote;
		refs.renderProcs = renderProcs;

		const cardEls = {
			internet: internet.el,
			system: system.el,
			clients: clients.el,
			services: services.el,
			ports: ports.el,
			quick: quick.el,
			resources: res.el
		};

		const CARD_TITLES = {
			internet: 'Интернет',
			system: 'Система',
			clients: 'Клиенты',
			services: 'Сервисы',
			ports: 'Порты',
			quick: 'Быстрые действия',
			resources: 'Ресурсы'
		};

		const LAYOUT_KEY = 'koka-dashboard-layout-v3';
		const DEFAULT_ORDER = [ 'internet', 'clients', 'ports', 'system', 'quick', 'services', 'resources' ];
		let layout = loadLayout();
		let editing = false;
		let dragId = null;

		Object.keys(cardEls).forEach(function(id) {
			cardEls[id].setAttribute('data-card', id);
		});

		function loadLayout() {
			try {
				const raw = localStorage.getItem(LAYOUT_KEY);

				if (raw) {
					const saved = JSON.parse(raw);

					if (saved && Array.isArray(saved.order))
						return {
							order: saved.order.filter(function(id) { return !!cardEls[id]; }),
							hidden: (saved.hidden || []).filter(function(id) { return !!cardEls[id]; })
						};
				}
			} catch (e) {}

			return { order: DEFAULT_ORDER.slice(), hidden: [] };
		}

		function saveLayout() {
			try {
				localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
			} catch (e) {}
		}

		function applyLayout() {
			const order = layout.order.filter(function(id) { return !!cardEls[id]; });

			DEFAULT_ORDER.forEach(function(id) {
				if (order.indexOf(id) < 0)
					order.push(id);
			});

			layout.order = order;

			order.forEach(function(id) {
				grid.appendChild(cardEls[id]);
				cardEls[id].style.display = layout.hidden.indexOf(id) >= 0 ? 'none' : '';
			});
		}

		function hideCard(id) {
			if (layout.hidden.indexOf(id) < 0)
				layout.hidden.push(id);

			applyLayout();
			saveLayout();
			renderTray();
		}

		function moveCard(id, delta) {
			const order = layout.order.slice();
			const from = order.indexOf(id);
			const to = from + delta;

			if (from < 0 || to < 0 || to >= order.length)
				return;

			order.splice(from, 1);
			order.splice(to, 0, id);
			layout.order = order;
			applyLayout();
			saveLayout();
		}

		function renderTray() {
			while (tray.firstChild)
				tray.removeChild(tray.firstChild);

			if (!editing)
				return;

			const hidden = layout.hidden.filter(function(id) { return !!cardEls[id]; });

			tray.appendChild(E('span', { 'class': 'koka-tray-label' }, hidden.length ? 'Скрытые плашки:' : 'Все плашки на месте'));

			hidden.forEach(function(id) {
				tray.appendChild(E('button', {
					'class': 'koka-tray-chip',
					'type': 'button',
					'click': function() {
						layout.hidden = layout.hidden.filter(function(x) { return x !== id; });
						applyLayout();
						saveLayout();
						renderTray();
					}
				}, [ CARD_TITLES[id] || id, E('span', {}, ' +') ]));
			});

			tray.appendChild(E('button', {
				'class': 'koka-tray-toggle',
				'type': 'button',
				'click': function() {
					const on = !document.documentElement.classList.contains('koka-glass');

					document.documentElement.classList.toggle('koka-glass', on);

					try {
						localStorage.setItem('koka-glass', on ? 'on' : 'off');
					} catch (e) {}

					renderTray();
				}
			}, 'Стекло: ' + (document.documentElement.classList.contains('koka-glass') ? 'вкл' : 'выкл')));

			tray.appendChild(E('button', {
				'class': 'koka-tray-reset',
				'type': 'button',
				'click': function() {
					try {
						localStorage.removeItem(LAYOUT_KEY);
					} catch (e) {}

					layout = { order: DEFAULT_ORDER.slice(), hidden: [] };
					applyLayout();
					renderTray();
				}
			}, 'Сбросить'));
		}

		function toggleEdit() {
			editing = !editing;
			dash.classList.toggle('koka-editing', editing);
			editBtn.classList.toggle('active', editing);
			editBtn.lastElementChild.textContent = editing ? 'Готово' : 'Настроить';

			Object.keys(cardEls).forEach(function(id) {
				const card = cardEls[id];
				const head = card.firstElementChild;
				let grip = head.querySelector('.koka-grip');
				let left = head.querySelector('.koka-move-l');
				let right = head.querySelector('.koka-move-r');
				let hide = head.querySelector('.koka-hide');

				if (editing) {
					card.setAttribute('draggable', 'true');

					if (!grip) {
						grip = E('span', { 'class': 'koka-grip', 'title': 'Перетащить', 'aria-hidden': 'true' }, '⋮⋮');
						head.insertBefore(grip, head.firstChild);
					}

					if (!left) {
						left = E('button', {
							'class': 'koka-move koka-move-l',
							'type': 'button',
							'title': 'Влево',
							'aria-label': 'Влево',
							'click': function() { moveCard(id, -1); }
						}, '‹');
						head.appendChild(left);
					}

					if (!right) {
						right = E('button', {
							'class': 'koka-move koka-move-r',
							'type': 'button',
							'title': 'Вправо',
							'aria-label': 'Вправо',
							'click': function() { moveCard(id, 1); }
						}, '›');
						head.appendChild(right);
					}

					if (!hide) {
						hide = E('button', {
							'class': 'koka-hide',
							'type': 'button',
							'title': 'Скрыть',
							'aria-label': 'Скрыть',
							'click': function() { hideCard(id); }
						}, '×');
						head.appendChild(hide);
					}
				}
				else {
					card.removeAttribute('draggable');
					[ grip, left, right, hide ].forEach(function(node) {
						if (node && node.parentNode)
							node.parentNode.removeChild(node);
					});
				}
			});

			renderTray();
		}

		const tray = E('div', { 'class': 'koka-tray' });
		const grid = E('div', { 'class': 'koka-grid' }, DEFAULT_ORDER.map(function(id) { return cardEls[id]; }));
		const dash = E('div', { 'class': 'koka-dash' }, [ hero, grid, tray ]);

		Object.keys(cardEls).forEach(function(id) {
			const card = cardEls[id];

			card.addEventListener('dragstart', function(ev) {
				if (!editing) {
					ev.preventDefault();
					return;
				}

				dragId = id;
				ev.dataTransfer.effectAllowed = 'move';

				try {
					ev.dataTransfer.setData('text/plain', id);
				} catch (e) {}

				card.classList.add('koka-dragging');
			});

			card.addEventListener('dragend', function() {
				card.classList.remove('koka-dragging');

				if (!dragId)
					return;

				dragId = null;
				layout.order = Array.prototype.map.call(grid.children, function(node) {
					return node.getAttribute('data-card');
				}).filter(Boolean);
				saveLayout();
			});

			card.addEventListener('dragover', function(ev) {
				if (!editing || !dragId || dragId === id)
					return;

				ev.preventDefault();

				const dragEl = cardEls[dragId];

				if (!dragEl)
					return;

				const rect = card.getBoundingClientRect();
				const before = (ev.clientY - rect.top) < rect.height / 2;

				grid.insertBefore(dragEl, before ? card : card.nextSibling);
			});
		});

		editBtn.addEventListener('click', toggleEdit);
		applyLayout();

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
		const glow = status === 'ok' ? '#34d399' : (status === 'warn' ? '#f59e0b' : '#fb7185');
		const accent = getComputedStyle(document.documentElement).getPropertyValue('--a').trim() || '#8ab4ff';

		document.body.style.setProperty('--koka-glow-a', glow);
		document.body.style.setProperty('--koka-glow-b', accent);
		document.body.style.setProperty('--koka-glow-c', '#2dd4bf');

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

		const resData = data.resources || {};
		const resHist = resData.history || { cpu: [], ram: [], temp: [] };

		const resTop = updateResChart(refs.resChart, resHist);

		setText(refs.resScale, '0–' + resTop + '%');

		const setGauge = function(g, value, text, color, sub) {
			if (!g)
				return;

			g.ring.style.setProperty('--p', Math.max(0, Math.min(100, value || 0)));
			g.ring.style.setProperty('--g', color);
			g.value.textContent = text;
			g.sub.textContent = sub;
		};

		const loadAvg = Array.isArray(info.load) ? info.load : [0, 0, 0];
		const loadText = (loadAvg[0] / 65535).toFixed(2) + ' / ' + (loadAvg[1] / 65535).toFixed(2) + ' / ' + (loadAvg[2] / 65535).toFixed(2);
		const cpuPct = data.cpu == null ? 0 : data.cpu;
		const cpuSub = [
			resData.ncpu ? resData.ncpu + ' ядра' : '',
			resData.fmax ? (resData.fmax / 1000).toFixed(1) + ' ГГц' : '',
			'нагрузка ' + loadText
		].filter(Boolean).join(' · ');

		setGauge(refs.gCpu, cpuPct, Math.round(cpuPct) + '%', cpuPct >= 90 ? '#fb7185' : 'var(--a)', cpuSub);
		setGauge(refs.gTemp, resData.temp || 0,
			resData.temp == null ? '—' : resData.temp.toFixed(1) + '°',
			resData.temp >= 80 ? '#fb7185' : '#fbbf24',
			resData.temp >= 85 ? 'выше нормы, проверьте охлаждение' : 'в норме до 85 °C');

		const ramValue = pct(resData.memUsed, resData.memTotal);
		setGauge(refs.gRam, ramValue, Math.round(ramValue) + '%', '#34d399',
			fmtBytes(resData.memUsed) + ' из ' + fmtBytes(resData.memTotal));

		const flashValue = pct(resData.flashUsed, resData.flashTotal);
		setGauge(refs.gFlash, flashValue, Math.round(flashValue) + '%', '#a78bfa',
			fmtBytes(resData.flashUsed) + ' из ' + fmtBytes(resData.flashTotal));

		dom.content(refs.resStack, resData.stack && resData.stack.length ? resData.stack.map(function(c) {
			return E('i', { 'style': 'width:' + c.pct.toFixed(2) + '%;background:' + c.color });
		}) : E('i', { 'style': 'width:100%;background:var(--E)' }));

		const resRows = (resData.components || []).slice();

		if (resData.other)
			resRows.push(resData.other);

		dom.content(refs.resList, resRows.length ? resRows.map(function(c) {
			return E('div', { 'class': 'koka-res-row' }, [
				E('i', { 'style': 'background:' + c.color }),
				E('span', {}, c.name),
				E('b', {}, c.mem ? fmtBytes(c.mem) : '—'),
				E('em', {}, c.cpu > 0.05 ? c.cpu.toFixed(1) + '%' : '')
			]);
		}) : E('div', { 'class': 'koka-empty' }, 'Нет данных по процессам'));

		refs.renderProcs(resData);

		setText(refs.resNote, resData.available
			? 'Память по сервисам · ' + fmtBytes(resData.procMem) + ' · обновление каждые 5 с'
			: 'Нет данных по процессам');

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

		const procs = (data.resources && data.resources.processes) || [];

		dom.content(refs.services, procs.length ? KOKA_SERVICES.map(function(s) {
			const matches = procs.filter(function(p) { return s.rx.test(p.name); });
			const pid = matches.length ? matches[0].pid : null;

			return E('a', {
				'class': 'koka-service',
				'href': L.url(s.href),
				'title': s.name
			}, [
				E('span', { 'class': 'koka-dot' + (pid ? ' on' : '') }),
				E('span', { 'class': 'koka-service-name' }, s.name),
				E('span', { 'class': 'koka-service-meta' }, pid
					? (matches.length > 1 ? matches.length + ' проц.' : 'PID ' + pid)
					: 'остановлен')
			]);
		}) : E('div', { 'class': 'koka-empty' }, 'Нет данных по процессам'));

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

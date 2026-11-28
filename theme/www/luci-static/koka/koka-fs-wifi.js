/* Блок Wi-Fi на дашборде Koka.
 *
 * Данные: ubus network.wireless status + iwinfo (SSID, канал, диапазон,
 * клиенты). Быстрые действия: включить/выключить радио, перезапустить Wi-Fi.
 * Подключается как обычный скрипт (как koka-icon-bust.js) и работает только
 * на странице дашборда. */
(function () {
	'use strict';

	var UBUS = '/bin/ubus';
	var IWINFO = '/usr/bin/iwinfo';
	var UCI = '/sbin/uci';
	var WIFI = '/sbin/wifi';
	var PING = '/bin/ping';
	var IP = '/sbin/ip';
	var ZT = '/usr/bin/zerotier-cli';

	var mods = {};

	function need(name) {
		mods[name] = mods[name] || L.require(name);
		return mods[name];
	}

	function run(cmd, args) {
		return need('fs').then(function (fs) {
			return fs.exec(cmd, args || []);
		}).catch(function () {
			return { code: -1, stdout: '', stderr: '' };
		});
	}

	function notify(msg) {
		need('ui').then(function (ui) {
			ui.addNotification(null, E('p', {}, msg), 'info');
		});
	}

	function radios() {
		return run(UBUS, [ 'call', 'network.wireless', 'status' ]).then(function (res) {
			var data;

			try {
				data = JSON.parse(res.stdout || '{}');
			}
			catch (e) {
				return [];
			}

			var list = [];

			Object.keys(data).forEach(function (name) {
				var r = data[name] || {};
				var cfg = r.config || {};

				list.push({
					name: name,
					band: cfg.band || '',
					channel: cfg.channel || '',
					up: r.up !== false,
					ifaces: (r.interfaces || []).filter(function (i) { return i.ifname; })
				});
			});

			return Promise.all(list.map(function (r) {
				return Promise.all(r.ifaces.map(function (i) {
					return Promise.all([
						run(IWINFO, [ i.ifname, 'info' ]),
						run(IWINFO, [ i.ifname, 'assoclist' ])
					]).then(function (out) {
						var info = out[0].stdout || '';

						i.ssid = (info.match(/ESSID:\s*"([^"]*)"/) || [])[1] || i.ifname;
						i.channel = (info.match(/Channel:\s*(\d+)/) || [])[1] || '';
						i.clients = (out[1].stdout || '').split('\n').filter(function (l) {
							return l.trim() !== '';
						}).length;
					});
				})).then(function () { return r; });
			}));
		});
	}

	function setRadio(name, enable) {
		return run(UCI, [ 'set', 'wireless.' + name + '.disabled=' + (enable ? '0' : '1') ])
			.then(function () { return run(UCI, [ 'commit', 'wireless' ]); })
			.then(function () { return run(WIFI, [ 'reload' ]); });
	}

	function internetCard() {
		var cards = [].slice.call(document.querySelectorAll('.koka-card'));

		for (var i = 0; i < cards.length; i++) {
			var title = cards[i].querySelector('.koka-card-title');

			if (title && title.textContent.trim() === 'Интернет')
				return cards[i];
		}

		return null;
	}

	function netPill(text, kind) {
		return E('span', { class: 'koka-net-pill ' + (kind || '') }, text);
	}

	function pingLatency(host) {
		return run(PING, [ '-c', '1', '-W', '2', host ]).then(function (res) {
			var out = (res.stdout || '') + (res.stderr || '');
			var m = out.match(/time[=<]\s*([0-9.]+)\s*ms/i);

			return { ok: res.code === 0, ms: m ? parseFloat(m[1]) : null };
		});
	}

	function parseInstances(text) {
		var list = [];
		var cur = null;

		(text || '').split('\n').forEach(function (line) {
			var sec = line.match(/^config\s+instance(?:\s+'([^']*)')?\s*$/);
			var opt = line.match(/^\s*(?:option|list)\s+(\w+)\s+(?:'([^']*)'(?:\s+'([^']*)')*|"([^"]*)"|(\S+))\s*$/);

			if (sec) {
				cur = { _id: sec[1] || ('instance' + list.length), _hosts: [] };
				list.push(cur);
				return;
			}

			if (!opt || !cur)
				return;

			if (opt[1] === 'hosts') {
				var hosts = line.match(/'([^']+)'/g) || [];

				cur._hosts = cur._hosts.concat(hosts.map(function (h) {
					return h.replace(/'/g, '');
				}));
			}
			else if (opt[1] === 'urls') {
				var urls = line.match(/'([^']+)'/g) || [];

				cur._hosts = cur._hosts.concat(urls.map(function (u) {
					return u.replace(/'/g, '');
				}));
			}
			else {
				cur[opt[1]] = opt[2] != null ? opt[2] : (opt[3] != null ? opt[3] : (opt[4] != null ? opt[4] : opt[5]));
			}
		});

		return list.filter(function (i) { return i.enabled !== '0'; });
	}

	function detectorInstances() {
		return Promise.all([
			need('fs').then(function (fs) { return fs.read('/etc/config/internet-detector'); }),
			need('rpc').then(function (rpc) {
				var call = rpc.declare({ object: 'luci.internet-detector', method: 'InetStatus', expect: { '': {} } });
				return call().catch(function () { return { instances: [] }; });
			})
		]).then(function (res) {
			var cfg = parseInstances(res[0]);
			var status = {};

			((res[1] && res[1].instances) || []).forEach(function (i) {
				status[i.instance] = i.inet;
			});

			cfg.forEach(function (inst) { inst._inet = status[inst._id]; });

			return cfg.length ? cfg : Object.keys(status).map(function (name) {
				return { _id: name, name: name, _inet: status[name], _hosts: [] };
			});
		}).catch(function () { return []; });
	}

	function typeOf(inst) {
		var text = (inst.type || '') + ' ' + (inst.description || '') + ' ' + inst._id;

		if (inst.type && /^(internet|vpn|dns|wifi)$/.test(inst.type))
			return inst.type;
		if (/vpn|впн|wireguard|amnezia|zerotier/i.test(text))
			return 'vpn';
		if (/dns/i.test(text))
			return 'dns';
		if (/wifi|wi-fi|вайфай/i.test(text))
			return 'wifi';

		return 'internet';
	}

	function linkStates() {
		return run(IP, [ '-o', 'link', 'show' ]).then(function (res) {
			return res.stdout || '';
		});
	}

	function refreshInternet(box) {
		Promise.all([ detectorInstances(), linkStates() ]).then(function (res) {
			var list = res[0];
			var links = res[1];
			var icons = { internet: 'koka-ico-net', vpn: 'koka-ico-shield', dns: 'koka-ico-dns', wifi: 'koka-ico-link' };

			if (!list.length) {
				box.textContent = 'Экземпляры не заданы (Службы → Internet Detector → Экземпляры)';
				return;
			}

			return Promise.all(list.map(function (inst) {
				var type = typeOf(inst);
				var name = inst.description || inst.name || inst._id;
				var host = (inst._hosts && inst._hosts[0]) || '1.1.1.1';
				var ping = type === 'internet' ? pingLatency(host) : Promise.resolve(null);

				return ping.then(function (r) {
					var pill;
					var note = '';

					if (type === 'vpn') {
						var iface = inst.iface || inst._id;
						var up = new RegExp(':\\s+' + iface + ':.*\\bUP\\b').test(links);

						pill = netPill(up ? 'поднят' : 'лежит', up ? 'good' : 'bad');
						note = iface;
					}
					else if (r) {
						pill = netPill(r.ok ? 'онлайн' : 'офлайн', r.ok ? 'good' : 'bad');
						note = host + (r.ms != null ? ' · ' + Math.round(r.ms) + ' мс' : '');
					}
					else {
						var online = inst._inet == 0;

						pill = netPill(online ? 'онлайн' : 'офлайн', online ? 'good' : 'bad');
					}

					if (!note && inst.interval_up)
						note = 'каждые ' + inst.interval_up + ' с';

					return E('div', { class: 'koka-det' }, [
						E('div', { class: 'koka-det-main' },
							[ E('span', { class: 'koka-ico ' + (icons[type] || 'koka-ico-net') }),
							  E('span', { class: 'koka-det-name' }, name) ].concat(pill ? [ pill ] : [])),
						note ? E('div', { class: 'koka-det-params' }, note) : ''
					]);
				});
			})).then(function (rows) {
				box.replaceChildren.apply(box, rows);
			});
		});
	}

	function portsCard() {
		var cards = [].slice.call(document.querySelectorAll('.koka-card'));

		for (var i = 0; i < cards.length; i++) {
			var title = cards[i].querySelector('.koka-card-title');

			if (title && title.textContent.trim() === 'Порты')
				return cards[i];
		}

		return null;
	}

	function portLabels() {
		return run(UBUS, [ 'call', 'network.interface', 'dump' ]).then(function (res) {
			var dump;

			try {
				dump = JSON.parse(res.stdout || '{}');
			}
			catch (e) {
				dump = {};
			}

			var wanDev = null;
			var lanDev = null;

			((dump.interface) || []).forEach(function (i) {
				var dev = i.l3_device || i.device;

				if (!dev)
					return;

				if (i.interface === 'wan')
					wanDev = dev;
				else if (i.interface === 'lan')
					lanDev = dev;
			});

			return { wan: wanDev, lan: lanDev };
		}).catch(function () {
			return { wan: null, lan: null };
		});
	}

	function decoratePorts() {
		var card = portsCard();

		if (!card || card.__kokaPorts)
			return false;

		card.__kokaPorts = true;

		function apply() {
			portLabels().then(function (map) {
				[].slice.call(card.querySelectorAll('.koka-port')).forEach(function (row) {
					var nameEl = row.querySelector('.koka-port-name');

					if (!nameEl)
						return;

					if (row.querySelector('.koka-ico-rj45')) {
						if (nameEl.textContent.trim() === (map.wan ? 'wan' : 'br-lan'))
							return;
					}

					var dev = nameEl.getAttribute('data-dev') || nameEl.textContent.trim();
					var isWan = (map.wan && dev === map.wan) || (!map.wan && /^eth1$/.test(dev));
					var label = isWan ? 'wan' : 'br-lan';

					nameEl.setAttribute('data-dev', dev);
					nameEl.textContent = label;

					if (!row.querySelector('.koka-ico-rj45'))
						row.insertBefore(E('span', { class: 'koka-ico koka-ico-rj45' + (isWan ? ' wan' : ''), title: dev }), nameEl);

					if (!row.querySelector('.koka-role'))
						row.insertBefore(E('span', { class: 'koka-role' }, isWan ? 'WAN' : 'LAN'), nameEl.nextSibling);
				});
			});
		}

		apply();

		new MutationObserver(apply).observe(card, { childList: true, subtree: true });

		return true;
	}

	function cleanPills(card) {
		/* Пилюли детектора вида «internet: Онлайн» больше не нужны: их
		 * заменяет наш блок с иконками и параметрами. */
		[].slice.call(card.querySelectorAll('.koka-pill')).forEach(function (pill) {
			if (/^[^:]+:\s*(Онлайн|Офлайн|Неизвестно)$/.test(pill.textContent.trim()))
				pill.remove();
		});
	}

	function injectInternet() {
		var card = internetCard();

		if (!card)
			return false;

		cleanPills(card);

		if (!card.__kokaPillObserver) {
			card.__kokaPillObserver = new MutationObserver(function () {
				cleanPills(card);
			});

			card.__kokaPillObserver.observe(card, { childList: true, subtree: true });
		}

		if (card.querySelector('.koka-net-extra'))
			return true;

		var box = E('div', { class: 'koka-net-extra' });
		var host = card.querySelector('.koka-card-body') || card;

		host.appendChild(box);
		refreshInternet(box);
		window.setInterval(function () { refreshInternet(box); }, 15000);

		return true;
	}

	function boot() {
		if (document.body.getAttribute('data-page') !== 'admin-status-koka')
			return;

		var box = E('div', { class: 'koka-wifi-box' }, E('div', { class: 'koka-empty' }, 'Читаю Wi-Fi…'));

		var card = E('section', { class: 'koka-card koka-wifi-card' }, [
			E('header', { class: 'koka-card-head' }, [
				E('span', { class: 'koka-card-ico koka-ico koka-ico-link' }),
				E('span', { class: 'koka-card-title' }, 'Wi-Fi')
			]),
			E('div', { class: 'koka-card-body' }, [ box ])
		]);

		function host() {
			return document.querySelector('.koka-dash') || document.querySelector('#view .cbi-map');
		}

		function attach() {
			var h = host();

			if (h && !h.querySelector('.koka-wifi-card')) {
				h.appendChild(card);
				return true;
			}

			return false;
		}

		function refresh() {
			radios().then(function (list) {
				if (!list.length) {
					box.textContent = 'Wi-Fi выключен';
					return;
				}

				var rows = [];

				list.forEach(function (r) {
					var label = (r.band === '2g' ? '2.4 ГГц' : (r.band === '5g' ? '5 ГГц' : r.name)) +
						(r.channel ? ' · кан. ' + r.channel : '');

					var ssid = r.ifaces.map(function (i) {
						return (i.ssid || i.ifname) + (i.clients ? ' · ' + i.clients + ' кл.' : '');
					}).join(', ') || '—';

					var toggle = E('button', {
						class: 'koka-wifi-toggle' + (r.up ? ' on' : ''),
						type: 'button',
						title: r.up ? 'Выключить радио' : 'Включить радио'
					}, r.up ? 'вкл' : 'выкл');

					toggle.addEventListener('click', function () {
						toggle.disabled = true;
						setRadio(r.name, !r.up).then(function () {
							notify('Wi-Fi: ' + (r.up ? 'выключаю' : 'включаю') + ' ' + label);
							setTimeout(refresh, 1500);
						}).catch(function () {
							toggle.disabled = false;
						});
					});

					rows.push(E('div', { class: 'koka-wifi-row' }, [
						E('span', { class: 'koka-dot' + (r.up ? ' on' : '') }),
						E('span', { class: 'koka-wifi-band' }, label),
						E('span', { class: 'koka-wifi-ssid' }, ssid),
						toggle
					]));
				});

				rows.push(E('div', { class: 'koka-wifi-actions' }, [
					E('button', {
						class: 'koka-action',
						type: 'button',
						click: function () {
							run(WIFI, [ 'reload' ]).then(function () {
								notify('Wi-Fi: применяю настройки');
								setTimeout(refresh, 1500);
							});
						}
					}, [ E('span', { class: 'koka-ico koka-ico-refresh' }), E('span', {}, 'Перезапустить Wi-Fi') ])
				]));

				box.replaceChildren.apply(box, rows);
			});
		}

		var tries = 0;
		var timer = window.setInterval(function () {
			var attached = attach();
			var injected = injectInternet();
			var ports = decoratePorts();

			if ((attached && injected && ports) || ++tries > 60) {
				window.clearInterval(timer);
				refresh();
			}
		}, 250);
	}

	if (document.readyState === 'loading')
		document.addEventListener('DOMContentLoaded', boot);
	else
		boot();
})();

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

	function pingLatency() {
		return run(PING, [ '-c', '1', '-W', '2', '1.1.1.1' ]).then(function (res) {
			var out = (res.stdout || '') + (res.stderr || '');
			var m = out.match(/time[=<]\s*([0-9.]+)\s*ms/i);

			return { ok: res.code === 0, ms: m ? parseFloat(m[1]) : null };
		});
	}

	function vpnState() {
		return Promise.all([
			run(UCI, [ '-q', 'show', 'network' ]),
			run(IP, [ '-o', 'link', 'show' ]),
			run(ZT, [ '-j', 'info' ])
		]).then(function (res) {
			var uci = res[0].stdout || '';
			var links = res[1].stdout || '';
			var list = [];

			uci.split('\n').forEach(function (line) {
				var m = line.match(/^network\.([^.=]+)\.proto='(wireguard|amneziawg)'$/);

				if (m && list.indexOf(m[1]) < 0)
					list.push(m[1]);
			});

			var out = list.map(function (name) {
				return {
					name: name,
					up: new RegExp(':\\s+' + name + ':.*\\bUP\\b').test(links)
				};
			});

			if (res[2].code === 0) {
				try {
					var zt = JSON.parse(res[2].stdout || '{}');

					out.push({
						name: 'ZeroTier',
						up: !!zt.online,
						zt: true
					});
				}
				catch (e) {}
			}

			return out;
		});
	}

	function refreshInternet(box) {
		Promise.all([ pingLatency(), vpnState() ]).then(function (res) {
			var ping = res[0];
			var vpn = res[1];

			var rows = [
				E('div', { class: 'koka-row' }, [
					E('span', { class: 'koka-label' }, [
						E('span', { class: 'koka-ico koka-ico-net' }),
						' Интернет'
					]),
					E('span', { class: 'koka-net-val' }, [
						netPill(ping.ok ? 'есть' : 'нет', ping.ok ? 'good' : 'bad'),
						ping.ms != null ? E('b', {}, Math.round(ping.ms) + ' мс') : ''
					])
				])
			];

			if (vpn.length) {
				rows.push(E('div', { class: 'koka-row' }, [
					E('span', { class: 'koka-label' }, [
						E('span', { class: 'koka-ico koka-ico-shield' }),
						' VPN'
					]),
					E('span', { class: 'koka-vpns' }, vpn.map(function (v) {
						return E('span', {
							class: 'koka-vpn' + (v.up ? ' on' : ''),
							title: v.up ? 'поднят' : 'лежит'
						}, v.name);
					}))
				]));
			}

			box.replaceChildren.apply(box, rows);
		});
	}

	function injectInternet() {
		var card = internetCard();

		if (!card || card.querySelector('.koka-net-extra'))
			return !!card;

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

			if ((attached && injected) || ++tries > 60) {
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

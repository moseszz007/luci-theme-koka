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
			if (attach() || ++tries > 60) {
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

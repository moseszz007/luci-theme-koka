'use strict';
'require baseclass';
'require fs';
'require ui';

/* Блок Wi-Fi на дашборде Koka.
 *
 * Данные: ubus network.wireless status + iwinfo (SSID, канал, диапазон,
 * клиенты). Быстрые действия: включить/выключить радио и перезапустить Wi-Fi.
 * Всё через fs.exec с точечными правами в ACL темы. */

const UBUS = '/bin/ubus';
const IWINFO = '/usr/bin/iwinfo';
const UCI = '/sbin/uci';
const WIFI = '/sbin/wifi';

function run(cmd, args) {
	return fs.exec(cmd, args || []).catch(function (err) {
		return { code: -1, stdout: '', stderr: String((err && err.message) || err) };
	});
}

function notify(msg, type) {
	ui.addNotification(null, E('p', {}, msg), type || 'info');
}

function radioState() {
	return run(UBUS, [ 'call', 'network.wireless', 'status' ]).then(function (res) {
		var data;

		try {
			data = JSON.parse(res.stdout || '{}');
		}
		catch (e) {
			return [];
		}

		var radios = [];

		Object.keys(data).forEach(function (name) {
			var r = data[name] || {};
			var cfg = r.config || {};
			var ifaces = (r.interfaces || []).filter(function (i) { return i.ifname; });

			radios.push({
				name: name,
				band: cfg.band || '',
				channel: cfg.channel || '',
				up: r.up !== false,
				ifaces: ifaces
			});
		});

		return Promise.all(radios.map(function (r) {
			return Promise.all(r.ifaces.map(function (iface) {
				return Promise.all([
					run(IWINFO, [ iface.ifname, 'info' ]),
					run(IWINFO, [ iface.ifname, 'assoclist' ])
				]).then(function (res) {
					var out = res[0].stdout || '';
					var clients = (res[1].stdout || '').split('\n').filter(function (l) {
						return l.trim() !== '';
					}).length;

					iface.ssid = (out.match(/ESSID:\s*"([^"]*)"/) || [])[1] || iface.ifname;
					iface.channel = (out.match(/Channel:\s*(\d+)/) || [])[1] || '';
					iface.clients = clients;
				});
			})).then(function () { return r; });
		}));
	});
}

return baseclass.extend({
	start: function () {
		var self = this;

		if (document.body.getAttribute('data-page') !== 'admin-status-koka')
			return;

		this.box = E('div', { class: 'koka-wifi-box' }, E('div', { class: 'koka-empty' }, 'Читаю Wi-Fi…'));

		var body = E('div', { class: 'koka-card-body' }, [ this.box ]);
		var head = E('header', { class: 'koka-card-head' }, [
			E('span', { class: 'koka-card-ico koka-ico koka-ico-link' }),
			E('span', { class: 'koka-card-title' }, 'Wi-Fi')
		]);

		this.card = E('section', { class: 'koka-card koka-wifi-card' }, [ head, body ]);

		this.attach();
		this.refresh();

		window.setInterval(function () { self.refresh(); }, 10000);
	},

	attach: function () {
		var self = this;
		var host = document.querySelector('.koka-dash') || document.querySelector('#view .cbi-map');

		if (host && !host.querySelector('.koka-wifi-card')) {
			host.appendChild(this.card);
			return;
		}

		if (!host) {
			var tries = 0;
			var timer = window.setInterval(function () {
				var h = document.querySelector('.koka-dash') || document.querySelector('#view .cbi-map');

				if (h && !h.querySelector('.koka-wifi-card')) {
					h.appendChild(self.card);
					window.clearInterval(timer);
				}
				else if (++tries > 40) {
					window.clearInterval(timer);
				}
			}, 250);
		}
	},

	refresh: function () {
		var self = this;

		radioState().then(function (radios) {
			if (!radios.length) {
				dom.content(self.box, E('div', { class: 'koka-empty' }, 'Wi-Fi выключен'));
				return;
			}

			var rows = [];

			radios.forEach(function (r) {
				var label = (r.band === '2g' ? '2.4 ГГц' : (r.band === '5g' ? '5 ГГц' : r.name)) +
					(r.channel ? ' · кан. ' + r.channel : '');

				var ssids = r.ifaces.map(function (i) {
					return (i.ssid || i.ifname) + (i.clients ? ' · ' + i.clients + ' кл.' : '');
				}).join(', ') || '—';

				var toggle = E('button', {
					class: 'koka-wifi-toggle' + (r.up ? ' on' : ''),
					type: 'button',
					title: r.up ? 'Выключить радио' : 'Включить радио'
				}, r.up ? 'вкл' : 'выкл');

				toggle.addEventListener('click', function () {
					toggle.disabled = true;
					self.setRadio(r.name, !r.up).then(function () {
						return self.refresh();
					}).catch(function (err) {
						notify(String((err && err.message) || err), 'error');
					}).then(function () {
						toggle.disabled = false;
					});
				});

				rows.push(E('div', { class: 'koka-wifi-row' }, [
					E('span', { class: 'koka-dot' + (r.up ? ' on' : '') }),
					E('span', { class: 'koka-wifi-band' }, label),
					E('span', { class: 'koka-wifi-ssid' }, ssids),
					toggle
				]));
			});

			rows.push(E('div', { class: 'koka-wifi-actions' }, [
				E('button', {
					class: 'koka-action',
					type: 'button',
					click: function () {
						run(WIFI, [ 'reload' ]).then(function () {
							notify('Wi-Fi: применяю настройки', 'info');
						});
					}
				}, [ E('span', { class: 'koka-ico koka-ico-refresh' }), E('span', {}, 'Перезапустить Wi-Fi') ])
			]));

			dom.content(self.box, rows);
		});
	},

	setRadio: function (radio, enable) {
		return run(UCI, [ 'set', 'wireless.' + radio + '.disabled=' + (enable ? '0' : '1') ])
			.then(function () { return run(UCI, [ 'commit', 'wireless' ]); })
			.then(function () { return run(WIFI, [ 'reload' ]); });
	}
});

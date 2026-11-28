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
				wifiKeys().then(function (keys) { decorateWifiKeys(box, keys); });
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

	function read(path) {
		return need('fs').then(function (fs) {
			return fs.read(path);
		}).catch(function () { return ''; });
	}

	function portInfo(name) {
		return Promise.all([
			read('/sys/class/net/' + name + '/carrier'),
			read('/sys/class/net/' + name + '/speed'),
			read('/sys/class/net/' + name + '/statistics/rx_bytes'),
			read('/sys/class/net/' + name + '/statistics/tx_bytes')
		]).then(function (res) {
			var speed = parseInt(res[1] || '', 10);

			return {
				name: name,
				link: String(res[0] || '').trim() === '1',
				speed: speed > 0 ? speed : 0,
				rx: parseInt(res[2] || '0', 10) || 0,
				tx: parseInt(res[3] || '0', 10) || 0
			};
		});
	}

	function bytes(v) {
		if (v >= 1048576) return (Math.round(v / 104857.6) / 10) + ' MiB';
		if (v >= 1024) return Math.round(v / 1024) + ' KiB';
		return v + ' B';
	}

	function portsModel() {
		return Promise.all([
			run(UBUS, [ 'call', 'network.device', 'status', '{"name":"br-lan"}' ]),
			run(UBUS, [ 'call', 'network.interface', 'dump' ])
		]).then(function (res) {
			var members = [];
			var wanDev = null;

			try {
				members = JSON.parse(res[0].stdout || '{}')['bridge-members'] || [];
			}
			catch (e) {}

			/* В мосту кроме физических портов висят Wi-Fi-интерфейсы
			 * (phy0-ap0 и т.п.) — в карточке «Порты» они не нужны. */
			members = members.filter(function (m) {
				return !/^(phy|wlan|wl[0-9]|ra[0-9]|rai[0-9]|apcli)/i.test(m);
			});

			try {
				var dump = JSON.parse(res[1].stdout || '{}');

				((dump.interface) || []).forEach(function (i) {
					if (i.interface === 'wan')
						wanDev = i.l3_device || i.device;
				});
			}
			catch (e) {}

			return Promise.all(members.map(function (m) {
				return portInfo(m).then(function (p) { p.role = 'LAN'; return p; });
			})).then(function (lan) {
				if (!wanDev)
					return lan;

				return portInfo(wanDev).then(function (p) {
					p.role = 'WAN';
					return lan.concat([ p ]);
				});
			});
		}).catch(function () { return []; });
	}

	function decoratePorts() {
		var card = portsCard();

		if (!card || card.__kokaPorts)
			return false;

		var native = card.querySelector('.koka-ports');

		if (!native)
			return false;

		card.__kokaPorts = true;

		/* Собственный список портов рядом с «родным»: дашборд перерисовывает
		 * свой каждые несколько секунд (eth0/eth1), из-за чего раздел
		 * «прыгал». Наш контейнер живёт отдельно и обновляется только когда
		 * реально меняются данные. */
		var own = E('div', { class: 'koka-ports koka-ports-koka' });

		native.parentNode.insertBefore(own, native.nextSibling);
		native.style.display = 'none';

		var signature = '';

		function hideNative() {
			if (native.style.display !== 'none')
				native.style.display = 'none';
		}

		function render() {
			portsModel().then(function (ports) {
				if (!ports.length)
					return;

				var sig = JSON.stringify(ports.map(function (p) {
					return [ p.name, p.link, p.speed, p.rx, p.tx, p.role ];
				}));

				if (sig === signature)
					return;

				signature = sig;

				own.replaceChildren.apply(own, ports.map(function (p) {
					return E('div', { class: 'koka-port' + (p.link ? '' : ' off') }, [
						E('span', { class: 'koka-dot' + (p.link ? ' on' : '') }),
						E('span', { class: 'koka-ico koka-ico-rj45' + (p.role === 'WAN' ? ' wan' : '') }),
						E('span', { class: 'koka-port-name' }, p.name),
						E('span', { class: 'koka-role' + (p.role === 'WAN' ? ' wan' : '') }, p.role),
						E('div', { class: 'koka-port-main' }, [
							E('span', { class: 'koka-port-speed' },
								p.link ? (p.speed ? p.speed + ' Mb/s' : 'линк') : 'нет линка'),
							E('span', { class: 'koka-port-bytes' },
								p.link ? ('↓ ' + bytes(p.rx) + ' ↑ ' + bytes(p.tx)) : '')
						])
					]);
				}));
			});
		}

		var pending = null;

		function schedule() {
			hideNative();

			if (pending)
				return;

			pending = window.setTimeout(function () {
				pending = null;
				render();
			}, 400);
		}

		render();

		new MutationObserver(schedule).observe(card, { childList: true, subtree: true });
		window.setInterval(hideNative, 1000);

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

		host.insertBefore(box, host.firstChild);
		refreshInternet(box);
		window.setInterval(function () { refreshInternet(box); }, 15000);

		return true;
	}

	var ACTION_ICONS = [
		'koka-ico-net', 'koka-ico-net2', 'koka-ico-router', 'koka-ico-sys', 'koka-ico-shield',
		'koka-ico-lock', 'koka-ico-dns', 'koka-ico-wifi', 'koka-ico-plug', 'koka-ico-bolt',
		'koka-ico-services', 'koka-ico-dhcp', 'koka-ico-reboot', 'koka-ico-pulse',
		'koka-ico-sliders', 'koka-ico-users', 'koka-ico-link', 'koka-ico-refresh',
		'koka-ico-check', 'koka-ico-edit', 'koka-ico-trash', 'koka-ico-reset', 'koka-ico-help'
	];

	var ICON_TITLES = {
		'koka-ico-net': 'Глобус', 'koka-ico-net2': 'Сеть', 'koka-ico-router': 'Роутер',
		'koka-ico-sys': 'Система', 'koka-ico-shield': 'Щит (VPN)', 'koka-ico-lock': 'Замок',
		'koka-ico-dns': 'DNS', 'koka-ico-wifi': 'Wi-Fi', 'koka-ico-plug': 'Порт',
		'koka-ico-bolt': 'Молния', 'koka-ico-services': 'Сервисы', 'koka-ico-dhcp': 'DHCP',
		'koka-ico-reboot': 'Перезагрузка', 'koka-ico-pulse': 'Мониторинг',
		'koka-ico-sliders': 'Настройки', 'koka-ico-users': 'Клиенты', 'koka-ico-link': 'Звено',
		'koka-ico-refresh': 'Обновить', 'koka-ico-check': 'Галочка', 'koka-ico-edit': 'Изменить',
		'koka-ico-trash': 'Удалить', 'koka-ico-reset': 'Сброс', 'koka-ico-help': 'Справка'
	};

	function loadActions() {
		try {
			var v = JSON.parse(localStorage.getItem('koka-actions') || 'null');
			return Array.isArray(v) ? v : null;
		}
		catch (e) { return null; }
	}

	function saveActions(list) {
		try { localStorage.setItem('koka-actions', JSON.stringify(list)); } catch (e) {}
	}

	function quickCard() {
		var cards = [].slice.call(document.querySelectorAll('.koka-card'));

		for (var i = 0; i < cards.length; i++) {
			var t2 = cards[i].querySelector('.koka-card-title');

			if (t2 && t2.textContent.trim() === 'Быстрые действия')
				return cards[i];
		}

		return null;
	}

	function renderActions() {
		var card = quickCard();

		if (!card)
			return false;

		var box = card.querySelector('.koka-actions');

		if (!box)
			return false;

		var list = loadActions();

		if (!list) {
			/* первый запуск: берём то, что нарисовал сам дашборд */
			list = [].slice.call(box.querySelectorAll('a.koka-action')).map(function (a) {
				var ico = a.querySelector('.koka-ico');
				var label = (a.querySelector('span:not(.koka-ico)') || {}).textContent || a.textContent.trim();

				return {
					label: label.trim(),
					url: a.getAttribute('href') || '',
					icon: ico ? ([].slice.call(ico.classList).filter(function (c) { return /^koka-ico-/.test(c); })[0] || 'koka-ico-net') : 'koka-ico-net'
				};
			});

			saveActions(list);
		}

		box.replaceChildren.apply(box, list.map(function (a) {
			return E('a', { class: 'koka-action', href: a.url, title: a.label }, [
				E('span', { class: 'koka-ico ' + a.icon }),
				E('span', {}, a.label)
			]);
		}));

		/* шестерёнка в заголовке карточки */
		var head = card.querySelector('.koka-card-head');

		if (head && !head.querySelector('.koka-actions-edit')) {
			var gear = E('button', { class: 'koka-actions-edit', type: 'button', title: 'Настроить кнопки' }, '⚙');
			gear.addEventListener('click', function () { editActions(); });
			head.appendChild(gear);
		}

		return true;
	}

	function editActions() {
		return need('ui').then(function (ui) {
			return editActionsUi(ui);
		});
	}

	function editActionsUi(ui) {
		var list = (loadActions() || []).map(function (a) {
			return { label: a.label || '', url: a.url || '', icon: a.icon || 'koka-ico-net' };
		});

		function row(a, i) {
			var iconSel = E('select', { class: 'cbi-select' },
				ACTION_ICONS.map(function (c) { return E('option', { value: c }, c.replace('koka-ico-', '')); }));
			var labelInp = E('input', { class: 'cbi-input-text', type: 'text', value: a.label, placeholder: 'Название' });
			var urlInp = E('input', { class: 'cbi-input-text', type: 'text', value: a.url, placeholder: '/cgi-bin/luci/...' });

			iconSel.value = a.icon;

			return E('div', { class: 'koka-ae-row' }, [
				labelInp, urlInp, iconSel,
				E('button', {
					class: 'btn cbi-button-remove', type: 'button', click: function (ev) {
						ev.preventDefault();
						list.splice(i, 1);
						open();
					}
				}, '×')
			]);
		}

		function open() {
			var body = E('div', { class: 'koka-ae' }, [
				E('p', { class: 'cbi-value-description' },
					'Свои кнопки для блока «Быстрые действия». Иконку выбираешь из набора темы; адрес — любой путь LuCI (например /cgi-bin/luci/admin/network/firewall).'),
				E('div', {},
					list.length
						? list.map(row)
						: [ E('p', { class: 'koka-empty' }, 'Пока пусто — добавь первую кнопку.') ])
			]);

			ui.showModal('Кнопки быстрых действий', [
				body,
				E('div', { class: 'right' }, [
					E('button', {
						class: 'btn', type: 'button', click: function (ev) {
							ev.preventDefault();
							list.push({ label: '', url: '', icon: 'koka-ico-net' });
							ui.hideModal();
							editActions();
						}
					}, 'Добавить'),
					' ',
					E('button', { class: 'btn cbi-button-negative', type: 'button', click: ui.hideModal }, 'Отмена'),
					' ',
					E('button', {
						class: 'btn cbi-button-apply', type: 'button', click: function (ev) {
							ev.preventDefault();
							var rows = [].slice.call(body.querySelectorAll('.koka-ae-row'));
							var out = [];

							rows.forEach(function (r) {
								var f = r.querySelectorAll('input, select');
								var label = f[0].value.trim();
								var url = f[1].value.trim();

								if (label && url)
									out.push({ label: label, url: url, icon: f[2].value });
							});

							saveActions(out);
							ui.hideModal();
							renderActions();
						}
					}, 'Сохранить')
				])
			]);

			return body;
		}

		open();
		return true;
	}

	function setupHeroTools() {
		var anchors = [].slice.call(document.querySelectorAll('a.koka-action, button.koka-action'));
		var pick = function (re) {
			return anchors.filter(function (a) { return re.test(a.textContent.trim()); })[0];
		};

		var refresh = pick(/^Обновить$/);
		var tune = pick(/^Настроить$/);

		if (!refresh || !tune || refresh.__kokaTool)
			return false;

		refresh.__kokaTool = true;

		var host = refresh.parentNode;
		var wrap = E('div', { class: 'koka-tools' });

		[[refresh, 'koka-ico-refresh', 'Обновить', 'accent'], [tune, 'koka-ico-sliders', 'Настроить', '']]
			.forEach(function (item) {
				var a = item[0];

				a.textContent = '';
				a.className = 'koka-action koka-toolbtn ' + item[3];
				a.setAttribute('title', item[2]);
				a.setAttribute('aria-label', item[2]);
				a.appendChild(E('span', { class: 'koka-ico ' + item[1] }));
				wrap.appendChild(a);
			});

		host.appendChild(wrap);

		return true;
	}

	var HERO_KEY = 'koka-hero-actions';

	function loadHero() {
		try {
			var v = JSON.parse(localStorage.getItem(HERO_KEY) || 'null');
			return Array.isArray(v) ? v : null;
		}
		catch (e) { return null; }
	}

	function saveHero(list) {
		try { localStorage.setItem(HERO_KEY, JSON.stringify(list)); } catch (e) {}
	}

	function actionMarkup(a) {
		return E('a', { class: 'koka-action', href: a.url, title: a.label }, [
			E('span', { class: 'koka-ico ' + a.icon }),
			E('span', {}, a.label)
		]);
	}

	function renderHeroActions() {
		var host = document.querySelector('.koka-hero-actions');

		if (!host)
			return false;

		var list = loadHero();

		if (!list) {
			list = [].slice.call(host.querySelectorAll('a.koka-action, button.koka-action'))
				.filter(function (a) { return !a.classList.contains('koka-toolbtn'); })
				.map(function (a) {
					var ico = a.querySelector('.koka-ico');
					var label = (a.querySelector('span:not(.koka-ico)') || {}).textContent || a.textContent.trim();

					return {
						label: label.trim(),
						url: a.getAttribute('href') || '#',
						icon: ico ? ([].slice.call(ico.classList).filter(function (c) { return /^koka-ico-/.test(c); })[0] || 'koka-ico-net') : 'koka-ico-net'
					};
				})
				.filter(function (a) { return a.label; });

			saveHero(list);
		}

		var wrap = host.querySelector('.koka-hero-list');

		if (!wrap) {
			wrap = E('div', { class: 'koka-hero-list' });
			host.insertBefore(wrap, host.firstChild);
		}

		wrap.replaceChildren.apply(wrap, list.map(actionMarkup));

		/* прячем родные кнопки, чтобы не дублировались */
		[].slice.call(host.querySelectorAll('a.koka-action, button.koka-action')).forEach(function (a) {
			if (!a.closest('.koka-hero-list') && !a.classList.contains('koka-toolbtn'))
				a.style.display = 'none';
		});

		var tools = host.querySelector('.koka-tools');

		if (!tools) {
			tools = E('div', { class: 'koka-tools' });
			host.appendChild(tools);
		}

		if (!tools.querySelector('.koka-hero-edit')) {
			var gear = E('button', { class: 'koka-actions-edit koka-hero-edit', type: 'button', title: 'Настроить кнопки' }, '⚙');

			gear.addEventListener('click', function () { editHero(); });
			tools.insertBefore(gear, tools.firstChild);
		}

		return true;
	}

	function editHero() {
		return need('ui').then(function (ui) {
			var list = (loadHero() || []).map(function (a) {
				return { label: a.label || '', url: a.url || '', icon: a.icon || 'koka-ico-net' };
			});

			var body = E('div', { class: 'koka-ae' });

			function draw() {
				var rows = list.map(function (a, i) {
					var labelInp = E('input', { class: 'cbi-input-text', type: 'text', value: a.label, placeholder: 'Название' });
					var urlInp = E('input', { class: 'cbi-input-text', type: 'text', value: a.url, placeholder: '/cgi-bin/luci/...' });
					var iconSel = E('select', { class: 'cbi-select' },
						ACTION_ICONS.map(function (c) { return E('option', { value: c }, c.replace('koka-ico-', '')); }));

					iconSel.value = a.icon;

					return E('div', { class: 'koka-ae-row' }, [
						labelInp, urlInp, iconSel,
						E('button', {
							class: 'btn cbi-button-remove', type: 'button', click: function (ev) {
								ev.preventDefault();
								list.splice(i, 1);
								draw();
							}
						}, '×')
					]);
				});

				body.replaceChildren.apply(body, [
					E('p', { class: 'cbi-value-description' },
						'Кнопки в верхнем блоке дашборда. Название, ссылка и иконка из набора темы.'),
					E('div', {}, rows.length ? rows : [ E('p', { class: 'koka-empty' }, 'Пусто — добавь первую кнопку.') ])
				]);
			}

			draw();

			ui.showModal('Кнопки верхнего блока', [
				body,
				E('div', { class: 'right' }, [
					E('button', {
						class: 'btn', type: 'button', click: function (ev) {
							ev.preventDefault();
							list.push({ label: '', url: '', icon: 'koka-ico-net' });
							draw();
						}
					}, 'Добавить'),
					' ',
					E('button', { class: 'btn cbi-button-negative', type: 'button', click: ui.hideModal }, 'Отмена'),
					' ',
					E('button', {
						class: 'btn cbi-button-apply', type: 'button', click: function (ev) {
							ev.preventDefault();

							var out = [];

							[].slice.call(body.querySelectorAll('.koka-ae-row')).forEach(function (r) {
								var f = r.querySelectorAll('input, select');
								var label = f[0].value.trim();
								var url = f[1].value.trim();

								if (label && url)
									out.push({ label: label, url: url, icon: f[2].value });
							});

							saveHero(out);
							ui.hideModal();
							renderHeroActions();
						}
					}, 'Сохранить')
				])
			]);
		});
	}

	function boot() {
		if (document.body.getAttribute('data-page') !== 'admin-status-koka')
			return;

		var box = E('div', { class: 'koka-wifi-box' }, E('div', { class: 'koka-empty' }, 'Читаю Wi-Fi…'));

		var card = E('section', { class: 'koka-card koka-wifi-card' }, [
			E('header', { class: 'koka-card-head' }, [
				E('span', { class: 'koka-card-ico koka-ico koka-ico-wifi' }),
				E('span', { class: 'koka-card-title' }, 'Wi-Fi')
			]),
			E('div', { class: 'koka-card-body' }, [ box ])
		]);

		function host() {
			return document.querySelector('.koka-dash') || document.querySelector('#view .cbi-map');
		}

		function attach() {
			var h = host();

			if (!h)
				return false;

			var quick = quickCard();

			if (!h.querySelector('.koka-wifi-card')) {
				var parent = quick ? quick.parentNode : null;

				if (parent) {
					/* занимаем место «Быстрых действий» и берём их раскладку,
					 * чтобы карточка вела себя как все остальные */
					var span = (quick.className || '').match(/\bspan\d+\b/);

					if (span && !card.classList.contains(span[0]))
						card.classList.add(span[0]);

					parent.insertBefore(card, quick);
				}
				else {
					h.appendChild(card);
				}
			}

			if (quick && quick.style.display !== 'none')
				quick.style.display = 'none';

			return true;
		}

		function wifiKeys() {
		return run(UCI, [ '-q', 'show', 'wireless' ]).then(function (res) {
			var secs = {};
			var map = {};

			(res.stdout || '').split('\n').forEach(function (line) {
				var m = line.match(/^wireless\.([^.=]+)\.(\w+)='([^']*)'$/);

				if (!m)
					return;

				secs[m[1]] = secs[m[1]] || {};
				secs[m[1]][m[2]] = m[3];
			});

			Object.keys(secs).forEach(function (k) {
				var c = secs[k];
				var key = c.key || c.sae_password || c.password || c.wpa_psk;

				if (c.ssid && key)
					map[c.ssid] = key;
			});

			return map;
		}).catch(function () { return {}; });
	}

	function decorateWifiKeys(box, keys) {
		[].slice.call(box.querySelectorAll('.koka-wifi-row')).forEach(function (row) {
			var ssidEl = row.querySelector('.koka-wifi-ssid');

			if (!ssidEl || row.querySelector('.koka-wifi-eye'))
				return;

			var key = keys[ssidEl.textContent.trim()];

			if (!key)
				return;

			var keyEl = E('span', { class: 'koka-wifi-key koka-hidden' }, key);
			var toggle = row.querySelector('.koka-wifi-toggle');

			if (!toggle)
				return;

			var eye = E('button', {
				class: 'koka-wifi-eye',
				type: 'button',
				title: 'Показать пароль'
			}, '\u{1F441}');

			eye.addEventListener('click', function (ev) {
				ev.preventDefault();
				keyEl.classList.toggle('koka-hidden');
				eye.classList.toggle('on');
				eye.title = keyEl.classList.contains('koka-hidden') ? 'Показать пароль' : 'Скрыть пароль';
			});

			row.insertBefore(eye, toggle);
			row.insertBefore(keyEl, toggle);
		});
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

			/* Wi-Fi занимает место бывшей карточки «Быстрые действия» */
			var quick = quickCard();

			if (attached && quick && !quick.__kokaHidden) {
				quick.__kokaHidden = true;
				quick.style.display = 'none';
			}

			var injected = injectInternet();
			var ports = decoratePorts();
			var acts = renderActions();
			var tools = setupHeroTools();
			var heroActs = renderHeroActions();

			if ((attached && injected && ports && acts && tools && heroActs) || ++tries > 60) {
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

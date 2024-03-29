/* global __dirname */

const pro = require("util").promisify;
const fs = require("fs");
const os = require("os");
const path = require("path");
const terser = require("terser");
const cleanCss = require("clean-css");

module.exports = config => {

	let resourceDirectories = [
		__dirname + "/client"
	];

	let apis = {};
	let callChecks = [];

	let events = {};
	let eventFilters = [];

	let sio;

	config.modules.forEach((app) => {

		if (app.api) {
			Object.entries(app.api).forEach(([name, api]) => {
				apis[name] = api;
			});
		}

		if (app.events) {
			function addEvents(apiName, src, dst) {
				events[apiName] = [];
				Object.entries(src).forEach(([key, value]) => {
					if (value === undefined) {
						events[apiName].push(key);
						src[key] = async (...args) => {
							if (sio) {
								for (let socket of Object.values(await sio.fetchSockets())) {
									let allowed = true;
									for (let filterEvent of eventFilters) {
										if (! await filterEvent.bind(socket.appData)({
											apiName,
											eventName: key,
											args
										})) {
											allowed = false;
											break;
										}
									}
									if (allowed) {
										socket.emit("event", apiName, key, args);
									}
								}
							}
						}
					} else if (typeof value === "object") {
						addEvents(key, value);
					}
				});
			}

			addEvents("", app.events);
		}

		if (app.client) {
			resourceDirectories.push(app.client);
		}

		if (app.checkCall) {
			callChecks.push(app.checkCall);
		}

		if (app.filterEvent) {
			eventFilters.push(app.filterEvent);
		}

	});

	async function getIndex() {

		let resources = [];

		for (let dir of resourceDirectories) {
			resources = resources.concat((await pro(fs.readdir)(dir)).map(f => ({
				dir,
				name: f,
				type: path.extname(f).slice(1)
			})));
		}

		let index = (await pro(fs.readFile)(`/${__dirname}/index.html`)).toString();

		let resourcesStr = "";

		async function includeResources({type, ref, minify, inline}) {

			let list = resources.filter(r => r.type === type).sort((a, b) => a.name > b.name ? 1 : -1);

			if (config.minify) {

				let minified = "";
				for (r of list) {
					minified = minified + (await pro(fs.readFile)(r.dir + "/" + r.name)) + "\n";
				}

				console.info(`${type} code minified to ${minified.length} characters`)

				resourcesStr += inline(minify(minified));

			} else {
				list.forEach(r => resourcesStr += `		${ref(r.name)}\n`);
			}
		};

		await includeResources({
			type: "css",
			ref: name => `<link href="${name}" rel="stylesheet" type="text/css"/>`,
			minify: src => new cleanCss({}).minify(src).styles,
			inline: minified => `<style>${minified}</style>`
		});

		await includeResources({
			type: "js",
			ref: name => `<script src="${name}" type="text/javascript"></script>`,
			minify: src => terser.minify(src).code,
			inline: minified => `<script type="text/javascript">${minified}</script>`
		});

		index = index.replace("{webplugResources}", resourcesStr);

		return index;
	}

	function createWebSocket(server) {

		let sio = require('socket.io')(server);

		sio.on("connection", socket => {

			socket.appData = { socket };

			socket.on("discover", (version, cb) => {
				cb({
					events,
					api: Object.entries(apis).reduce((apisAcc, [apiName, apiHandler]) => {
						apisAcc[apiName] = Object.entries(apiHandler).reduce((handlerAcc, [fncName, fnc]) => {
							handlerAcc[fncName] = {
								api: apiName,
								fnc: fncName
							};
							return handlerAcc;
						}, {});
						return apisAcc;
					}, {})
				});
			});

			socket.on("call", (call, cb) => {

				async function callApi() {

					let api = apis[call.api];
					if (!api) throw new Error(`There is no API ${call.api}`);

					let fnc = api[call.fnc];
					if (!fnc) throw new Error(`There is no function ${fnc} in API ${call.api}`);

					for (let callCheck of callChecks) {
						await callCheck.bind(socket.appData)({
							api,
							fnc,
							apiName: call.api,
							fncName: call.fnc,
							args: call.args
						});
					}

					return await fnc.bind(socket.appData)(...call.args);
				}

				callApi().then(result => {
					cb({ result });
				}, error => {
					cb({ error: error.message || error });
				});
			});

		});

		return sio;
	}

	return {

		async start() {

			let express = require('express');
			let app = express();

			let server = require('http').Server(app);
			sio = createWebSocket(server);

			resourceDirectories.forEach(dir => {
				app.use(express.static(dir));
			});

			let index = await getIndex();
			app.get("/*", function (req, res) {
				res.send(index);
			});

			let port = config.httpPort || 8080;
			server.listen(port);

			console.info(`Application available at http://${os.hostname()}.local${port === 80 ? "" : (":" + port)}`);

			return app;

		}
	};
};
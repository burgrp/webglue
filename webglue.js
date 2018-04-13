/* global __dirname */

const pro = require("util").promisify;
const fs = require("fs");
const os = require("os");
const path = require("path");

module.exports = config => {

	let resourceDirectories = [
		__dirname + "/client"
	];
	
	let apis = {};
	let events = [];

	async function getIndex() {
		
		let resources = [];
		
		for (let resDir of resourceDirectories) {
			resources = resources.concat(await pro(fs.readdir)(resDir));
		}
		
		let index = (await pro(fs.readFile)(`/${__dirname}/index.html`)).toString();

		let resourcesStr = "";

		let includeResources = (ext, tagFnc) => {
			resources
					.filter(f => path.extname(f).slice(1) === ext)
					.map(f => path.basename(f))
					.sort()
					.forEach(f => resourcesStr += `		${tagFnc(f)}\n`);
		};

		includeResources("css", f => `<link href="${f}" rel="stylesheet" type="text/css"/>`);
		includeResources("js", f => `<script src="${f}" type="text/javascript"></script>`);

		index = index.replace("{webplugResources}", resourcesStr);

		return index;
	}
	
	function createWebSocket(server) {

		let sio = require('socket.io')(server);

		sio.on("connection", (socket) => {

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
					if (!api) throw `There is no API ${call.api}`;
					let fnc = api[call.fnc];
					if (!fnc) throw `There is no function ${fnc} in API ${call.api}`;
					return await fnc(...call.args);
				}
				
				callApi().then(result => {
					cb({result});
				}, error => {
					cb({error: error.message || error});
				});
			});

		});
		
		return sio;
	}	

	return {
		
		modules: config.modules,

		async start() {

			let express = require('express');
			let app = express();
			let server = require('http').Server(app);
			let sio = createWebSocket(server);

			config.modules.forEach((app) => {
				
				if (app.api) {
					Object.entries(app.api).forEach(([name, api]) => {
						apis[name] = api;
					});
				}

				if (app.events) {
					Object.keys(app.events).forEach(eventName => {
						events.push(eventName);
						app.events[eventName] = (...args) => {
							sio.sockets.emit("event", eventName, args);
						}
					});
				}

				if (app.client) {
					resourceDirectories.push(app.client);
				}

			});

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

		}
	};
};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const schemas_1 = require("@broid/schemas");
const utils_1 = require("@broid/utils");
const Promise = require("bluebird");
const events_1 = require("events");
const express_1 = require("express");
const uuid = require("node-uuid");
const PromiseMemoize = require("promise-memoize");
const R = require("ramda");
const Rx_1 = require("rxjs/Rx");
const client_1 = require("./client");
const Parser_1 = require("./Parser");
const WebHookServer_1 = require("./WebHookServer");
class Adapter {
    constructor(obj) {
        this.serviceID = obj && obj.serviceID || uuid.v4();
        this.logLevel = obj && obj.logLevel || 'info';
        this.token = obj && obj.token || '';
        this.tokenSecret = obj && obj.tokenSecret || '';
        this.username = obj && obj.username || '';
        if (this.token === '') {
            throw new Error('Token should exist.');
        }
        if (this.tokenSecret === '') {
            throw new Error('TokenSecret should exist.');
        }
        if (this.username === '') {
            throw new Error('username should exist.');
        }
        this.emitter = new events_1.EventEmitter();
        this.parser = new Parser_1.Parser(this.serviceName(), this.serviceID, this.logLevel);
        this.logger = new utils_1.Logger('adapter', this.logLevel);
        this.router = this.setupRouter();
        if (obj.http) {
            this.webhookServer = new WebHookServer_1.WebHookServer(obj.http, this.router, this.logLevel);
        }
    }
    serviceName() {
        return 'groupme';
    }
    getRouter() {
        if (this.webhookServer) {
            return null;
        }
        return this.router;
    }
    users() {
        return Promise.reject(new Error('Not supported'));
    }
    channels() {
        const getGroupCached = PromiseMemoize(client_1.getGroups, { maxAge: 350000 });
        return getGroupCached(this.tokenSecret)
            .then(R.map((channel) => {
            return {
                created_at: channel.created_at,
                id: channel.id,
                members: R.map((member) => ({
                    avatar: member.image_url,
                    id: member.user_id,
                    username: member.nickname,
                }), channel.members),
                name: channel.name,
                type: channel.type,
                updated_at: channel.updated_at,
            };
        }));
    }
    serviceId() {
        return this.serviceID;
    }
    connect() {
        if (this.connected) {
            return Rx_1.Observable.of({ type: 'connected', serviceID: this.serviceId() });
        }
        if (this.webhookServer) {
            this.webhookServer.listen();
        }
        this.connected = true;
        return Rx_1.Observable.of(({ type: 'connected', serviceID: this.serviceId() }));
    }
    disconnect() {
        this.connected = false;
        if (this.webhookServer) {
            return this.webhookServer.close();
        }
        return Promise.resolve(null);
    }
    listen() {
        return Rx_1.Observable.fromEvent(this.emitter, 'message')
            .mergeMap((event) => {
            return this.channels()
                .filter((group) => group.id === R.path(['body', 'group_id'], event))
                .then((group) => R.assoc('group', group, event));
        })
            .mergeMap((normalized) => this.parser.parse(normalized))
            .mergeMap((parsed) => this.parser.validate(parsed))
            .mergeMap((validated) => {
            if (!validated) {
                return Rx_1.Observable.empty();
            }
            return Promise.resolve(validated);
        });
    }
    send(data) {
        this.logger.debug('sending', { message: data });
        return schemas_1.default(data, 'send')
            .then(() => {
            if (data.object.type !== 'Note' && data.object.type !== 'Image') {
                return Promise.reject(new Error('Only Note or Image is supported.'));
            }
            return Promise.resolve(data)
                .then((result) => {
                const objectType = R.path(['object', 'type'], data);
                const content = R.path(['object', 'content'], result);
                const payload = {
                    bot_id: this.token,
                    text: content,
                };
                if (objectType === 'Image') {
                    payload.image = {
                        mediaType: R.path(['object', 'mediaType'], data),
                        url: R.path(['object', 'url'], data),
                    };
                }
                return client_1.postMessage(this.tokenSecret, payload);
            })
                .then(() => ({ type: 'sent', serviceID: this.serviceId() }));
        });
    }
    setupRouter() {
        const router = express_1.Router();
        const handle = (req, res) => {
            if (!R.path(['body', 'system'], req) &&
                this.username !== R.path(['body', 'name'], req)) {
                this.emitter.emit('message', {
                    body: req.body,
                    headers: req.headers,
                });
            }
            res.sendStatus(200);
        };
        router.get('/', handle);
        router.post('/', handle);
        return router;
    }
}
exports.Adapter = Adapter;

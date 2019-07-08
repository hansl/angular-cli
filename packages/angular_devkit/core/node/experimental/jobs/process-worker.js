/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
// This file is javascript because we cannot use bootstrap-local when developing it.
let handler = null;
let transformFn = null;

function _ready(message) {
    if (message.kind !== 'init') {
        throw new Error('First message was not "init": ' + JSON.stringify(message));
    }

    if (message.shouldBootstrap) {
        // Kids, don't do this at home!
        require('../../../../../../lib/bootstrap-local');
    }

    transformFn = message.transformFnPath ? require(message.transformFnPath) : null;
    handler = require(message.path);
    if (transformFn) {
        // Options will be `null` if not specified.
        handler = transformFn(handler, message.transformFnOptions);
    } else {
        // Make sure we extract either a function (export = function () {}) or the default export.
        if (typeof handler !== 'function') {
            handler = handler.default;
        }
    }

    process.once('message', _start);
    process.send({ kind: 'ready' });
}

function _start(message) {
    if (message.kind !== 'start') {
        throw new Error('Handshake message was unexpected: ' + JSON.stringify(message));
    }

    const subJobs = [];

    const inboundBus = new (require('rxjs').Subject)();
    process.on('message', message => {
        switch (message.kind) {
            case 'in':
                inboundBus.next(message.message);
                break;

            case 'sub-outbound':
                if (message.id < subJobs.length) {
                    subJobs[message.id].outboundBus.next(message.message);
                }
                break;
            case 'sub-error':
                if (message.id < subJobs.length) {
                    subJobs[message.id].outboundBus.error(message.error);
                }
                break;
            case 'sub-complete':
                if (message.id < subJobs.length) {
                    subJobs[message.id].outboundBus.complete();
                }
                break;
        }
    });

    const remote_scheduler = require('../../../src/experimental/job/remote-scheduler');
    const scheduler = new remote_scheduler.WorkerScheduler();
    const context = {
        description: message.description,
        scheduler: scheduler,
        dependencies: [],
        inboundBus,
    };
    process.send({ kind: 'started' });
    handler(message.argument, context).subscribe(
        outboundMessage => {
            process.send({ kind: 'out', message: outboundMessage });
        },
        err => { process.send({ kind: 'error', error: err }) },
        () => { process.send({ kind: 'complete' }) },
    );
}


process.once('message', _ready);

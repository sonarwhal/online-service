import * as fs from 'fs';

import test, { ExecutionContext } from 'ava';
import { EventEmitter2 as EventEmitter } from 'eventemitter2';
import * as sinon from 'sinon';
import * as proxyquire from 'proxyquire';
type Queue = {
    sendMessage?: (j: any) => void;
    listen?: () => void;
};
const resultsQueue: Queue = { sendMessage() { } };
const jobsQueue: Queue = { listen() { } };
const Queue = function (): Queue {
    return resultsQueue;
};

const queueObject = { Queue };

const childProcess = {
    ChildProcess() { },
    fork() { }
};

const ntp = {
    getTime() {
        Promise.resolve({ now: new Date() });
    }
};

const worker = proxyquire('../../../../src/lib/microservices/worker-service/worker-service', {
    '../../common/ntp/ntp': ntp,
    '../../common/queue/queue': queueObject,
    child_process: childProcess // eslint-disable-line camelcase
});

import { JobStatus, HintStatus } from '../../../../src/lib/enums/status';
import { delay } from '../../../../src/lib/utils/misc';

type WorkerTestContext = {
    sandbox: sinon.SinonSandbox;
    queueObjectQueueStub: sinon.SinonStub;
    resultsQueueSendMessageStub: sinon.SinonStub;
    jobsQueueListenStub: sinon.SinonStub;
    childProcessForkStub: sinon.SinonStub;
};

type TestContext = ExecutionContext<WorkerTestContext>;

test.beforeEach((t: TestContext) => {
    const sandbox = sinon.createSandbox();
    const queueObjectQueueStub = sandbox.stub(queueObject, 'Queue')
        .onFirstCall()
        .returns(jobsQueue)
        .onSecondCall()
        .returns(resultsQueue);

    t.context.queueObjectQueueStub = queueObjectQueueStub;
    t.context.sandbox = sandbox;
});

test.afterEach.always((t: TestContext) => {
    t.context.sandbox.restore();
});

test.serial('Worker has to listen the jobs queue', async (t: TestContext) => {
    const sandbox = t.context.sandbox;

    t.context.jobsQueueListenStub = sandbox.stub(jobsQueue, 'listen').resolves();

    await worker.run();

    t.true(t.context.jobsQueueListenStub.calledOnce);
});

const getEmitter = () => {
    const emitter = new EventEmitter();

    (emitter as any).send = () => { };
    (emitter as any).kill = () => { };
    (emitter as any).stdout = new EventEmitter();
    (emitter as any).stderr = new EventEmitter();

    return emitter;
};

const commonStub = (emitter, t: TestContext) => {
    const sandbox = t.context.sandbox;

    t.context.childProcessForkStub = sandbox.stub(childProcess, 'fork').returns(emitter);
    t.context.jobsQueueListenStub = sandbox.stub(jobsQueue, 'listen');
};

const getHint = (name: string, hints) => {
    return hints.find((hint) => {
        return hint.name === name;
    });
};

test.serial(`If there is no problem running webhint, it should send a couple of messages with the current status`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;
    const job = {
        config: [{ hints: { 'content-type': 'error' } }],
        hints: [{
            category: 'compatibility',
            name: 'content-type',
            status: 'pending'
        }],
        id: 0,
        partInfo: {
            part: 1,
            totalParts: 5
        }
    };
    const emitter = getEmitter();

    t.context.resultsQueueSendMessageStub = sandbox.stub(resultsQueue, 'sendMessage');

    commonStub(emitter, t);

    await worker.run();

    const promise = t.context.jobsQueueListenStub.args[0][0]([{ data: job }]);

    // Wait a little bit to ensure that 'runWebhint' was launched
    await delay(500);
    await emitter.emitAsync('message', {
        messages: [],
        ok: true
    });

    await promise;

    t.true(t.context.resultsQueueSendMessageStub.calledTwice);
    t.is(t.context.resultsQueueSendMessageStub.args[1][0].status, JobStatus.finished);
});

test.serial(`If there is a problem running webhint, it should send a couple of messages with the current status`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;
    const job = {
        config: [{}],
        hints: [],
        id: 0,
        partInfo: {
            part: 1,
            totalParts: 5
        }
    };
    const emitter = getEmitter();

    t.context.resultsQueueSendMessageStub = sandbox.stub(resultsQueue, 'sendMessage');

    commonStub(emitter, t);

    await worker.run();

    const promise = t.context.jobsQueueListenStub.args[0][0]([{ data: job }]);

    // Wait a little bit to ensure that 'runWebhint' was launched
    await delay(500);
    await emitter.emitAsync('message', {
        error: '"Error running webhint"',
        ok: false
    });

    await promise;

    t.true(t.context.resultsQueueSendMessageStub.calledTwice);
    t.is(t.context.resultsQueueSendMessageStub.args[1][0].status, JobStatus.error);
});

test.serial(`If there is a problem running webhint, the job sent to the queue has all hints in the configuration set as error`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;
    const job = {
        config: [{
            hints: {
                axe: 'warning',
                'content-type': 'error',
                'disown-opener': ['off', {}]
            }
        }],
        hints: [
            {
                name: 'axe',
                status: HintStatus.pending
            },
            {
                name: 'content-type',
                status: HintStatus.pending
            },
            {
                name: 'disown-opener',
                status: HintStatus.pending
            },
            {
                name: 'manifest-exists',
                status: HintStatus.pending
            }
        ],
        id: 0,
        partInfo: {
            part: 1,
            totalParts: 5
        }
    };
    const emitter = getEmitter();

    t.context.resultsQueueSendMessageStub = sandbox.stub(resultsQueue, 'sendMessage');

    commonStub(emitter, t);

    await worker.run();

    const promise = t.context.jobsQueueListenStub.args[0][0]([{ data: job }]);

    // Wait a little bit to ensure that 'runWebhint' was launched
    await delay(500);
    await emitter.emitAsync('message', {
        error: '"Error running webhint"',
        ok: false
    });

    await promise;

    const jobSent = t.context.resultsQueueSendMessageStub.args[1][0];
    const hints = jobSent.hints;
    const axe = getHint('axe', hints);
    const contentType = getHint('content-type', hints);
    const disown = getHint('disown-opener', hints);
    const manifest = getHint('manifest-exists', hints);

    t.true(t.context.resultsQueueSendMessageStub.calledTwice);
    t.is(jobSent.status, JobStatus.error);
    t.is(axe.status, HintStatus.error);
    t.is(contentType.status, HintStatus.error);
    t.is(disown.status, HintStatus.off);
    t.is(manifest.status, HintStatus.pending);
});

test.serial(`If a message is too big for Service Bus, we should send the hint with just one common error message`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;
    const job = {
        config: [{ hints: { axe: 'error' } }],
        hints: [
            {
                name: 'axe',
                status: HintStatus.pending
            },
            {
                name: 'content-type',
                status: HintStatus.pending
            }
        ],
        id: 0,
        partInfo: {
            part: 1,
            totalParts: 5
        }
    };
    const emitter = getEmitter();

    t.plan(3);

    t.context.resultsQueueSendMessageStub = sandbox.stub(resultsQueue, 'sendMessage')
        .onFirstCall()
        .resolves()
        .onSecondCall()
        .callsFake((j): void => {
            // j.hints change in each call, so we need to test the value here for the second call.
            t.is(j.hints[0].messages.length, 2);

            const err = { statusCode: 413 };

            throw err;
        })
        .onThirdCall()
        .resolves();

    commonStub(emitter, t);

    await worker.run();

    const promise = t.context.jobsQueueListenStub.args[0][0]([{ data: job }]);

    // Wait a little bit to ensure that 'runWebhint' was launched
    await delay(500);
    await emitter.emitAsync('message', {
        messages: [{
            hintId: 'axe',
            message: 'First of a tons of messages'
        }, {
            hintId: 'axe',
            message: 'Second of a tons of messages'
        }],
        ok: true
    });

    await promise;

    const jobSent = t.context.resultsQueueSendMessageStub.args[2][0];

    t.is(t.context.resultsQueueSendMessageStub.callCount, 3);
    t.is(jobSent.hints[0].messages.length, 1);
});

test.serial(`If there is no problem running webhint, it should send to the queue one message if the size is smaller than MAX_MESSAGE_SIZE`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;
    const job = {
        config: [{
            hints: {
                axe: 'warning',
                'content-type': 'error'
            }
        }],
        hints: [
            {
                name: 'axe',
                status: HintStatus.pending
            },
            {
                name: 'content-type',
                status: HintStatus.pending
            },
            {
                name: 'disown-opener',
                status: HintStatus.pending
            }
        ],
        id: 0,
        partInfo: {
            part: 1,
            totalParts: 5
        }
    };
    const emitter = getEmitter();

    t.context.resultsQueueSendMessageStub = sandbox.stub(resultsQueue, 'sendMessage')
        .onFirstCall()
        .resolves()
        .onSecondCall()
        .resolves();

    commonStub(emitter, t);

    await worker.run();

    const promise = t.context.jobsQueueListenStub.args[0][0]([{ data: job }]);

    // Wait a little bit to ensure that 'runWebhint' was launched
    await delay(500);
    await emitter.emitAsync('message', {
        messages: [{
            hintId: 'axe',
            message: 'Warning 1 axe'
        },
        {
            hintId: 'axe',
            message: 'Warning 2 axe'
        }],
        ok: true
    });

    await promise;

    const axe = getHint('axe', t.context.resultsQueueSendMessageStub.args[1][0].hints);
    const contentType = getHint('content-type', t.context.resultsQueueSendMessageStub.args[1][0].hints);

    t.is(t.context.resultsQueueSendMessageStub.callCount, 2);
    t.is(axe.status, HintStatus.warning);
    t.is(contentType.status, HintStatus.pass);
});

test.serial(`If there is no problem running webhint, it should send to the queue 2 messages if the total size is bigger than MAX_MESSAGE_SIZE`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;
    const lipsum = fs.readFileSync(`${__dirname}/../fixtures/lipsum.txt`, 'utf-8'); // eslint-disable-line no-sync

    const job = {
        config: [{
            hints: {
                axe: 'warning',
                'content-type': 'error'
            }
        }],
        hints: [
            {
                name: 'axe',
                status: HintStatus.pending
            },
            {
                name: 'content-type',
                status: HintStatus.pending
            }
        ],
        id: 0,
        partInfo: {
            part: 1,
            totalParts: 5
        }
    };
    const emitter = getEmitter();

    t.context.resultsQueueSendMessageStub = sandbox.stub(resultsQueue, 'sendMessage')
        .onFirstCall()
        .resolves()
        .onSecondCall()
        .resolves();

    commonStub(emitter, t);

    await worker.run();

    const promise = t.context.jobsQueueListenStub.args[0][0]([{ data: job }]);

    // Wait a little bit to ensure that 'runWebhint' was launched
    await delay(500);
    await emitter.emitAsync('message', {
        messages: [{
            hintId: 'axe',
            message: lipsum
        },
        {
            hintId: 'content-type',
            message: lipsum
        }],
        ok: true
    });

    await promise;

    t.is(t.context.resultsQueueSendMessageStub.callCount, 3);
});


test.serial(`If there is no problem running webhint, it should send a "Too many errors" message if the messages are bigger than MAX_MESSAGE_SIZE`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;
    const lipsum = fs.readFileSync(`${__dirname}/../fixtures/lipsum.txt`, 'utf-8'); // eslint-disable-line no-sync

    const job = {
        config: [{
            hints: {
                axe: 'warning',
                'content-type': 'error'
            }
        }],
        hints: [
            {
                name: 'axe',
                status: HintStatus.pending
            },
            {
                name: 'content-type',
                status: HintStatus.pending
            }
        ],
        id: 0,
        partInfo: {
            part: 1,
            totalParts: 5
        }
    };
    const emitter = getEmitter();

    t.context.resultsQueueSendMessageStub = sandbox.stub(resultsQueue, 'sendMessage')
        .onFirstCall()
        .resolves();

    commonStub(emitter, t);

    await worker.run();

    const promise = t.context.jobsQueueListenStub.args[0][0]([{ data: job }]);

    // Wait a little bit to ensure that 'runWebhint' was launched
    await delay(500);
    await emitter.emitAsync('message', {
        messages: [{
            hintId: 'axe',
            message: lipsum + lipsum
        }],
        ok: true
    });

    await promise;

    const axe = getHint('axe', t.context.resultsQueueSendMessageStub.args[1][0].hints);

    t.is(t.context.resultsQueueSendMessageStub.callCount, 2);
    t.is(axe.status, HintStatus.warning);
    t.is(axe.messages.length, 1);
    t.is(axe.messages[0].message, 'This hint has too many errors, please use webhint locally for more details');
});

test.serial(`If webhint doesn't finish before the job.maxRunTime, it should report an error message to the queue, but the job status is finished`, async (t: TestContext) => {
    const sandbox = t.context.sandbox;
    const job = {
        config: [{}],
        hints: [],
        id: 0,
        maxRunTime: 1,
        partInfo: {
            part: 1,
            totalParts: 5
        }
    };
    const emitter = getEmitter();

    t.context.resultsQueueSendMessageStub = sandbox.stub(resultsQueue, 'sendMessage');

    commonStub(emitter, t);

    await worker.run();
    await t.context.jobsQueueListenStub.args[0][0]([{ data: job }]);

    t.true(t.context.resultsQueueSendMessageStub.calledTwice);

    const queueArgs = t.context.resultsQueueSendMessageStub.args[1][0];

    t.is(queueArgs.status, JobStatus.finished);
    t.is(queueArgs.error.message, 'TIMEOUT');
});

import test from 'ava';
import * as sinon from 'sinon';
import * as proxyquire from 'proxyquire';
import * as moment from 'moment';
import * as _ from 'lodash';

import { IStatus } from '../../../../src/lib/types';
import { job as validJob } from './fixtures/job';

const validStatus: IStatus = {
    average: {
        finish: null,
        start: null
    },
    date: new Date('2017-10-15T08:15:00.000Z'),
    queues: null,
    scans: {
        created: 0,
        finished: {
            error: 0,
            success: 0
        },
        started: 0
    }
};

const database = {
    addStatus() { },
    connect() { },
    getJobsByDate() { },
    getMostRecentStatus() { },
    getStatusesByDate() { },
    updateStatus() { }
};

const queueMethods = { getMessagesCount() { } };

const Queue = function () {
    return queueMethods;
};

const queueObject = { Queue };

process.env.database = 'Database connection string'; // eslint-disable-line no-process-env
process.env.queue = 'Queue connection string'; // eslint-disable-line no-process-env

proxyquire('../../../../src/lib/common/status/status', {
    '../database/database': database,
    '../queue/queue': queueObject
});

import * as status from '../../../../src/lib/common/status/status';

test.beforeEach((t) => {
    sinon.stub(database, 'connect').resolves();
    sinon.stub(database, 'addStatus').resolves(validStatus);
    sinon.stub(database, 'updateStatus').resolves();
    sinon.stub(queueMethods, 'getMessagesCount').resolves();
    t.context.database = database;
    t.context.queueMethods = queueMethods;
});

test.afterEach.always((t) => {
    t.context.database.connect.restore();
    t.context.database.addStatus.restore();
    t.context.database.updateStatus.restore();
    t.context.queueMethods.getMessagesCount.restore();

    if (t.context.database.getStatusesByDate.restore) {
        t.context.database.getStatusesByDate.restore();
    }
    if (t.context.database.getMostRecentStatus.restore) {
        t.context.database.getMostRecentStatus.restore();
    }
    if (t.context.database.getJobsByDate.restore) {
        t.context.database.getJobsByDate.restore();
    }
});

test.serial('getStatus should return the items in the database between the dates (1/3)', async (t) => {
    sinon.stub(database, 'getStatusesByDate').resolves([validStatus]);

    await status.getStatus(new Date('2017-10-15T08:29:59.999Z'), new Date('2017-10-15T08:30:00.000Z'));

    t.is(t.context.database.getStatusesByDate.callCount, 1);

    const args = t.context.database.getStatusesByDate.args;

    t.true(moment(args[0][0]).isSame(moment('2017-10-15T08:15:00.000Z')));
    t.true(moment(args[0][1]).isSame(moment('2017-10-15T08:30:00.000Z')));
});

test.serial('getStatus should return the items in the database between the dates (2/3)', async (t) => {
    sinon.stub(database, 'getStatusesByDate').resolves([validStatus]);

    await status.getStatus(new Date('2017-10-15T09:15:00.000Z'), new Date('2017-10-15T09:38:00.000Z'));

    t.is(t.context.database.getStatusesByDate.callCount, 1);

    const args = t.context.database.getStatusesByDate.args;

    t.true(moment(args[0][0]).isSame(moment('2017-10-15T09:15:00.000Z')));
    t.true(moment(args[0][1]).isSame(moment('2017-10-15T09:30:00.000Z')));
});

test.serial('getStatus should return the items in the database between the dates (3/3)', async (t) => {
    sinon.stub(database, 'getStatusesByDate').resolves([validStatus]);

    await status.getStatus(new Date('2017-10-15T10:00:00.000Z'), new Date('2017-10-15T10:59:59.999Z'));

    t.is(t.context.database.getStatusesByDate.callCount, 1);

    const args = t.context.database.getStatusesByDate.args;

    t.true(moment(args[0][0]).isSame(moment('2017-10-15T10:00:00.000Z')));
    t.true(moment(args[0][1]).isSame(moment('2017-10-15T10:45:00.000Z')));
});

test.serial('updateStatuses should get results every 15 minutes', async (t) => {
    const recentDate = moment()
        .subtract(16, 'm')
        .startOf('minute');

    sinon.stub(database, 'getMostRecentStatus').resolves({ date: recentDate });
    sinon.stub(database, 'getJobsByDate').resolves([]);

    await status.updateStatuses();

    t.is(t.context.database.getJobsByDate.callCount, 3);
    t.true(t.context.database.addStatus.calledOnce);
    t.true(t.context.database.updateStatus.calledOnce);

    const args = t.context.database.getJobsByDate.args;

    t.is(args[0][0], 'queued');
    t.is(args[1][0], 'started');
    t.is(args[2][0], 'finished');
});

test.serial('updateStatuses should just update the queue status for the last period of time', async (t) => {
    const recentDate = moment()
        .subtract(31, 'm')
        .startOf('minute');

    sinon.stub(database, 'getMostRecentStatus').resolves({ date: recentDate });
    sinon.stub(database, 'getJobsByDate').resolves([]);

    await status.updateStatuses();

    t.is(t.context.database.getJobsByDate.callCount, 6);
    t.true(t.context.database.addStatus.calledTwice);
    t.true(t.context.database.updateStatus.calledOnce);
});

test.serial('updateStatuses should calculate the averages', async (t) => {
    const recentDate = moment()
        .subtract(16, 'm')
        .startOf('minute');

    const validJob2 = _.cloneDeep(validJob);
    const validJob3 = _.cloneDeep(validJob);

    validJob.queued = moment()
        .startOf('hour')
        .toDate();
    validJob.started = moment(validJob.queued)
        .add(1, 's')
        .toDate();
    validJob.finished = moment(validJob.started)
        .add(1, 'm')
        .toDate();

    validJob2.queued = moment()
        .startOf('hour')
        .toDate();
    validJob2.started = moment(validJob2.queued)
        .add(3, 's')
        .toDate();
    validJob2.finished = moment(validJob2.started)
        .add(1, 'm')
        .add(30, 's')
        .toDate();

    validJob3.queued = moment()
        .startOf('hour')
        .toDate();
    validJob3.started = moment(validJob3.queued)
        .add(5, 's')
        .toDate();
    validJob3.finished = moment(validJob3.started)
        .add(2, 'm')
        .toDate();

    sinon.stub(database, 'getMostRecentStatus').resolves({ date: recentDate });
    sinon.stub(database, 'getJobsByDate').resolves([validJob, validJob2, validJob3]);

    await status.updateStatuses();

    t.is(t.context.database.getJobsByDate.callCount, 3);
    t.true(t.context.database.addStatus.calledOnce);
    t.true(t.context.database.updateStatus.calledOnce);

    const args = t.context.database.addStatus.args[0][0];

    t.is(args.average.start, 3000);
    t.is(args.average.finish, 90000);
});

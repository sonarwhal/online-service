import { Queue } from '../../common/queue/queue';
import * as database from '../../common/database/database';
import { IJobModel } from '../../common/database/models/job';
import { IJob, Rule } from '../../types';
import { JobStatus, RuleStatus } from '../../enums/status';
import * as logger from '../../utils/logging';

const moduleName: string = 'Sync Service';
/**
 * Get a rule from rules given a rule name.
 * @param {string} name Name of the rule to get.
 * @param {Array<Rule>} rules Rules where to find the rule name.
 */
const getRule = (name: string, rules: Array<Rule>) => {
    return rules.find((rule) => {
        return rule.name === name;
    });
};

/**
 * Update the rules statuses and messages in dbJob.
 * @param {IJob} dbJob Job from database.
 * @param {IJob} job Job from service bus.
 */
const setRules = (dbJob: IJob, job: IJob) => {
    for (const rule of job.rules) {
        const dbJobRule = getRule(rule.name, dbJob.rules);

        if (dbJobRule.status === RuleStatus.pending) {
            dbJobRule.messages = rule.messages;
            dbJobRule.status = rule.status;
        }
    }
};

/**
 * Check if a job finish the scan.
 * @param {IJob} job Job to check if it is finished or not.
 */
const isJobFinished = (job: IJob) => {
    return job.rules.every((rule) => {
        return rule.status !== RuleStatus.pending;
    });
};

/**
 * Run the sync service.
 */
export const run = async () => {
    const queueResults = new Queue('sonar-results', process.env.queue); // eslint-disable-line no-process-env

    await database.connect(process.env.database); // eslint-disable-line no-process-env

    const listener = async (job: IJob) => {
        logger.log(`Synchronizing Job: ${job.id} - Part ${job.part} of ${job.totalParts}`, moduleName);
        const lock = await database.lock(job.id);

        const dbJob: IJobModel = await database.getJob(job.id);

        if (!dbJob) {
            logger.error(`Job ${job.id} not found in database`, moduleName);
            await database.unlock(lock);

            return;
        }

        // If the job fails at some point, ignore other messages.
        // This can happen if for example we split the job in
        // some groups of rules to run just a subset in each worker
        // and for some reason, one of the execution fails.
        if (dbJob.status === JobStatus.error) {
            logger.error(`Synchronization skipped: Job ${job.id} status is error`, moduleName);
            await database.unlock(lock);

            return;
        }

        if (job.status === JobStatus.started) {
            // When the a job is splitted we receive more than one messges for the status `started`
            // but we only want to store in the database the first one.
            if (dbJob.status !== JobStatus.started) {
                dbJob.started = job.started;
                dbJob.sonarVersion = job.sonarVersion;
            }

            // double check just in case the started message is not the first one we are processing.
            if (dbJob.status === JobStatus.pending) {
                dbJob.status = job.status;
            }
        } else {
            setRules(dbJob, job);

            if (job.status === JobStatus.error) {
                dbJob.status = job.status;
                dbJob.finished = job.finished;
                dbJob.error = job.error;
            } else if (isJobFinished(dbJob)) {
                dbJob.finished = job.finished;
                dbJob.status = job.status;
            }
        }

        await database.updateJob(dbJob);
        await database.unlock(lock);

        logger.log(`Synchronized Job: ${job.id} - Part ${job.part} of ${job.totalParts}`, moduleName);
    };

    try {
        await queueResults.listen(listener);
        await database.disconnect();
        logger.log('Service finished\nExiting with status 0', moduleName);

        return 0;
    } catch (err) {
        logger.error('Error in Sync service\nExiting with status 1', moduleName);

        return 1;
    }
};

if (process.argv[1].includes('sync-service.js')) {
    run();
}

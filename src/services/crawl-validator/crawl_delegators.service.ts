/* eslint-disable no-await-in-loop */
import { Service } from '@ourparentcenter/moleculer-decorators-extended';
import { ServiceBroker } from 'moleculer';
import Long from 'long';
import { fromBase64 } from '@cosmjs/encoding';
import { Knex } from 'knex';
import BigNumber from 'bignumber.js';
import BullableService, { QueueHandler } from '../../base/bullable.service';
import config from '../../../config.json' assert { type: 'json' };
import {
  BULL_JOB_NAME,
  getLcdClient,
  IProviderJSClientFactory,
  IPagination,
  IValidatorDelegators,
  SERVICE,
  MSG_TYPE,
} from '../../common';
import {
  BlockCheckpoint,
  Delegator,
  TransactionMessage,
  Validator,
} from '../../models';
import knex from '../../common/utils/db_connection';

@Service({
  name: SERVICE.V1.CrawlDelegatorsService.key,
  version: 1,
})
export default class CrawlDelegatorsService extends BullableService {
  private _lcdClient!: IProviderJSClientFactory;

  public constructor(public broker: ServiceBroker) {
    super(broker);
  }

  // @description: Old logic for delete and crawl latest delegators from RPC, used for api
  // =================================================OLD LOGIC=========================================================
  /**
   * @description: Delete all and crawl again delegator, so all delegator will be crawled from RPC instead of from
   * transaction_message table, so you need to stop CRAWL_DELEGATORS job and wait until this update complete, this job
   * will update checkpoint of CRAWL_DELEGATORS job, set it to latest transaction_message, then you can start CRAWL_DELEGATORS
   * again
   */
  public async updateAllValidator(): Promise<void> {
    await Delegator.query().delete(true).where('id', '>', 0);
    const validators: Validator[] = await Validator.query();
    const jobCrawlDelegators = validators.map((validator) =>
      this.createJob(
        BULL_JOB_NAME.CRAWL_VALIDATOR_DELEGATORS,
        BULL_JOB_NAME.CRAWL_VALIDATOR_DELEGATORS,
        {
          id: validator.id,
          address: validator.operator_address,
          height: validator.delegators_last_height,
        },
        {
          removeOnComplete: true,
          removeOnFail: {
            count: 3,
          },
          attempts: config.jobRetryAttempt,
          backoff: config.jobRetryBackoff,
        }
      )
    );
    await Promise.all(jobCrawlDelegators);
    const latestTransactionMessage = await TransactionMessage.query()
      .orderBy('id', 'DESC')
      .limit(1);
    await BlockCheckpoint.query()
      .update({
        height: latestTransactionMessage[0].id,
      })
      .where({
        job_name: BULL_JOB_NAME.CHECKPOINT_UPDATE_DELEGATOR,
      });
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_VALIDATOR_DELEGATORS,
    jobName: BULL_JOB_NAME.CRAWL_VALIDATOR_DELEGATORS,
  })
  public async handleJobCrawlValidatorDelegators(
    _payload: IValidatorDelegators
  ): Promise<void> {
    this.logger.info(`Update delegator for validator ${_payload.address}`);
    this._lcdClient = await getLcdClient();

    const delegations = [];
    const delegators: Delegator[] = [];

    let resultCallApi;
    let done = false;
    const pagination: IPagination = {
      limit: Long.fromInt(config.crawlDelegators.queryPageLimit),
    };

    while (!done) {
      resultCallApi =
        await this._lcdClient.provider.cosmos.staking.v1beta1.validatorDelegations(
          {
            validatorAddr: _payload.address,
            pagination,
          }
        );

      delegations.push(...resultCallApi.delegation_responses);
      if (resultCallApi.pagination.next_key === null) {
        done = true;
      } else {
        pagination.key = fromBase64(resultCallApi.pagination.next_key);
      }
    }

    if (delegations.length > 0) {
      delegations.forEach((delegate) => {
        delegators.push(
          Delegator.fromJson({
            validator_id: _payload.id,
            delegator_address: delegate.delegation.delegator_address,
            amount: delegate.balance.amount,
          })
        );
      });
    }

    const latestBlock: BlockCheckpoint | undefined =
      await BlockCheckpoint.query()
        .where('job_name', BULL_JOB_NAME.CRAWL_BLOCK)
        .first();

    await knex.transaction(async (trx) => {
      await Promise.all([
        Delegator.query()
          .insert(delegators)
          .onConflict(['validator_id', 'delegator_address'])
          .merge()
          .transacting(trx)
          .catch((error) => {
            this.logger.error(
              `Insert or update validator delegators error: ${_payload.address}`
            );
            this.logger.error(error);
          }),
        Delegator.query()
          .delete(true)
          .whereNotIn(
            'delegator_address',
            delegators.map((delegate) => delegate.delegator_address)
          )
          .andWhere('validator_id', _payload.id)
          .transacting(trx),
        Validator.query()
          .patch({
            delegators_count: delegations.length,
            delegators_last_height: latestBlock
              ? latestBlock.height
              : _payload.height,
          })
          .where('id', _payload.id)
          .transacting(trx),
      ]);
    });
  }

  // =================================================END OLD LOGIC=========================================================

  private async getCheckpointUpdateDelegator(): Promise<BlockCheckpoint> {
    let checkpointDelegator = await BlockCheckpoint.query().findOne({
      job_name: BULL_JOB_NAME.CHECKPOINT_UPDATE_DELEGATOR,
    });

    if (!checkpointDelegator) {
      const oldestTransactionMessage = await TransactionMessage.query()
        .orderBy('id', 'ASC')
        .limit(1);

      if (oldestTransactionMessage.length === 0) {
        throw Error('No transaction message found.');
      }

      checkpointDelegator = BlockCheckpoint.fromJson({
        job_name: BULL_JOB_NAME.CHECKPOINT_UPDATE_DELEGATOR,
        height: oldestTransactionMessage[0].id,
      });

      await BlockCheckpoint.query().insert(checkpointDelegator);
    }

    return checkpointDelegator;
  }

  public async handleDelegateTxMsg(
    delegateTxMsg: TransactionMessage,
    trx: Knex.Transaction
  ): Promise<void> {
    const validator = await Validator.query().findOne(
      'operator_address',
      delegateTxMsg.content.validator_address
    );

    if (!validator) {
      this.logger.info('No validator found!');
      return;
    }

    const delegator = await Delegator.query().findOne({
      delegator_address: delegateTxMsg.content.delegator_address,
      validator_id: validator.id,
    });

    if (!delegator) {
      await trx(Delegator.tableName).insert(
        Delegator.fromJson({
          validator_id: validator.id,
          delegator_address: delegateTxMsg.content.delegator_address,
          amount: delegateTxMsg.content.amount.amount,
        })
      );
      await trx(Validator.tableName)
        .update({
          delegators_count: validator.delegators_count + 1,
        })
        .where({
          id: validator.id,
        });
    } else {
      await trx(Delegator.tableName)
        .update({
          amount: BigNumber(delegator.amount)
            .plus(delegateTxMsg.content.amount.amount)
            .toString(),
        })
        .where({
          id: delegator.id,
        });
    }
  }

  public async handleReDelegateTxMsg(
    reDelegateTxMsg: TransactionMessage,
    trx: Knex.Transaction
  ): Promise<void> {
    const validatorSrc = await Validator.query().findOne(
      'operator_address',
      reDelegateTxMsg.content.validator_src_address
    );
    const validatorDst = await Validator.query().findOne(
      'operator_address',
      reDelegateTxMsg.content.validator_dst_address
    );

    if (!validatorSrc || !validatorDst) {
      this.logger.info('No validator found!');
      return;
    }

    const delegatorSrc = await Delegator.query().findOne({
      delegator_address: reDelegateTxMsg.content.delegator_address,
      validator_id: validatorSrc.id,
    });
    const delegatorDst = await Delegator.query().findOne({
      delegator_address: reDelegateTxMsg.content.delegator_address,
      validator_id: validatorDst.id,
    });

    if (delegatorSrc) {
      const remainDelegateSrcAmount = BigNumber(delegatorSrc.amount).minus(
        reDelegateTxMsg.content.amount.amount
      );
      if (remainDelegateSrcAmount.gt(0)) {
        await trx(Delegator.tableName)
          .update({
            amount: remainDelegateSrcAmount.toString(),
          })
          .where({
            id: delegatorSrc.id,
          });
      } else {
        await trx(Delegator.tableName).delete().where({
          id: delegatorSrc.id,
        });
      }
    }

    if (!delegatorDst) {
      await trx(Delegator.tableName).insert(
        Delegator.fromJson({
          validator_id: validatorDst.id,
          delegator_address: reDelegateTxMsg.content.delegator_address,
          amount: reDelegateTxMsg.content.amount.amount,
        })
      );
      await trx(Validator.tableName)
        .update({
          delegators_count: validatorDst.delegators_count + 1,
        })
        .where({
          id: validatorDst.id,
        });
    } else {
      await trx(Delegator.tableName)
        .update({
          amount: BigNumber(delegatorDst.amount)
            .plus(reDelegateTxMsg.content.amount.amount)
            .toString(),
        })
        .where({
          id: delegatorDst.id,
        });
    }
  }

  public async handleUnDelegateTxMsg(
    unDelegateTxMsg: TransactionMessage,
    trx: Knex.Transaction
  ): Promise<void> {
    const validator = await Validator.query().findOne(
      'operator_address',
      unDelegateTxMsg.content.validator_address
    );

    if (!validator) {
      this.logger.info('No validator found!');
      return;
    }

    const delegator = await Delegator.query().findOne({
      delegator_address: unDelegateTxMsg.content.delegator_address,
      validator_id: validator.id,
    });

    if (!delegator) return;

    const remainDelegateAmount = BigNumber(delegator.amount).minus(
      unDelegateTxMsg.content.amount.amount
    );

    if (remainDelegateAmount.gt(0)) {
      await trx(Delegator.tableName)
        .update({
          amount: remainDelegateAmount.toString(),
        })
        .where({
          id: delegator.id,
        });
    } else {
      await trx(Delegator.tableName).delete().where({
        id: delegator.id,
      });
      await trx(Validator.tableName)
        .update({
          delegators_count: validator.delegators_count - 1,
        })
        .where({
          id: validator.id,
        });
    }
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_DELEGATORS,
    jobName: BULL_JOB_NAME.CRAWL_DELEGATORS,
  })
  public async handleJob(_payload: object): Promise<void> {
    const checkpointDelegator = await this.getCheckpointUpdateDelegator();
    const txMsg = await TransactionMessage.query()
      .where('id', '>', checkpointDelegator.height)
      .whereIn('type', [
        MSG_TYPE.MSG_DELEGATE,
        MSG_TYPE.MSG_REDELEGATE,
        MSG_TYPE.MSG_UNDELEGATE,
        MSG_TYPE.MSG_CANCEL_UNDELEGATE,
      ])
      .orderBy('id', 'ASC')
      .limit(config.crawlDelegators.txMsgPageLimit);

    if (!txMsg || txMsg.length === 0) {
      this.logger.info('No transaction message found for delegation actions!');
      return;
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const msg of txMsg) {
      const trx = await knex.transaction();
      try {
        switch (msg.type) {
          case MSG_TYPE.MSG_DELEGATE:
            await this.handleDelegateTxMsg(msg, trx);
            break;
          case MSG_TYPE.MSG_REDELEGATE:
            await this.handleReDelegateTxMsg(msg, trx);
            break;
          case MSG_TYPE.MSG_UNDELEGATE:
            await this.handleUnDelegateTxMsg(msg, trx);
            break;
          case MSG_TYPE.MSG_CANCEL_UNDELEGATE:
            await this.handleDelegateTxMsg(msg, trx);
            break;
          default:
            break;
        }
        await trx(BlockCheckpoint.tableName)
          .update({
            height: msg.id,
          })
          .where({
            job_name: BULL_JOB_NAME.CHECKPOINT_UPDATE_DELEGATOR,
          });

        await trx.commit();
      } catch (error) {
        this.logger.error(error);
        await trx.rollback();
      }
    }
    this.logger.info('Update validator delegators');
  }

  public async _start() {
    this.createJob(
      BULL_JOB_NAME.CRAWL_DELEGATORS,
      BULL_JOB_NAME.CRAWL_DELEGATORS,
      {},
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
        repeat: {
          every: config.crawlDelegators.millisecondCrawl,
        },
      }
    );

    return super._start();
  }
}

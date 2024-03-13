import { HttpBatchClient } from '@cosmjs/tendermint-rpc';
import {
  Action,
  Service,
} from '@ourparentcenter/moleculer-decorators-extended';
import _, { Dictionary } from 'lodash';
import { Context, ServiceBroker } from 'moleculer';
import { Queue } from 'bullmq';
import { Knex } from 'knex';
import config from '../../../config.json' assert { type: 'json' };
import BullableService, { QueueHandler } from '../../base/bullable.service';
import {
  Config,
  IContextReindexingServiceHistory,
  getHttpBatchClient,
} from '../../common';
import { BULL_JOB_NAME, SERVICE } from '../../common/constant';
import knex from '../../common/utils/db_connection';
import { getAttributeFrom } from '../../common/utils/smart_contract';
import { Block, BlockCheckpoint, EventAttribute } from '../../models';
import CW721Contract from '../../models/cw721_contract';
import CW721ContractStats from '../../models/cw721_stats';
import CW721Token from '../../models/cw721_token';
import CW721Activity from '../../models/cw721_tx';
import { SmartContract } from '../../models/smart_contract';
import { SmartContractEvent } from '../../models/smart_contract_event';
import { CW721_ACTION, Cw721Handler } from './cw721_handler';

const { NODE_ENV } = Config;

export interface ICw721ReindexingHistoryParams {
  smartContractId: number;
  startBlock: number;
  endBlock: number;
  prevId: number;
  contractAddress: string;
}
@Service({
  name: SERVICE.V1.Cw721.key,
  version: 1,
})
export default class Cw721HandlerService extends BullableService {
  _httpBatchClient!: HttpBatchClient;

  public constructor(public broker: ServiceBroker) {
    super(broker);
    this._httpBatchClient = getHttpBatchClient();
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.HANDLE_CW721_TRANSACTION,
    jobName: BULL_JOB_NAME.HANDLE_CW721_TRANSACTION,
  })
  async jobHandler(): Promise<void> {
    await this.handleJob();
  }

  async _start(): Promise<void> {
    if (NODE_ENV !== 'test') {
      await this.createJob(
        BULL_JOB_NAME.HANDLE_CW721_TRANSACTION,
        BULL_JOB_NAME.HANDLE_CW721_TRANSACTION,
        {},
        {
          removeOnComplete: true,
          removeOnFail: {
            count: 3,
          },
          repeat: {
            every: config.cw721.millisecondRepeatJob,
          },
        }
      );
      await this.createJob(
        BULL_JOB_NAME.REFRESH_CW721_STATS,
        BULL_JOB_NAME.REFRESH_CW721_STATS,
        {},
        {
          removeOnComplete: { count: 1 },
          removeOnFail: {
            count: 3,
          },
          repeat: {
            pattern: config.cw721.timeRefreshCw721Stats,
          },
        }
      );
      await this.createJob(
        BULL_JOB_NAME.JOB_CW721_UPDATE,
        BULL_JOB_NAME.JOB_CW721_UPDATE,
        {},
        {
          removeOnComplete: true,
          removeOnFail: {
            count: 3,
          },
          repeat: {
            every: config.cw721.jobCw721Update.millisecondRepeatJob,
          },
        }
      );
    }
    return super._start();
  }

  // main function
  async handleJob() {
    // get range blocks for proccessing
    const [startBlock, endBlock, updateBlockCheckpoint] =
      await BlockCheckpoint.getCheckpoint(
        BULL_JOB_NAME.HANDLE_CW721_TRANSACTION,
        [BULL_JOB_NAME.CRAWL_CONTRACT_EVENT],
        config.cw721.key
      );
    this.logger.info(`startBlock: ${startBlock} to endBlock: ${endBlock}`);
    if (startBlock >= endBlock) return;
    // get all contract Msg in above range blocks
    const listContractMsg = await CW721Activity.getCw721ContractEvents(
      startBlock,
      endBlock
    );
    this.logger.info(listContractMsg);
    await knex.transaction(async (trx) => {
      if (listContractMsg.length > 0) {
        // handle instantiate cw721 contracts
        await this.handleInstantiateMsgs(
          listContractMsg.filter(
            (msg) => msg.action === CW721_ACTION.INSTANTIATE
          ),
          trx
        );
        // handle all cw721 execute messages
        const { tokens, cw721Activities, cw721Contracts } =
          await this.handleCw721MsgExec(listContractMsg, trx);
        await this.updateTokenAndActivities(tokens, cw721Activities, trx);
        await this.updateCw721Contract(cw721Contracts, trx);
      }
      updateBlockCheckpoint.height = endBlock;
      await BlockCheckpoint.query()
        .insert(updateBlockCheckpoint)
        .onConflict('job_name')
        .merge()
        .transacting(trx);
    });
  }

  // handle Instantiate Msgs
  async handleInstantiateMsgs(
    msgsInstantiate: SmartContractEvent[],
    trx: Knex.Transaction
  ) {
    const cw721Contracts: any[] = await SmartContract.query()
      .transacting(trx)
      .withGraphJoined('code')
      .whereIn(
        'smart_contract.address',
        msgsInstantiate.map((msg) => msg.contractAddress)
      )
      .andWhere('code.type', 'CW721')
      .select(
        'smart_contract.address as contract_address',
        'smart_contract.id as id'
      );
    if (cw721Contracts.length > 0) {
      const contractsInfo = _.keyBy(
        await CW721Contract.getContractsInfo(
          cw721Contracts.map((cw721Contract) => cw721Contract.contract_address)
        ),
        'address'
      );
      const instantiateContracts = cw721Contracts.map((cw721Contract) => {
        const contractInfo = contractsInfo[cw721Contract.contract_address];
        return CW721Contract.fromJson({
          contract_id: cw721Contract.id,
          symbol: contractInfo?.symbol,
          minter: contractInfo?.minter,
          name: contractInfo?.name,
          track: true,
        });
      });
      await CW721Contract.query().transacting(trx).insert(instantiateContracts);
    }
  }

  // handle Cw721 Msg Execute
  async handleCw721MsgExec(
    cw721MsgsExecute: SmartContractEvent[],
    trx: Knex.Transaction
  ) {
    // init cw721Activities status
    const cw721Activities: CW721Activity[] = [];
    // init cw721 tokens status
    const tokensKeyBy = _.keyBy(
      await CW721Token.query()
        .transacting(trx)
        .withGraphJoined('contract.smart_contract')
        .whereIn(
          ['contract:smart_contract.address', 'token_id'],
          cw721MsgsExecute.map((msg) => [
            msg.contractAddress,
            getAttributeFrom(
              msg.attributes,
              EventAttribute.ATTRIBUTE_KEY.TOKEN_ID
            ) || null,
          ])
        ),
      (o) => `${o.contract.smart_contract.address}_${o.token_id}`
    );
    const trackedCw721ContractsByAddr = _.keyBy(
      await CW721Contract.getCw721TrackedContracts(
        cw721MsgsExecute.map((msg) => msg.contractAddress),
        trx
      ),
      'address'
    );
    // construct cw721 handler object
    const cw721Handler = new Cw721Handler(
      tokensKeyBy,
      cw721Activities,
      trackedCw721ContractsByAddr,
      cw721MsgsExecute
    );
    // cw721 handler process msgs
    cw721Handler.process();
    return {
      tokens: Object.values(cw721Handler.tokensKeyBy),
      cw721Activities: cw721Handler.cw721Activities,
      cw721Contracts: Object.values(cw721Handler.trackedCw721ContractsByAddr),
    };
  }

  async updateTokenAndActivities(
    updatedTokens: CW721Token[],
    cw721Activities: CW721Activity[],
    trx: Knex.Transaction
  ) {
    if (updatedTokens.length > 0) {
      const tokens = await CW721Token.query()
        .transacting(trx)
        .insert(updatedTokens)
        .onConflict('id')
        .merge();
      const tokensKeyById: Dictionary<CW721Token> = _.keyBy(
        tokens,
        (o) => `${o.cw721_contract_id}_${o.token_id}`
      );
      cw721Activities.forEach((act) => {
        const token = tokensKeyById[`${act.cw721_contract_id}_${act.token_id}`];
        // eslint-disable-next-line no-param-reassign
        act.cw721_token_id = token?.id;
      });
    }
    if (cw721Activities.length > 0) {
      await CW721Activity.query()
        .transacting(trx)
        .insert(cw721Activities.map((e) => _.omit(e, 'token_id')));
    }
  }

  async updateCw721Contract(
    cw721Contracts: CW721Contract[],
    trx: Knex.Transaction
  ) {
    if (cw721Contracts.length > 0) {
      const stringListUpdates = cw721Contracts
        .map(
          (cw721Contract) =>
            `(${cw721Contract.id} ,${
              cw721Contract.total_suply
            }, '${JSON.stringify(cw721Contract.no_activities)}'::jsonb)`
        )
        .join(',');
      await knex
        .raw(
          `UPDATE cw721_contract SET total_suply = temp.total_suply, no_activities = temp.no_activities from (VALUES ${stringListUpdates}) as temp(id, total_suply, no_activities) where temp.id = cw721_contract.id`
        )
        .transacting(trx);
    }
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.JOB_CW721_UPDATE,
    jobName: BULL_JOB_NAME.JOB_CW721_UPDATE,
  })
  async jobCw721Update() {
    // get id token checkpoint
    const actCheckpoint = await BlockCheckpoint.query().findOne({
      job_name: BULL_JOB_NAME.JOB_CW721_UPDATE,
    });
    const idActCheckpoint = actCheckpoint ? actCheckpoint.height : 0;
    const newActDistinctByContract = await CW721Activity.query()
      .where('id', '>', idActCheckpoint)
      .groupBy('cw721_contract_id')
      .select('cw721_contract_id')
      .max('id as maxId');
    await knex.raw(
      `set statement_timeout to ${config.cw721.jobCw721Update.statementTimeout}`
    );
    const noHolders = await CW721Token.query()
      .where('burned', false)
      .whereIn(
        'cw721_contract_id',
        newActDistinctByContract.map((e) => e.cw721_contract_id)
      )
      .select('cw721_contract_id')
      .groupBy('cw721_contract_id')
      .countDistinct('owner');
    const stringListUpdates = noHolders
      .map((noHolder) => `(${noHolder.cw721_contract_id}, ${noHolder.count})`)
      .join(',');
    await knex.transaction(async (trx) => {
      await knex
        .raw(
          `UPDATE cw721_contract SET no_holders = temp.no_holders from (VALUES ${stringListUpdates}) as temp(id, no_holders) where temp.id = cw721_contract.id`
        )
        .transacting(trx);
      if (newActDistinctByContract.length > 0) {
        await BlockCheckpoint.query()
          .transacting(trx)
          .insert({
            job_name: BULL_JOB_NAME.JOB_CW721_UPDATE,
            height: Math.max(...newActDistinctByContract.map((e) => e.maxId)),
          })
          .onConflict(['job_name'])
          .merge();
      }
    });
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.REFRESH_CW721_STATS,
    jobName: BULL_JOB_NAME.REFRESH_CW721_STATS,
  })
  async jobHandlerRefresh(): Promise<void> {
    await this.refreshCw721Stats();
  }

  async refreshCw721Stats(): Promise<void> {
    const cw721Stats = await this.calCw721Stats();

    // Upsert cw721 stats
    await CW721ContractStats.query()
      .insert(cw721Stats)
      .onConflict('cw721_contract_id')
      .merge()
      .returning('id');
  }

  async calCw721Stats(): Promise<CW721Contract[]> {
    // Get once block height 24h ago.
    const blockSince24hAgo = await Block.query()
      .select('height')
      .where('time', '<=', knex.raw("now() - '24 hours'::interval"))
      .orderBy('height', 'desc')
      .limit(1);

    // Calculate total activity and transfer_24h of cw721
    return CW721Contract.query()
      .count('cw721_activity.id AS total_activity')
      .select(
        knex.raw(
          "SUM( CASE WHEN cw721_activity.height >= ? AND cw721_activity.action IN ('mint', 'burn', 'send_nft', 'transfer_nft') THEN 1 ELSE 0 END ) AS transfer_24h",
          blockSince24hAgo[0]?.height
        )
      )
      .select('cw721_contract.id as cw721_contract_id')
      .where('cw721_contract.track', '=', true)
      .andWhere('smart_contract.name', '!=', 'crates.io:cw4973')
      .andWhere('cw721_activity.action', '!=', '')
      .join(
        'cw721_activity',
        'cw721_contract.id',
        'cw721_activity.cw721_contract_id'
      )
      .join('smart_contract', 'cw721_contract.contract_id', 'smart_contract.id')
      .groupBy('cw721_contract.id');
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.REINDEX_CW721_HISTORY,
    jobName: BULL_JOB_NAME.REINDEX_CW721_HISTORY,
  })
  public async crawlMissingContractHistory(
    _payload: ICw721ReindexingHistoryParams
  ) {
    const { startBlock, endBlock, prevId, contractAddress, smartContractId } =
      _payload;
    // insert data from event_attribute_backup to event_attribute
    const { limitRecordGet } = config.cw721.reindexing;
    const events = await CW721Activity.getCw721ContractEvents(
      startBlock,
      endBlock,
      smartContractId,
      { limit: limitRecordGet, prevId }
    );
    if (events.length > 0) {
      await knex.transaction(async (trx) => {
        const { cw721Activities, cw721Contracts } =
          await this.handleCw721MsgExec(events, trx);
        if (cw721Activities.length > 0) {
          const tokensKeyById = _.keyBy(
            await CW721Token.query()
              .transacting(trx)
              .withGraphJoined('contract.smart_contract')
              .where('contract:smart_contract.id', smartContractId),
            (o) => `${o.cw721_contract_id}_${o.token_id}`
          );
          cw721Activities.forEach((act) => {
            const token =
              tokensKeyById[`${act.cw721_contract_id}_${act.token_id}`];
            // eslint-disable-next-line no-param-reassign
            act.cw721_token_id = token?.id;
          });
          await CW721Activity.query()
            .transacting(trx)
            .insert(cw721Activities.map((e) => _.omit(e, 'token_id')));
          if (cw721Contracts[0]) {
            await CW721Contract.query()
              .transacting(trx)
              .patch({
                no_activities: cw721Contracts[0].no_activities,
              })
              .where('contract_id', smartContractId);
          }
        }
      });
      await this.createJob(
        BULL_JOB_NAME.REINDEX_CW721_HISTORY,
        BULL_JOB_NAME.REINDEX_CW721_HISTORY,
        {
          smartContractId,
          startBlock,
          endBlock,
          prevId: events[events.length - 1].smart_contract_event_id,
          contractAddress,
        } satisfies ICw721ReindexingHistoryParams,
        {
          removeOnComplete: true,
        }
      );
    } else {
      const queue: Queue = this.getQueueManager().getQueue(
        BULL_JOB_NAME.REINDEX_CW721_CONTRACT
      );
      await queue.remove(contractAddress);
      this.logger.info('Reindex cw721 history done!!!');
    }
  }

  @Action({
    name: SERVICE.V1.Cw721.HandleRangeBlockMissingContract.key,
    params: {
      smartContractId: 'any',
      startBlock: 'any',
      endBlock: ' any',
    },
  })
  public async handleRangeBlockMissingContract(
    ctx: Context<IContextReindexingServiceHistory>
  ) {
    const { smartContractId, startBlock, endBlock } = ctx.params;
    const missingHistories = await CW721Activity.getCw721ContractEvents(
      startBlock,
      endBlock,
      smartContractId
    );
    await knex.transaction(async (trx) => {
      // handle all cw721 execute messages
      const { cw721Activities, tokens, cw721Contracts } =
        await this.handleCw721MsgExec(missingHistories, trx);
      await this.updateTokenAndActivities(tokens, cw721Activities, trx);
      await this.updateCw721Contract(cw721Contracts, trx);
    });
  }
}

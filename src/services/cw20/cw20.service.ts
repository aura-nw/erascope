import { Service } from '@ourparentcenter/moleculer-decorators-extended';
import { Knex } from 'knex';
import _ from 'lodash';
import { ServiceBroker } from 'moleculer';
import config from '../../../config.json' assert { type: 'json' };
import BullableService, { QueueHandler } from '../../base/bullable.service';
import {
  BULL_JOB_NAME,
  Config,
  IContextUpdateCw20,
  SERVICE,
} from '../../common';
import knex from '../../common/utils/db_connection';
import { getAttributeFrom } from '../../common/utils/smart_contract';
import {
  Block,
  BlockCheckpoint,
  CW20TotalHolderStats,
  Cw20Contract,
  Cw20Event,
  EventAttribute,
  IHolderEvent,
} from '../../models';
import { SmartContractEvent } from '../../models/smart_contract_event';

const { NODE_ENV } = Config;
export const CW20_ACTION = {
  MINT: 'mint',
  BURN: 'burn',
  TRANSFER: 'transfer',
  INSTANTIATE: 'instantiate',
  SEND: 'send',
  TRANSFER_FROM: 'transfer_from',
  BURN_FROM: 'burn_from',
  SEND_FROM: 'send_from',
};
@Service({
  name: SERVICE.V1.Cw20.key,
  version: 1,
})
export default class Cw20Service extends BullableService {
  _blocksPerBatch!: number;

  public constructor(public broker: ServiceBroker) {
    super(broker);
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.HANDLE_CW20,
    jobName: BULL_JOB_NAME.HANDLE_CW20,
  })
  async jobHandleCw20(): Promise<void> {
    // get range txs for proccessing
    const [startBlock, endBlock, updateBlockCheckpoint] =
      await BlockCheckpoint.getCheckpoint(
        BULL_JOB_NAME.HANDLE_CW20,
        [BULL_JOB_NAME.CRAWL_CONTRACT_EVENT],
        config.cw20.key
      );
    await this.handleStatistic(startBlock);
    this.logger.info(`startBlock: ${startBlock} to endBlock: ${endBlock}`);
    if (startBlock >= endBlock) return;
    // get all contract Msg in above range blocks
    const cw20Events = await this.getCw20ContractEvents(startBlock, endBlock);
    this.logger.info(cw20Events);
    await knex.transaction(async (trx) => {
      if (cw20Events.length > 0) {
        // handle instantiate cw20 contracts
        await this.handleCw20Instantiate(
          cw20Events.filter(
            (event) => event.action === CW20_ACTION.INSTANTIATE
          ),
          trx
        );
        // handle Cw20 Histories
        await this.handleCw20Histories(cw20Events, trx);
      }
      updateBlockCheckpoint.height = endBlock;
      await BlockCheckpoint.query()
        .transacting(trx)
        .insert(updateBlockCheckpoint)
        .onConflict('job_name')
        .merge();
    });
    const cw20Contracts = await Cw20Contract.query()
      .alias('cw20_contract')
      .withGraphJoined('smart_contract')
      .whereIn(
        'smart_contract.address',
        cw20Events.map((event) => event.contract_address)
      )
      .andWhere('track', true)
      .select(['cw20_contract.id', 'last_updated_height']);
    await this.broker.call(
      SERVICE.V1.Cw20UpdateByContract.UpdateByContract.path,
      {
        cw20Contracts,
        startBlock,
        endBlock,
      } satisfies IContextUpdateCw20
    );
  }

  // insert new cw20 contract + instantiate holders
  async handleCw20Instantiate(
    cw20InstantiateEvents: SmartContractEvent[],
    trx: Knex.Transaction
  ) {
    if (cw20InstantiateEvents.length > 0) {
      const contractsInfo = await Cw20Contract.getContractsInfo(
        cw20InstantiateEvents.map((event) => event.contract_address)
      );
      const instantiateContracts = await Promise.all(
        cw20InstantiateEvents.map(async (event) => {
          const contractInfo = contractsInfo.find(
            (result) => result.address === event.contract_address
          );
          let track = true;
          let initBalances: IHolderEvent[] = [];
          // get init address holder, init amount
          try {
            initBalances = await Cw20Contract.getInstantiateBalances(
              event.contract_address
            );
          } catch (error) {
            track = false;
          }
          const lastUpdatedHeight =
            initBalances.length > 0
              ? Math.min(...initBalances.map((e) => e.event_height))
              : 0;
          return {
            ...Cw20Contract.fromJson({
              smart_contract_id: event.smart_contract_id,
              symbol: contractInfo?.symbol,
              minter: contractInfo?.minter,
              marketing_info: contractInfo?.marketing_info,
              name: contractInfo?.name,
              total_supply: initBalances.reduce(
                (acc: string, curr: { address: string; amount: string }) =>
                  (BigInt(acc) + BigInt(curr.amount)).toString(),
                '0'
              ),
              track,
              decimal: contractInfo?.decimal,
              last_updated_height: lastUpdatedHeight,
            }),
            holders: initBalances.map((e) => ({
              address: e.address,
              amount: e.amount,
              last_updated_height: e.event_height,
            })),
          };
        })
      );
      await Cw20Contract.query()
        .insertGraph(instantiateContracts)
        .transacting(trx);
    }
  }

  async handleCw20Histories(
    cw20Events: SmartContractEvent[],
    trx: Knex.Transaction
  ) {
    // get all related cw20_contract in DB for updating total_supply
    const cw20Contracts = await Cw20Contract.query()
      .transacting(trx)
      .withGraphJoined('smart_contract')
      .whereIn(
        'smart_contract.address',
        cw20Events.map((event) => event.contract_address)
      )
      .andWhere('track', true);
    const cw20ContractsByAddress = _.keyBy(
      cw20Contracts,
      (e) => `${e.smart_contract.address}`
    );
    // insert new histories
    const newHistories = cw20Events
      .filter((event) => cw20ContractsByAddress[event.contract_address]?.id)
      .map((event) =>
        Cw20Event.fromJson({
          smart_contract_event_id: event.smart_contract_event_id,
          sender: event.sender,
          action: event.action,
          cw20_contract_id: cw20ContractsByAddress[event.contract_address].id,
          amount: getAttributeFrom(
            event.attributes,
            EventAttribute.ATTRIBUTE_KEY.AMOUNT
          ),
          from: getAttributeFrom(
            event.attributes,
            EventAttribute.ATTRIBUTE_KEY.FROM
          ),
          to: getAttributeFrom(
            event.attributes,
            EventAttribute.ATTRIBUTE_KEY.TO
          ),
          height: event.height,
        })
      );
    if (newHistories.length > 0) {
      await Cw20Event.query().insert(newHistories).transacting(trx);
    }
  }

  async getCw20ContractEvents(startBlock: number, endBlock: number) {
    return SmartContractEvent.query()
      .alias('smart_contract_event')
      .withGraphJoined(
        '[message(selectMessage), tx(selectTransaction), attributes(selectAttribute), smart_contract(selectSmartContract).code(selectCode)]'
      )
      .modifiers({
        selectCode(builder) {
          builder.select('type');
        },
        selectTransaction(builder) {
          builder.select('hash', 'height');
        },
        selectMessage(builder) {
          builder.select('sender', 'content');
        },
        selectAttribute(builder) {
          builder.select('key', 'value');
        },
        selectSmartContract(builder) {
          builder.select('address', 'id');
        },
      })
      .where('smart_contract:code.type', 'CW20')
      .where('tx.height', '>', startBlock)
      .andWhere('tx.height', '<=', endBlock)
      .select(
        'message.sender as sender',
        'smart_contract.address as contract_address',
        'smart_contract_event.action',
        'smart_contract_event.event_id as event_id',
        'smart_contract_event.index',
        'smart_contract.id as smart_contract_id',
        'tx.height as height',
        'smart_contract_event.id as smart_contract_event_id'
      )
      .orderBy('smart_contract_event.id', 'asc');
  }

  async handleStatistic(startBlock: number) {
    const systemDate = (
      await Block.query().where('height', startBlock).first().throwIfNotFound()
    ).time;
    const lastUpdatedDate = (
      await CW20TotalHolderStats.query().max('date').first()
    )?.max;
    if (lastUpdatedDate) {
      systemDate.setHours(0, 0, 0, 0);
      lastUpdatedDate.setHours(0, 0, 0, 0);
      if (systemDate > lastUpdatedDate) {
        await this.handleTotalHolderStatistic(systemDate);
      }
    } else {
      await this.handleTotalHolderStatistic(systemDate);
    }
  }

  async handleTotalHolderStatistic(systemDate: Date) {
    const totalHolder = await Cw20Contract.query()
      .alias('cw20_contract')
      .joinRelated('holders')
      .where('cw20_contract.track', true)
      .andWhere('holders.amount', '>', 0)
      .count()
      .groupBy('holders.cw20_contract_id')
      .select('holders.cw20_contract_id');
    if (totalHolder.length > 0) {
      await CW20TotalHolderStats.query().insert(
        totalHolder.map((e) =>
          CW20TotalHolderStats.fromJson({
            cw20_contract_id: e.cw20_contract_id,
            total_holder: e.count,
            date: systemDate,
          })
        )
      );
    }
  }

  async _start(): Promise<void> {
    if (NODE_ENV !== 'test') {
      await this.broker.waitForServices(SERVICE.V1.Cw20UpdateByContract.name);
      await this.createJob(
        BULL_JOB_NAME.HANDLE_CW20,
        BULL_JOB_NAME.HANDLE_CW20,
        {},
        {
          removeOnComplete: true,
          removeOnFail: {
            count: 3,
          },
          repeat: {
            every: config.cw20.millisecondRepeatJob,
          },
        }
      );
    }
    return super._start();
  }
}

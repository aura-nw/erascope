import { Service } from '@ourparentcenter/moleculer-decorators-extended';
import { ServiceBroker } from 'moleculer';
import { PublicClient, getContract } from 'viem';
import { Knex } from 'knex';
import _ from 'lodash';
import config from '../../../config.json' assert { type: 'json' };
import '../../../fetch-polyfill.js';
import BullableService, { QueueHandler } from '../../base/bullable.service';
import { BULL_JOB_NAME, SERVICE } from '../../common';
import knex from '../../common/utils/db_connection';
import EtherJsClient from '../../common/utils/etherjs_client';
import { BlockCheckpoint, EVMSmartContract, EvmEvent } from '../../models';
import { Erc20Activity } from '../../models/erc20_activity';
import { Erc20Contract } from '../../models/erc20_contract';
import { ERC20_EVENT_TOPIC0, Erc20Handler } from './erc20_handler';

@Service({
  name: SERVICE.V1.Erc20.key,
  version: 1,
})
export default class Erc20Service extends BullableService {
  etherJsClient!: PublicClient;

  public constructor(public broker: ServiceBroker) {
    super(broker);
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.HANDLE_ERC20_CONTRACT,
    jobName: BULL_JOB_NAME.HANDLE_ERC20_CONTRACT,
  })
  async handleErc20Contract(): Promise<void> {
    await knex.transaction(async (trx) => {
      // get id evm smart contract checkpoint
      // get range blocks for proccessing
      const [startBlock, endBlock, updateBlockCheckpoint] =
        await BlockCheckpoint.getCheckpoint(
          BULL_JOB_NAME.HANDLE_ERC20_CONTRACT,
          [BULL_JOB_NAME.CRAWL_SMART_CONTRACT_EVM],
          config.erc20.key
        );
      const erc20SmartContracts = await EVMSmartContract.query()
        .where('created_height', '>', startBlock)
        .andWhere('created_height', '<=', endBlock)
        .andWhere('type', EVMSmartContract.TYPES.ERC20)
        .orderBy('id', 'asc');
      if (erc20SmartContracts.length > 0) {
        const erc20Instances = await this.getErc20Instances(
          erc20SmartContracts
        );
        await Erc20Contract.query().transacting(trx).insert(erc20Instances);
      }
      updateBlockCheckpoint.height = endBlock;
      await BlockCheckpoint.query()
        .insert(updateBlockCheckpoint)
        .onConflict('job_name')
        .merge()
        .transacting(trx);
    });
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.HANDLE_ERC20_ACTIVITY,
    jobName: BULL_JOB_NAME.HANDLE_ERC20_ACTIVITY,
  })
  async handleErc20Activity(): Promise<void> {
    await knex.transaction(async (trx) => {
      const [startBlock, endBlock, updateBlockCheckpoint] =
        await BlockCheckpoint.getCheckpoint(
          BULL_JOB_NAME.HANDLE_ERC20_ACTIVITY,
          [BULL_JOB_NAME.HANDLE_ERC20_CONTRACT],
          config.erc20.key
        );
      // TODO: handle track erc20 contract only
      const erc20Events = await EvmEvent.query()
        .transacting(trx)
        .joinRelated('[evm_smart_contract,evm_transaction]')
        .where('evm_event.block_height', '>', startBlock)
        .andWhere('evm_event.block_height', '<=', endBlock)
        .andWhere('evm_smart_contract.type', EVMSmartContract.TYPES.ERC20)
        .orderBy('evm_event.id', 'asc')
        .select(
          'evm_event.*',
          'evm_transaction.from as sender',
          'evm_smart_contract.id as evm_smart_contract_id'
        );
      await this.handleMissingErc20Contract(erc20Events, trx);
      const erc20Activities: Erc20Activity[] = [];
      erc20Events.forEach((e) => {
        if (e.topic0 === ERC20_EVENT_TOPIC0.TRANSFER) {
          const activity = Erc20Handler.buildTransferActivity(e);
          if (activity) {
            erc20Activities.push(activity);
          }
        } else if (e.topic0 === ERC20_EVENT_TOPIC0.APPROVAL) {
          const activity = Erc20Handler.buildApprovalActivity(e);
          if (activity) {
            erc20Activities.push(activity);
          }
        }
      });
      if (erc20Activities.length > 0) {
        await knex
          .batchInsert(
            'erc20_activity',
            erc20Activities,
            config.erc20.chunkSizeInsert
          )
          .transacting(trx);
      }
      updateBlockCheckpoint.height = endBlock;
      await BlockCheckpoint.query()
        .insert(updateBlockCheckpoint)
        .onConflict('job_name')
        .merge()
        .transacting(trx);
    });
  }

  async handleMissingErc20Contract(events: EvmEvent[], trx: Knex.Transaction) {
    const eventsUniqByAddress = _.keyBy(events, (e) => e.address);
    const addresses = Object.keys(eventsUniqByAddress);
    const erc20ContractsByAddress = _.keyBy(
      await Erc20Contract.query()
        .whereIn('address', addresses)
        .transacting(trx),
      (e) => e.address
    );
    const missingErc20ContractsAddress: string[] = [];
    addresses.forEach((e) => {
      if (!erc20ContractsByAddress[e]) {
        missingErc20ContractsAddress.push(e);
      }
    });
    if (missingErc20ContractsAddress.length > 0) {
      const erc20ContractsInfo = await this.getBatchErc20Info(
        missingErc20ContractsAddress as `0x${string}`[]
      );
      await Erc20Contract.query()
        .insert(
          missingErc20ContractsAddress.map((e, index) =>
            Erc20Contract.fromJson({
              evm_smart_contract_id:
                eventsUniqByAddress[e].evm_smart_contract_id,
              address: e,
              total_supply: erc20ContractsInfo[index].totalSupply,
              symbol: erc20ContractsInfo[index].symbol,
              decimal: erc20ContractsInfo[index].decimals,
              name: erc20ContractsInfo[index].name,
              track: true,
              last_updated_height: -1,
            })
          )
        )
        .transacting(trx);
    }
  }

  async getErc20Instances(evmSmartContracts: EVMSmartContract[]) {
    const addresses = evmSmartContracts.map((e) => e.address);
    const erc20ContractsInfo = await this.getBatchErc20Info(
      addresses as `0x${string}`[]
    );
    return evmSmartContracts.map((e, index) =>
      Erc20Contract.fromJson({
        evm_smart_contract_id: evmSmartContracts[index].id,
        address: e.address,
        total_supply: erc20ContractsInfo[index].totalSupply,
        symbol: erc20ContractsInfo[index].symbol,
        decimal: erc20ContractsInfo[index].decimals,
        name: erc20ContractsInfo[index].name,
        track: true,
        last_updated_height: e.created_height,
      })
    );
  }

  async getBatchErc20Info(addresses: `0x${string}`[]) {
    const viemClient = EtherJsClient.getViemClient();
    const contracts = addresses.map((address) =>
      getContract({
        address,
        abi: Erc20Contract.ABI,
        client: viemClient,
      })
    );
    const batchReqs: any[] = [];
    contracts.forEach((e) => {
      batchReqs.push(
        e.read.name().catch(() => Promise.resolve(undefined)),
        e.read.symbol().catch(() => Promise.resolve(undefined)),
        e.read.decimals().catch(() => Promise.resolve(undefined)),
        e.read.totalSupply().catch(() => Promise.resolve(undefined))
      );
    });
    const results = await Promise.all(batchReqs);
    return addresses.map((address, index) => ({
      address,
      name: results[4 * index],
      symbol: results[4 * index + 1],
      decimals: results[4 * index + 2],
      totalSupply: results[4 * index + 3]?.toString(),
    }));
  }

  public async _start(): Promise<void> {
    await this.createJob(
      BULL_JOB_NAME.HANDLE_ERC20_CONTRACT,
      BULL_JOB_NAME.HANDLE_ERC20_CONTRACT,
      {},
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
        repeat: {
          every: config.erc20.millisecondRepeatJob,
        },
      }
    );
    await this.createJob(
      BULL_JOB_NAME.HANDLE_ERC20_ACTIVITY,
      BULL_JOB_NAME.HANDLE_ERC20_ACTIVITY,
      {},
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
        repeat: {
          every: config.erc20.millisecondRepeatJob,
        },
      }
    );
    return super._start();
  }
}

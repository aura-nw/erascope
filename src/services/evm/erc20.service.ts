import {
  Action,
  Service,
} from '@ourparentcenter/moleculer-decorators-extended';
import { Knex } from 'knex';
import _ from 'lodash';
import { Context, ServiceBroker } from 'moleculer';
import { PublicClient, getContract } from 'viem';
import config from '../../../config.json' assert { type: 'json' };
import '../../../fetch-polyfill.js';
import BullableService, { QueueHandler } from '../../base/bullable.service';
import { SERVICE as COSMOS_SERVICE } from '../../common';
import knex from '../../common/utils/db_connection';
import EtherJsClient from '../../common/utils/etherjs_client';
import { BlockCheckpoint, EVMSmartContract, EvmEvent } from '../../models';
import { AccountBalance } from '../../models/account_balance';
import { Erc20Activity } from '../../models/erc20_activity';
import { Erc20Contract } from '../../models/erc20_contract';
import { BULL_JOB_NAME, SERVICE as EVM_SERVICE, SERVICE } from './constant';
import { ERC20_EVENT_TOPIC0, Erc20Handler } from './erc20_handler';
import { convertEthAddressToBech32Address } from './utils';

@Service({
  name: EVM_SERVICE.V1.Erc20.key,
  version: 1,
})
export default class Erc20Service extends BullableService {
  viemClient!: PublicClient;

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
        .transacting(trx)
        .where('created_height', '>', startBlock)
        .andWhere('created_height', '<=', endBlock)
        .andWhere('type', EVMSmartContract.TYPES.ERC20)
        .orderBy('id', 'asc');
      if (erc20SmartContracts.length > 0) {
        const erc20Instances = await this.getErc20Instances(
          erc20SmartContracts
        );
        this.logger.info(
          `Crawl Erc20 contract from block ${startBlock} to block ${endBlock}:\n ${JSON.stringify(
            erc20Instances
          )}`
        );
        await Erc20Contract.query()
          .transacting(trx)
          .insert(erc20Instances)
          .onConflict(['address'])
          .merge();
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
          [
            BULL_JOB_NAME.HANDLE_ERC20_CONTRACT,
            BULL_JOB_NAME.HANDLE_EVM_PROXY_HISTORY,
          ],
          config.erc20.key
        );
      // TODO: handle track erc20 contract only
      const erc20Events = await EvmEvent.query()
        .transacting(trx)
        .joinRelated('[evm_smart_contract,evm_transaction]')
        .innerJoin(
          'erc20_contract',
          'evm_event.address',
          'erc20_contract.address'
        )
        .where('evm_event.block_height', '>', startBlock)
        .andWhere('evm_event.block_height', '<=', endBlock)
        .orderBy('evm_event.id', 'asc')
        .select(
          'evm_event.*',
          'evm_transaction.from as sender',
          'evm_smart_contract.id as evm_smart_contract_id',
          'evm_transaction.id as evm_tx_id'
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
        this.logger.info(
          `Crawl Erc20 activity from block ${startBlock} to block ${endBlock}:\n ${JSON.stringify(
            erc20Activities
          )}`
        );
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

  @QueueHandler({
    queueName: BULL_JOB_NAME.HANDLE_ERC20_BALANCE,
    jobName: BULL_JOB_NAME.HANDLE_ERC20_BALANCE,
  })
  async handleErc20Balance(): Promise<void> {
    const [startBlock, endBlock, updateBlockCheckpoint] =
      await BlockCheckpoint.getCheckpoint(
        BULL_JOB_NAME.HANDLE_ERC20_BALANCE,
        [BULL_JOB_NAME.HANDLE_ERC20_ACTIVITY],
        config.erc20.key
      );
    // get Erc20 activities
    let erc20Activities = await this.getErc20Activities(startBlock, endBlock);
    // get missing Account
    const missingAccountsAddress = Array.from(
      new Set(
        (
          [
            ...erc20Activities
              .filter((e) => !e.from_account_id)
              .map((e) => e.from),
            ...erc20Activities.filter((e) => !e.to_account_id).map((e) => e.to),
          ] as string[]
        ).map((e) =>
          convertEthAddressToBech32Address(config.networkPrefixAddress, e)
        )
      )
    );
    if (missingAccountsAddress.length > 0) {
      try {
        // crawl missing Account and requery erc20Activities
        await this.broker.call(
          COSMOS_SERVICE.V1.HandleAddressService.CrawlNewAccountApi.path,
          {
            addresses: missingAccountsAddress,
          }
        );
        erc20Activities = await this.getErc20Activities(startBlock, endBlock);
      } catch (error) {
        this.logger.error(
          `Unable crawl missing account: ${  missingAccountsAddress}`
        );
      }
    }
    await knex.transaction(async (trx) => {
      if (erc20Activities.length > 0) {
        const accountBalances = _.keyBy(
          await AccountBalance.query()
            .transacting(trx)
            .joinRelated('account')
            .whereIn(
              ['account.evm_address', 'denom'],
              [
                ...erc20Activities.map((e) => [
                  e.from,
                  e.erc20_contract_address,
                ]),
                ...erc20Activities.map((e) => [e.to, e.erc20_contract_address]),
              ]
            ),
          (o) => `${o.account_id}_${o.denom}`
        );
        // construct cw721 handler object
        const erc20Handler = new Erc20Handler(accountBalances, erc20Activities);
        erc20Handler.process();
        const updatedAccountBalances = Object.values(
          erc20Handler.accountBalances
        );
        if (updatedAccountBalances.length > 0) {
          await AccountBalance.query()
            .transacting(trx)
            .insert(updatedAccountBalances)
            .onConflict(['account_id', 'denom'])
            .merge();
        }
      }
      updateBlockCheckpoint.height = endBlock;
      await BlockCheckpoint.query()
        .insert(updateBlockCheckpoint)
        .onConflict('job_name')
        .merge()
        .transacting(trx);
    });
  }

  @Action({
    name: SERVICE.V1.Erc20.insertNewErc20Contracts.key,
    params: {
      evmSmartContracts: 'any[]',
    },
  })
  async insertNewErc20Contracts(
    ctx: Context<{
      evmSmartContracts: {
        id: number;
        address: string;
      }[];
    }>
  ) {
    const { evmSmartContracts } = ctx.params;
    if (evmSmartContracts.length > 0) {
      const currentHeight = await this.viemClient.getBlockNumber();
      const erc20Instances = await this.getErc20Instances(
        evmSmartContracts.map((e) =>
          EVMSmartContract.fromJson({
            ...e,
            created_height: currentHeight.toString(),
          })
        )
      );
      this.logger.info(
        `New Erc20 Instances:\n ${JSON.stringify(erc20Instances)}`
      );
      await Erc20Contract.query()
        .insert(erc20Instances)
        .onConflict(['address'])
        .merge();
    }
  }

  async getErc20Activities(
    startBlock: number,
    endBlock: number
  ): Promise<Erc20Activity[]> {
    return Erc20Activity.query()
      .leftJoin(
        'account as from_account',
        'erc20_activity.from',
        'from_account.evm_address'
      )
      .leftJoin(
        'account as to_account',
        'erc20_activity.to',
        'to_account.evm_address'
      )
      .leftJoin(
        'erc20_contract as erc20_contract',
        'erc20_activity.erc20_contract_address',
        'erc20_contract.address'
      )
      .where('erc20_activity.height', '>', startBlock)
      .andWhere('erc20_activity.height', '<=', endBlock)
      .andWhere('erc20_contract.track', true)
      .select(
        'erc20_activity.*',
        'from_account.id as from_account_id',
        'to_account.id as to_account_id'
      )
      .orderBy('erc20_activity.id');
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
    const missingErc20ContractsAddress: string[] = addresses.filter(
      (addr) => !erc20ContractsByAddress[addr]
    );
    if (missingErc20ContractsAddress.length > 0) {
      const erc20ContractsInfo = await this.getBatchErc20Info(
        missingErc20ContractsAddress as `0x${string}`[]
      );
      await Erc20Contract.query()
        .insert(
          missingErc20ContractsAddress.map((addr, index) =>
            Erc20Contract.fromJson({
              evm_smart_contract_id:
                eventsUniqByAddress[addr].evm_smart_contract_id,
              address: addr,
              total_supply: erc20ContractsInfo[index].totalSupply,
              symbol: erc20ContractsInfo[index].symbol,
              decimal: erc20ContractsInfo[index].decimals,
              name: erc20ContractsInfo[index].name,
              track: false,
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
    const contracts = addresses.map((address) =>
      getContract({
        address,
        abi: Erc20Contract.ABI,
        client: this.viemClient,
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
    this.viemClient = EtherJsClient.getViemClient();
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
    await this.createJob(
      BULL_JOB_NAME.HANDLE_ERC20_BALANCE,
      BULL_JOB_NAME.HANDLE_ERC20_BALANCE,
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

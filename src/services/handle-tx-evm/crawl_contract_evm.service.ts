import { Service } from '@ourparentcenter/moleculer-decorators-extended';
import { ServiceBroker } from 'moleculer';
import _ from 'lodash';
import { ethers } from 'ethers';
import EtherJsClient from '../../common/utils/etherjs_client';
import {
  BlockCheckpoint,
  EVMSmartContract,
  EVMTransaction,
} from '../../models';
import { BULL_JOB_NAME, SERVICE } from '../../common';
import BullableService, { QueueHandler } from '../../base/bullable.service';
import config from '../../../config.json' assert { type: 'json' };
import knex from '../../common/utils/db_connection';
import { EVM_CONTRACT_METHOD_HEX_PREFIX } from './constant';

@Service({
  name: SERVICE.V1.CrawlSmartContractEVM.key,
  version: 1,
})
export default class CrawlSmartContractEVMService extends BullableService {
  etherJsClient!: ethers.AbstractProvider;

  public constructor(public broker: ServiceBroker) {
    super(broker);
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_SMART_CONTRACT_EVM,
    jobName: BULL_JOB_NAME.CRAWL_SMART_CONTRACT_EVM,
  })
  async jobHandler() {
    const [startBlock, endBlock, blockCheckpoint] =
      await BlockCheckpoint.getCheckpoint(
        BULL_JOB_NAME.CRAWL_SMART_CONTRACT_EVM,
        [BULL_JOB_NAME.JOB_CRAWL_EVM_EVENT],
        config.crawlSmartContractEVM.key
      );
    this.logger.info(
      `Crawl EVM smart contract from block ${startBlock} to block ${endBlock}`
    );
    if (startBlock >= endBlock) {
      return;
    }

    const evmTxs = await EVMTransaction.query()
      .leftJoin('evm_event as evm_events', function () {
        this.on('evm_transaction.id', '=', 'evm_events.evm_tx_id').andOn(
          'evm_transaction.height',
          '=',
          'evm_events.block_height'
        );
      })
      .select(
        'evm_transaction.height',
        'evm_transaction.hash',
        'evm_transaction.from',
        'evm_transaction.to',
        'evm_transaction.contract_address',
        'evm_transaction.data',
        knex.raw('ARRAY_AGG(evm_events.address) as event_address')
      )
      .where('evm_transaction.height', '>', startBlock)
      .andWhere('evm_transaction.height', '<=', endBlock)
      .groupBy('evm_transaction.id')
      .orderBy('evm_transaction.id', 'ASC')
      .orderBy('evm_transaction.height', 'ASC');

    let addresses: string[] = [];
    const addressesWithTx: any = [];
    evmTxs.forEach((evmTx: any) => {
      let currentAddresses: string[] = [];
      ['from', 'to', 'contract_address'].forEach((key) => {
        if (evmTx[key] && evmTx[key].startsWith('0x')) {
          currentAddresses.push(evmTx[key]);
        }
      });

      if (evmTx.event_address.length > 0 && evmTx.event_address[0] != null) {
        currentAddresses.push(...evmTx.event_address);
      }
      currentAddresses = _.uniq(currentAddresses);
      addresses.push(...currentAddresses);
      addressesWithTx[evmTx.hash] = currentAddresses;
    });

    addresses = _.uniq(addresses);

    const evmContracts: EVMSmartContract[] = [];

    const evmContractsInDB: EVMSmartContract[] = await EVMSmartContract.query()
      .select('address')
      .whereIn('address', addresses);

    const evmContractsWithAddress: any = [];
    evmContractsInDB.forEach((evmContract) => {
      evmContractsWithAddress[evmContract.address] = evmContract;
    });

    await Promise.all(
      evmTxs.map(async (evmTx) => {
        const currentAddresses = addressesWithTx[evmTx.hash];

        const notFoundAddresses = currentAddresses.filter(
          (address: string) => !evmContractsInDB[address]
        );

        if (notFoundAddresses.length === 0) {
          return;
        }

        await Promise.all(
          notFoundAddresses.map(async (address: string) => {
            const code = await this.etherJsClient.getCode(address);

            // check if this address has code -> is smart contract
            if (code !== '0x') {
              // check if this event belongs to smart contract creation tx
              let creator;
              let createdHeight;
              let createdHash;
              if (evmTx.data) {
                const { data } = evmTx;
                if (
                  data.startsWith(
                    EVM_CONTRACT_METHOD_HEX_PREFIX.CREATE_CONTRACT
                  )
                ) {
                  creator = evmTx.from;
                  createdHeight = evmTx.height;
                  createdHash = evmTx.hash;
                }
              }
              evmContracts.push(
                EVMSmartContract.fromJson({
                  address,
                  creator,
                  created_hash: createdHash,
                  created_height: createdHeight,
                })
              );
            }
          })
        );
      })
    );

    await knex.transaction(async (trx) => {
      if (evmContracts.length > 0) {
        await EVMSmartContract.query()
          .insert(evmContracts)
          .onConflict('address')
          .ignore()
          .transacting(trx);
      }
      if (blockCheckpoint) {
        blockCheckpoint.height = endBlock;

        await BlockCheckpoint.query()
          .insert(blockCheckpoint)
          .onConflict('job_name')
          .merge()
          .returning('id')
          .transacting(trx);
      }
    });
  }

  public async _start(): Promise<void> {
    this.etherJsClient = new EtherJsClient().etherJsClient;
    this.createJob(
      BULL_JOB_NAME.CRAWL_SMART_CONTRACT_EVM,
      BULL_JOB_NAME.CRAWL_SMART_CONTRACT_EVM,
      {},
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
        repeat: {
          every: config.crawlSmartContractEVM.millisecondCrawl,
        },
      }
    );
    return super._start();
  }
}

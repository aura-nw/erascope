/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable no-param-reassign */
/* eslint-disable no-await-in-loop */
/* eslint-disable import/no-extraneous-dependencies */
import {
  Action,
  Service,
} from '@ourparentcenter/moleculer-decorators-extended';
import { Context, ServiceBroker } from 'moleculer';
import { fromUtf8 } from '@cosmjs/encoding';
import { HttpBatchClient } from '@cosmjs/tendermint-rpc';
import _ from 'lodash';
import Long from 'long';
import { Knex } from 'knex';
import knex from '../../common/utils/db_connection';
import {
  BlockCheckpoint,
  Event,
  Transaction,
  EventAttribute,
  SmartContract,
  Code,
} from '../../models';
import {
  BULL_JOB_NAME,
  getHttpBatchClient,
  IContextInstantiateContracts,
  IInstantiateContracts,
  IMigrateContracts,
  IStoreCodes,
  SERVICE,
} from '../../common';
import config from '../../../config.json' assert { type: 'json' };
import BullableService, { QueueHandler } from '../../base/bullable.service';

@Service({
  name: SERVICE.V1.CrawlSmartContractService.key,
  version: 1,
})
export default class CrawlSmartContractService extends BullableService {
  private _httpBatchClient: HttpBatchClient;

  public constructor(public broker: ServiceBroker) {
    super(broker);
    this._httpBatchClient = getHttpBatchClient();
  }

  @Action({
    name: SERVICE.V1.CrawlSmartContractService.CrawlMissingContract.key,
    params: {
      contracts: 'any[]',
    },
  })
  private async actionCrawlMissingContract(
    ctx: Context<IContextInstantiateContracts>
  ) {
    let instantiatedContracts: SmartContract[] | void = [];
    await knex.transaction(async (trx) => {
      instantiatedContracts = await this.insertNewContracts(
        ctx.params.contracts,
        trx
      );
    });
    return instantiatedContracts;
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_SMART_CONTRACT,
    jobName: BULL_JOB_NAME.CRAWL_SMART_CONTRACT,
    // prefix: `horoscope-v2-${config.chainId}`,
  })
  public async handleJob(_payload: object): Promise<void> {
    const [startHeight, endHeight, updateBlockCheckpoint] =
      await BlockCheckpoint.getCheckpoint(
        BULL_JOB_NAME.CRAWL_SMART_CONTRACT,
        [BULL_JOB_NAME.CRAWL_CODE],
        config.crawlSmartContract.key
      );
    this.logger.info(`startHeight: ${startHeight}, endHeight: ${endHeight}`);
    if (startHeight >= endHeight) return;

    const contracts: IInstantiateContracts[] = [];
    const resultTx = await Transaction.query()
      .joinRelated('events.[attributes]')
      .where('events.type', Event.EVENT_TYPE.INSTANTIATE)
      .andWhere(
        'events:attributes.key',
        EventAttribute.ATTRIBUTE_KEY._CONTRACT_ADDRESS
      )
      .andWhere('transaction.height', '>', startHeight)
      .andWhere('transaction.height', '<=', endHeight)
      .andWhere('transaction.code', 0)
      .select(
        'transaction.hash',
        'transaction.height',
        'events:attributes.value'
      );

    if (resultTx.length > 0)
      resultTx.map((res: any) =>
        contracts.push({
          address: res.value,
          hash: res.hash,
          height: res.height,
        })
      );

    await knex
      .transaction(async (trx) => {
        await this.insertNewContracts(contracts, trx);

        updateBlockCheckpoint.height = endHeight;
        await BlockCheckpoint.query()
          .insert(updateBlockCheckpoint)
          .onConflict('job_name')
          .merge()
          .returning('id')
          .transacting(trx);
      })
      .catch((error) => {
        this.logger.error(error);
        throw error;
      });
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.HANDLE_MIGRATE_CONTRACT,
    jobName: BULL_JOB_NAME.HANDLE_MIGRATE_CONTRACT,
    // prefix: `horoscope-v2-${config.chainId}`,
  })
  public async handleMigrateContract(_payload: object): Promise<void> {
    const [startHeight, endHeight, updateBlockCheckpoint] =
      await BlockCheckpoint.getCheckpoint(
        BULL_JOB_NAME.HANDLE_MIGRATE_CONTRACT,
        [BULL_JOB_NAME.CRAWL_CODE],
        config.crawlSmartContract.key
      );
    this.logger.info(`startHeight: ${startHeight}, endHeight: ${endHeight}`);
    if (startHeight >= endHeight) return;

    const contracts: IMigrateContracts[] = [];
    const resultTx = await Transaction.query()
      .joinRelated('events.[attributes]')
      .where('events.type', Event.EVENT_TYPE.MIGRATE)
      .andWhere('transaction.height', '>', startHeight)
      .andWhere('transaction.height', '<=', endHeight)
      .andWhere('transaction.code', 0)
      .select(
        'transaction.hash',
        'transaction.height',
        'events:attributes.event_id',
        'events:attributes.key',
        'events:attributes.value'
      );

    if (resultTx.length > 0) {
      resultTx.forEach((res: any) => {
        if (res.key === EventAttribute.ATTRIBUTE_KEY._CONTRACT_ADDRESS)
          contracts.push({
            address: res.value,
            codeId: resultTx.find(
              (rs) =>
                rs.event_id === res.event_id &&
                rs.key === EventAttribute.ATTRIBUTE_KEY.CODE_ID
            )?.value,
            hash: res.hash,
            height: res.height,
          });
      });
    }

    if (contracts.length > 0) {
      const [migratedCodeContracts, migratingContracts] = await Promise.all([
        SmartContract.query().whereIn(
          'code_id',
          contracts.map((contract) => contract.codeId)
        ),
        SmartContract.query().whereIn(
          'address',
          contracts.map((contract) => contract.address)
        ),
      ]);

      const migratedContracts: SmartContract[] = [];
      migratingContracts.forEach((contract) => {
        const instantiateTx = contracts.find(
          (con) => con.address === contract.address
        );
        const codeContract = migratedCodeContracts.find(
          (con) =>
            con.code_id.toString() ===
            contracts.find((con) => con.address === contract.address)!.codeId
        );

        const migrateContract = SmartContract.fromJson({
          name: codeContract ? codeContract.name : '',
          address: contract.address,
          creator: contract.creator,
          code_id: instantiateTx ? instantiateTx.codeId : 0,
          status: SmartContract.STATUS.LATEST,
          instantiate_hash: instantiateTx ? instantiateTx.hash : '',
          instantiate_height: instantiateTx ? instantiateTx.height : 0,
          version: codeContract ? codeContract.version : '',
        });

        contract.status = SmartContract.STATUS.MIGRATED;

        migratedContracts.push(...[migrateContract, contract]);
      });

      if (
        migratedContracts.filter((contract) => contract.name === '').length > 0
      ) {
        const contractCw2s = await SmartContract.getMigratedContractData(
          migratedContracts
            .filter((contract) => contract.name === '')
            .map((contract) => contract.address),
          this._httpBatchClient
        );

        contractCw2s.forEach((cw2) => {
          if (cw2?.data) {
            const data = JSON.parse(fromUtf8(cw2?.data || new Uint8Array()));
            const index = migratedContracts.indexOf(
              migratedContracts.find(
                (contract) => contract.address === cw2.address
              )!
            );
            migratedContracts[index].name = data.name;
            migratedContracts[index].version = data.version;
          }
        });
      }

      await knex
        .transaction(async (trx) => {
          await SmartContract.query()
            .insert(migratedContracts)
            .onConflict(['address', 'code_id'])
            .merge()
            .returning(['address', 'code_id'])
            .transacting(trx)
            .catch((error) => {
              this.logger.error(
                'Error insert or update migrated smart contracts'
              );
              this.logger.error(error);
            });

          updateBlockCheckpoint.height = endHeight;
          await BlockCheckpoint.query()
            .insert(updateBlockCheckpoint)
            .onConflict('job_name')
            .merge()
            .returning('id')
            .transacting(trx);
        })
        .catch((error) => {
          this.logger.error(error);
          throw error;
        });
    }
  }

  private async insertNewContracts(
    contracts: IInstantiateContracts[],
    trx: Knex.Transaction
  ): Promise<SmartContract[] | void> {
    const queryAddresses: string[] = [];
    const smartContracts: SmartContract[] = [];

    let instantiatedContracts: SmartContract[] | void = [];
    if (contracts.length > 0) {
      contracts.forEach((contract) => {
        queryAddresses.push(contract.address);
        smartContracts.push(
          SmartContract.fromJson({
            name: null,
            address: contract.address,
            creator: '',
            code_id: 0,
            status: SmartContract.STATUS.LATEST,
            instantiate_hash: contract.hash,
            instantiate_height: contract.height,
            version: null,
          })
        );
      });

      const [contractCw2s, contractInfos] = await SmartContract.getContractInfo(
        queryAddresses,
        this._httpBatchClient
      );

      let codeIds: number[] = [];
      const updateContractTypes: any[] = [];
      smartContracts.forEach((contract, index) => {
        if (contractCw2s[index]?.data) {
          const data = JSON.parse(
            fromUtf8(contractCw2s[index]?.data || new Uint8Array())
          );
          contract.name = data.contract;
          contract.version = data.version;

          const codeTypes = Code.detectCodeType(data.contract);
          if (codeTypes !== '')
            updateContractTypes.push(
              Code.query().patch({ type: codeTypes }).where({
                code_id: contractInfos[index]?.contractInfo?.codeId.toString(),
              })
            );
        }
        if (contractInfos[index]?.contractInfo) {
          contract.code_id = parseInt(
            contractInfos[index]?.contractInfo?.codeId.toString() || '0',
            10
          );
          contract.creator = contractInfos[index]?.contractInfo?.creator || '';

          codeIds.push(
            parseInt(
              contractInfos[index]?.contractInfo?.codeId.toString() || '0',
              10
            )
          );
        }
      });

      codeIds = Array.from(new Set(codeIds));
      const codes: Code[] = await Code.query().whereIn('code_id', codeIds);
      const codeKeys = _.keyBy(codes, 'code_id');
      const missingCodeIds: IStoreCodes[] = [];
      codeIds.forEach((codeId) => {
        if (!codeKeys[codeId])
          missingCodeIds.push({
            codeId: Long.fromInt(codeId),
            hash: '',
            height: 0,
          });
      });
      if (missingCodeIds.length > 0)
        await this.broker.call(
          SERVICE.V1.CrawlCodeService.CrawlMissingCode.path,
          { codeIds: missingCodeIds }
        );

      if (updateContractTypes.length > 0)
        await Promise.all(updateContractTypes);

      if (smartContracts.length > 0)
        instantiatedContracts = await SmartContract.query()
          .insert(smartContracts)
          .onConflict(['address', 'code_id'])
          .merge()
          .returning(['address', 'code_id'])
          .transacting(trx)
          .catch((error) => {
            this.logger.error('Error insert new smart contracts');
            this.logger.error(error);
          });
    }

    return instantiatedContracts;
  }

  public async _start() {
    await this.broker.waitForServices(SERVICE.V1.CrawlCodeService.name);

    this.createJob(
      BULL_JOB_NAME.CRAWL_SMART_CONTRACT,
      'crawl',
      {},
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
        repeat: {
          every: config.crawlSmartContract.millisecondCrawl,
        },
      }
    );

    return super._start();
  }
}

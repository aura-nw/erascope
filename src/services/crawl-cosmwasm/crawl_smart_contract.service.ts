/* eslint-disable no-param-reassign */
/* eslint-disable no-await-in-loop */
/* eslint-disable import/no-extraneous-dependencies */
import { Service } from '@ourparentcenter/moleculer-decorators-extended';
import { ServiceBroker } from 'moleculer';
import {
  QueryContractInfoRequest,
  QueryContractInfoResponse,
  QueryRawContractStateRequest,
  QueryRawContractStateResponse,
} from '@aura-nw/aurajs/types/codegen/cosmwasm/wasm/v1/query';
import { fromBase64, fromUtf8, toHex } from '@cosmjs/encoding';
import { cosmwasm } from '@aura-nw/aurajs';
import { createJsonRpcRequest } from '@cosmjs/tendermint-rpc/build/jsonrpc';
import { JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import { HttpBatchClient } from '@cosmjs/tendermint-rpc';
import {
  BlockCheckpoint,
  Event,
  Transaction,
  EventAttribute,
  SmartContract,
} from '../../models';
import {
  ABCI_QUERY_PATH,
  BULL_JOB_NAME,
  getHttpBatchClient,
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

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_SMART_CONTRACT,
    jobType: 'crawl',
    prefix: `horoscope-v2-${config.chainId}`,
  })
  public async handleJob(_payload: object): Promise<void> {
    const queryAddresses: string[] = [];
    const smartContracts: SmartContract[] = [];

    const cosmwasmCheckpoint: BlockCheckpoint[] | undefined =
      await BlockCheckpoint.query()
        .select('*')
        .whereIn('job_name', [
          BULL_JOB_NAME.CRAWL_SMART_CONTRACT,
          BULL_JOB_NAME.CRAWL_CODE,
        ]);

    let lastHeight = 0;
    let updateBlockCheckpoint: BlockCheckpoint;
    const contractCheckpoint = cosmwasmCheckpoint.find(
      (check) => check.job_name === BULL_JOB_NAME.CRAWL_SMART_CONTRACT
    );
    if (contractCheckpoint) {
      lastHeight = contractCheckpoint.height;
      updateBlockCheckpoint = contractCheckpoint;
    } else
      updateBlockCheckpoint = BlockCheckpoint.fromJson({
        job_name: BULL_JOB_NAME.CRAWL_SMART_CONTRACT,
        height: 0,
      });

    const codeIdCheckpoint = cosmwasmCheckpoint.find(
      (check) => check.job_name === BULL_JOB_NAME.CRAWL_CODE
    );
    if (codeIdCheckpoint) {
      if (codeIdCheckpoint.height <= lastHeight) return;

      const instantiateTxs: any[] = [];
      let offset = 0;
      let done = false;
      while (!done) {
        // eslint-disable-next-line no-await-in-loop
        const resultTx = await Transaction.query()
          .joinRelated('events.[attributes]')
          .where('events.type', Event.EVENT_TYPE.INSTANTIATE)
          .andWhere(
            'events:attributes.key',
            EventAttribute.ATTRIBUTE_KEY._CONTRACT_ADDRESS
          )
          .andWhere('transaction.height', '>', lastHeight)
          .andWhere('transaction.height', '<=', codeIdCheckpoint.height)
          .andWhere('transaction.code', 0)
          .select(
            'transaction.hash',
            'transaction.height',
            'events:attributes.key',
            'events:attributes.value'
          )
          .page(offset, 1000);
        this.logger.info(
          `Result get Tx from height ${lastHeight} to ${codeIdCheckpoint.height}:`
        );
        this.logger.info(JSON.stringify(resultTx));

        if (resultTx.results.length > 0) {
          resultTx.results.map((res: any) => instantiateTxs.push(res));

          offset += 1;
        } else done = true;
      }

      if (instantiateTxs.length > 0) {
        instantiateTxs.forEach((transaction) => {
          queryAddresses.push(transaction.value);
          smartContracts.push(
            SmartContract.fromJson({
              name: null,
              address: transaction.value,
              creator: '',
              code_id: 0,
              instantiate_hash: transaction.hash,
              instantiate_height: transaction.height,
              version: null,
            })
          );
        });

        const [contractCw2s, contractInfos] = await this.getContractInfo(
          queryAddresses
        );
        smartContracts.forEach((contract, index) => {
          if (contractCw2s[index]?.data) {
            const data = JSON.parse(
              fromUtf8(contractCw2s[index]?.data || new Uint8Array())
            );
            contract.name = data.contract;
            contract.version = data.version;
          }
          if (contractInfos[index]?.contractInfo) {
            contract.code_id = parseInt(
              contractInfos[index]?.contractInfo?.codeId.toString() || '0',
              10
            );
            contract.creator =
              contractInfos[index]?.contractInfo?.creator || '';
          }
        });

        await SmartContract.query()
          .insert(smartContracts)
          .onConflict('address')
          .merge()
          .returning('address')
          .catch((error) => {
            this.logger.error('Error insert new smart contracts');
            this.logger.error(error);
          });
      }

      updateBlockCheckpoint.height = codeIdCheckpoint.height;
      await BlockCheckpoint.query()
        .insert(updateBlockCheckpoint)
        .onConflict('job_name')
        .merge()
        .returning('id');
    }
  }

  private async getContractInfo(
    addresses: string[]
  ): Promise<
    [
      (QueryRawContractStateResponse | null)[],
      (QueryContractInfoResponse | null)[]
    ]
  > {
    const batchQueriesCw2: any[] = [];
    const batchQueriesContractInfo: any[] = [];

    addresses.forEach((address) => {
      const requestCw2: QueryRawContractStateRequest = {
        address,
        queryData: fromBase64('Y29udHJhY3RfaW5mbw=='), // contract_info
      };
      const dataCw2 = toHex(
        cosmwasm.wasm.v1.QueryRawContractStateRequest.encode(
          requestCw2
        ).finish()
      );

      const requestContractInfo: QueryContractInfoRequest = {
        address,
      };
      const dataContractInfo = toHex(
        cosmwasm.wasm.v1.QueryContractInfoRequest.encode(
          requestContractInfo
        ).finish()
      );

      batchQueriesCw2.push(
        this._httpBatchClient.execute(
          createJsonRpcRequest('abci_query', {
            path: ABCI_QUERY_PATH.RAW_CONTRACT_STATE,
            data: dataCw2,
          })
        )
      );
      batchQueriesContractInfo.push(
        this._httpBatchClient.execute(
          createJsonRpcRequest('abci_query', {
            path: ABCI_QUERY_PATH.CONTRACT_INFO,
            data: dataContractInfo,
          })
        )
      );
    });

    const resultCw2: JsonRpcSuccessResponse[] = await Promise.all(
      batchQueriesCw2
    );
    const resultContractInfo: JsonRpcSuccessResponse[] = await Promise.all(
      batchQueriesContractInfo
    );

    const contractCw2s = resultCw2.map((res: JsonRpcSuccessResponse) =>
      res.result.response.value
        ? cosmwasm.wasm.v1.QueryRawContractStateResponse.decode(
            fromBase64(res.result.response.value)
          )
        : null
    );
    const contractInfos = resultContractInfo.map(
      (res: JsonRpcSuccessResponse) =>
        res.result.response.value
          ? cosmwasm.wasm.v1.QueryContractInfoResponse.decode(
              fromBase64(res.result.response.value)
            )
          : null
    );

    return [contractCw2s, contractInfos];
  }

  public async _start() {
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

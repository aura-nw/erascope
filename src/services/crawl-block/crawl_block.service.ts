/* eslint-disable import/no-extraneous-dependencies */
import { ServiceBroker } from 'moleculer';
import { Service } from '@ourparentcenter/moleculer-decorators-extended';
import { GetLatestBlockResponseSDKType } from '@aura-nw/aurajs/types/codegen/cosmos/base/tendermint/v1beta1/query';
import { CommitSigSDKType } from '@aura-nw/aurajs/types/codegen/tendermint/types/types';
import { HttpBatchClient } from '@cosmjs/tendermint-rpc';
import { createJsonRpcRequest } from '@cosmjs/tendermint-rpc/build/jsonrpc';
import { JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import { fromBase64, fromUtf8 } from '@cosmjs/encoding';
import {
  BLOCK_CHECKPOINT_JOB_NAME,
  BULL_JOB_NAME,
  getHttpBatchClient,
  getLcdClient,
  IAuraJSClientFactory,
  SERVICE,
  SERVICE_NAME,
} from '../../common';
import { Block, BlockCheckpoint, Event } from '../../models';
import BullableService, { QueueHandler } from '../../base/bullable.service';
import config from '../../../config.json' assert { type: 'json' };

@Service({
  name: SERVICE_NAME.CRAWL_BLOCK,
  version: 1,
})
export default class CrawlBlockService extends BullableService {
  private _currentBlock = 0;

  private _httpBatchClient: HttpBatchClient;

  private _lcdClient!: IAuraJSClientFactory;

  public constructor(public broker: ServiceBroker) {
    super(broker);
    this._httpBatchClient = getHttpBatchClient();
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_BLOCK,
    jobType: BULL_JOB_NAME.CRAWL_BLOCK,
    prefix: `horoscope-v2-${config.chainId}`,
  })
  private async jobHandler(_payload: any): Promise<void> {
    await this.initEnv();
    await this.handleJobCrawlBlock();
  }

  private async initEnv() {
    this._lcdClient = await getLcdClient();

    // Get handled block from db
    let blockHeightCrawled = await BlockCheckpoint.query().findOne({
      job_name: BLOCK_CHECKPOINT_JOB_NAME.BLOCK_HEIGHT_CRAWLED,
    });

    if (!blockHeightCrawled) {
      blockHeightCrawled = await BlockCheckpoint.query().insert({
        job_name: BLOCK_CHECKPOINT_JOB_NAME.BLOCK_HEIGHT_CRAWLED,
        height: config.crawlBlock.startBlock,
      });
    }

    this._currentBlock = blockHeightCrawled ? blockHeightCrawled.height : 0;
    this.logger.info(`_currentBlock: ${this._currentBlock}`);
  }

  async handleJobCrawlBlock() {
    // Get latest block in network
    const responseGetLatestBlock: GetLatestBlockResponseSDKType =
      await this._lcdClient.auranw.cosmos.base.tendermint.v1beta1.getLatestBlock();
    const latestBlockNetwork = parseInt(
      responseGetLatestBlock.block?.header?.height
        ? responseGetLatestBlock.block?.header?.height.toString()
        : '0',
      10
    );

    this.logger.info(`latestBlockNetwork: ${latestBlockNetwork}`);

    // crawl block from startBlock to endBlock
    const startBlock = this._currentBlock + 1;

    let endBlock = startBlock + config.crawlBlock.numberOfBlockPerCall - 1;
    if (endBlock > latestBlockNetwork) {
      endBlock = latestBlockNetwork;
    }
    this.logger.info(`startBlock: ${startBlock} endBlock: ${endBlock}`);
    try {
      const blockQueries = [];
      const blockResultsQueries = [];
      for (let i = startBlock; i <= endBlock; i += 1) {
        blockQueries.push(
          this._httpBatchClient.execute(
            createJsonRpcRequest('block', { height: i.toString() })
          )
        );
        blockResultsQueries.push(
          this._httpBatchClient.execute(
            createJsonRpcRequest('block_results', { height: i.toString() })
          )
        );
      }
      const blockResponses: JsonRpcSuccessResponse[] = await Promise.all(
        blockQueries
      );

      const blockResultResponse: JsonRpcSuccessResponse[] = await Promise.all(
        blockResultsQueries
      );

      blockResultResponse.forEach((result) => {
        const { height } = result.result;
        const blockInListBlock = blockResponses.find(
          (block) => block.result.block.header.height === height
        );
        if (blockInListBlock) {
          blockInListBlock.result.block_result = result.result;
        }
      });

      // insert data to DB
      await this.handleListBlock(blockResponses.map((result) => result.result));

      // update crawled block to db
      if (this._currentBlock < endBlock) {
        await BlockCheckpoint.query()
          .update(
            BlockCheckpoint.fromJson({
              job_name: BLOCK_CHECKPOINT_JOB_NAME.BLOCK_HEIGHT_CRAWLED,
              height: endBlock,
            })
          )
          .where({
            job_name: BLOCK_CHECKPOINT_JOB_NAME.BLOCK_HEIGHT_CRAWLED,
          });
        this._currentBlock = endBlock;
      }
    } catch (error) {
      this.logger.error(error);
      throw new Error('cannot crawl block');
    }
  }

  async handleListBlock(listBlock: any[]) {
    try {
      // query list existed block and mark to a map
      const listBlockHeight: number[] = [];
      const mapExistedBlock: Map<number, boolean> = new Map();
      listBlock.forEach((block) => {
        if (block.block?.header?.height) {
          listBlockHeight.push(parseInt(block.block?.header?.height, 10));
        }
      });
      if (listBlockHeight.length) {
        const listExistedBlock = await Block.query().whereIn(
          'height',
          listBlockHeight
        );
        listExistedBlock.forEach((block) => {
          mapExistedBlock[block.height] = true;
        });
      }
      // insert list block to DB
      const listBlockModel: any[] = [];
      listBlock.forEach((block) => {
        if (
          block.block?.header?.height &&
          !mapExistedBlock[parseInt(block.block?.header?.height, 10)]
        ) {
          const listEvent: Event[] = [];
          if (block.block_result.begin_block_events?.length > 0) {
            block.block_result.begin_block_events.forEach((event: any) => {
              listEvent.push({
                ...event,
                source: Event.SOURCE.BEGIN_BLOCK_EVENT,
              });
            });
          }
          if (block.block_result.end_block_events?.length > 0) {
            block.block_result.end_block_events.forEach((event: any) => {
              listEvent.push({
                ...event,
                source: Event.SOURCE.END_BLOCK_EVENT,
              });
            });
          }
          listBlockModel.push({
            ...Block.fromJson({
              height: block?.block?.header?.height,
              hash: block?.block_id?.hash,
              time: block?.block?.header?.time,
              proposer_address: block?.block?.header?.proposer_address,
              data: block,
            }),
            signatures: block?.block?.last_commit?.signatures.map(
              (signature: CommitSigSDKType) => ({
                block_id_flag: signature.block_id_flag,
                validator_address: signature.validator_address,
                timestamp: signature.timestamp,
                signature: signature.signature,
              })
            ),
            events: listEvent.map((event: any) => ({
              type: event.type,
              attributes: event.attributes.map((attribute: any) => ({
                block_height: block?.block?.header?.height,
                composite_key: attribute?.key
                  ? `${event.type}.${fromUtf8(fromBase64(attribute?.key))}`
                  : null,
                key: attribute?.key
                  ? fromUtf8(fromBase64(attribute?.key))
                  : null,
                value: attribute?.value
                  ? fromUtf8(fromBase64(attribute?.value))
                  : null,
              })),
              source: event.source,
            })),
          });
        }
      });

      if (listBlockModel.length) {
        const result: any = await Block.query().insertGraph(listBlockModel);
        this.logger.debug('result insert list block: ', result);

        // insert tx by block height
        const listBlockWithTime: any = [];
        listBlockModel.forEach((block) => {
          listBlockWithTime.push({
            height: block.height,
            timestamp: block.time,
          });
        });
        this.broker.call(SERVICE.V1.CrawlTransaction.CrawlTxByHeight.path, {
          listBlock: listBlockWithTime,
        });
      }
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async _start() {
    await this.waitForServices(SERVICE.V1.CrawlTransaction.name);
    this.createJob(
      `${BULL_JOB_NAME.CRAWL_BLOCK}`,
      `${BULL_JOB_NAME.CRAWL_BLOCK}`,
      {},
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
        repeat: {
          every: config.crawlBlock.millisecondCrawl,
        },
      }
    );
    return super._start();
  }
}

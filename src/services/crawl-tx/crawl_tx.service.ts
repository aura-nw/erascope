/* eslint-disable import/no-extraneous-dependencies */
import { ServiceBroker } from 'moleculer';
import {
  Action,
  Service,
} from '@ourparentcenter/moleculer-decorators-extended';
import { HttpBatchClient } from '@cosmjs/tendermint-rpc';
import { createJsonRpcRequest } from '@cosmjs/tendermint-rpc/build/jsonrpc';
import { decodeTxRaw } from '@cosmjs/proto-signing';
import { toBase64, fromBase64, fromUtf8 } from '@cosmjs/encoding';
import _ from 'lodash';
import { JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import { Knex } from 'knex';
import { Queue } from 'bullmq';
import Utils from '../../common/utils/utils';
import { BULL_JOB_NAME, getHttpBatchClient, SERVICE } from '../../common';
import { Block, BlockCheckpoint, Event, Transaction } from '../../models';
import BullableService, { QueueHandler } from '../../base/bullable.service';
import config from '../../../config.json' assert { type: 'json' };
import knex from '../../common/utils/db_connection';
import AuraRegistry from './aura.registry';

@Service({
  name: SERVICE.V1.CrawlTransaction.key,
  version: 1,
})
export default class CrawlTxService extends BullableService {
  private _httpBatchClient: HttpBatchClient;

  private _registry!: AuraRegistry;

  public constructor(public broker: ServiceBroker) {
    super(broker);
    this._httpBatchClient = getHttpBatchClient();
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.HANDLE_TRANSACTION,
    jobName: BULL_JOB_NAME.HANDLE_TRANSACTION,
  })
  public async jobHandlerCrawlTx(): Promise<void> {
    const [startBlock, endBlock, blockCheckpoint] =
      await BlockCheckpoint.getCheckpoint(
        BULL_JOB_NAME.HANDLE_TRANSACTION,
        [BULL_JOB_NAME.CRAWL_BLOCK],
        config.handleTransaction.key
      );

    this.logger.info(
      `Handle transaction from block ${startBlock} to ${endBlock}`
    );

    if (startBlock > endBlock) {
      return;
    }
    const listTxRaw = await this.getListRawTx(startBlock, endBlock);
    const listdecodedTx = await this.decodeListRawTx(listTxRaw);
    await knex.transaction(async (trx) => {
      await this.insertDecodedTxAndRelated(listdecodedTx, trx);
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

  // get list raw tx from block to block
  async getListRawTx(
    startBlock: number,
    endBlock: number
  ): Promise<{ listTx: any; height: number; timestamp: string }[]> {
    const blocks: any[] = await Block.query()
      .select(
        'height',
        'time',
        knex.raw("\"data\" #>ARRAY['block', 'data', 'txs'] AS txs")
      )
      .where('height', '>', startBlock)
      .andWhere('height', '<=', endBlock)
      .orderBy('height', 'asc');
    this.logger.debug(blocks);
    const promises: any[] = [];
    const mapBlockTime: Map<number, string> = new Map();
    blocks
      .filter((block) => block.txs.length > 0)
      .forEach((block) => {
        this.logger.info('crawl tx by height: ', block.height);
        mapBlockTime[block.height] = block.time;
        promises.push(
          this._httpBatchClient.execute(
            createJsonRpcRequest('tx_search', {
              query: `tx.height=${block.height}`,
            })
          )
        );
      });
    const resultPromises: JsonRpcSuccessResponse[] = await Promise.all(
      promises
    );
    const listRawTx: any[] = resultPromises.map((result) => ({
      listTx: result.result,
      height: result.result.txs[0].height,
      timestamp: mapBlockTime[result.result.txs[0].height],
    }));
    return listRawTx;
  }

  // decode list raw tx
  async decodeListRawTx(
    listRawTx: { listTx: any; height: number; timestamp: string }[]
  ): Promise<{ listTx: any; height: number; timestamp: string }[]> {
    const listDecodedTx = await Promise.all(
      listRawTx.map(async (payloadBlock) => {
        const { listTx, timestamp, height } = payloadBlock;
        const listHandleTx: any[] = [];
        try {
          // check if tx existed
          const mapExistedTx: Map<string, boolean> = new Map();
          const listHash = listTx.txs.map((tx: any) => tx.hash);
          const listTxExisted = await Transaction.query().whereIn(
            'hash',
            listHash
          );
          listTxExisted.forEach((tx) => {
            mapExistedTx.set(tx.hash, true);
          });

          // parse tx to format LCD return
          listTx.txs.forEach((tx: any, index: number) => {
            this.logger.info(`Handle txhash ${tx.hash}`);
            if (mapExistedTx.get(tx.hash)) {
              return;
            }
            // decode tx to readable
            const decodedTx = decodeTxRaw(fromBase64(tx.tx));

            const parsedTx: any = {};
            parsedTx.tx = decodedTx;
            parsedTx.tx.signatures = decodedTx.signatures.map(
              (signature: Uint8Array) => toBase64(signature)
            );

            const decodedMsgs = decodedTx.body.messages.map((msg) => {
              const decodedMsg = Utils.camelizeKeys(
                this._registry.decodeMsg(msg)
              );
              decodedMsg['@type'] = msg.typeUrl;
              return decodedMsg;
            });

            parsedTx.tx = {
              body: {
                messages: decodedMsgs,
                memo: decodedTx.body?.memo,
                timeout_height: decodedTx.body?.timeoutHeight,
                extension_options: decodedTx.body?.extensionOptions,
                non_critical_extension_options:
                  decodedTx.body?.nonCriticalExtensionOptions,
              },
              auth_info: {
                fee: {
                  amount: decodedTx.authInfo.fee?.amount,
                  gas_limit: decodedTx.authInfo.fee?.gasLimit,
                  granter: decodedTx.authInfo.fee?.granter,
                  payer: decodedTx.authInfo.fee?.payer,
                },
                signer_infos: decodedTx.authInfo.signerInfos.map(
                  (signerInfo) => {
                    const pubkey = signerInfo.publicKey?.value;

                    if (pubkey instanceof Uint8Array) {
                      return {
                        mode_info: signerInfo.modeInfo,
                        public_key: {
                          '@type': signerInfo.publicKey?.typeUrl,
                          key: toBase64(pubkey.slice(2)),
                        },
                        sequence: signerInfo.sequence.toString(),
                      };
                    }
                    return {
                      mode_info: signerInfo.modeInfo,
                      sequence: signerInfo.sequence.toString(),
                    };
                  }
                ),
              },
              signatures: decodedTx.signatures,
            };

            parsedTx.tx_response = {
              height: tx.height,
              txhash: tx.hash,
              codespace: tx.tx_result.codespace,
              code: tx.tx_result.code,
              data: tx.tx_result.data,
              raw_log: tx.tx_result.log,
              info: tx.tx_result.info,
              gas_wanted: tx.tx_result.gas_wanted,
              gas_used: tx.tx_result.gas_used,
              tx: tx.tx,
              index,
              events: tx.tx_result.events,
              timestamp,
            };
            try {
              parsedTx.tx_response.logs = JSON.parse(tx.tx_result.log);
            } catch (error) {
              this.logger.debug('tx fail');
            }
            listHandleTx.push(parsedTx);
          });

          return { listTx: listHandleTx, timestamp, height };
        } catch (error) {
          this.logger.error(error);
          throw error;
        }
      })
    );
    return listDecodedTx;
  }

  // insert list decoded tx and related table (event, event_attribute, message, message_received)
  async insertDecodedTxAndRelated(
    listDecodedTx: { listTx: any; height: number; timestamp: string }[],
    transactionDB: Knex.Transaction
  ) {
    this.logger.debug(listDecodedTx);
    const listTxModel: any[] = [];
    listDecodedTx.forEach((payloadBlock) => {
      const { listTx, height, timestamp } = payloadBlock;
      listTx.forEach((tx: any, indexTx: number) => {
        this.logger.debug(tx, timestamp);
        let sender = '';
        try {
          sender = fromUtf8(
            fromBase64(
              this._findAttribute(
                tx.tx_response.events,
                'message',
                // c2VuZGVy is sender in base64
                'c2VuZGVy'
              )
            )
          );
        } catch (error) {
          this.logger.warn(
            'txhash not has sender event: ',
            tx.tx_response.txhash
          );
          this.logger.warn(error);
        }

        // scan list transfer.recipient and wasm.recipient
        const listAddressReceiver: any[][] = [[]];
        tx.tx_response?.logs?.forEach((log: any, index: number) => {
          log.events?.forEach((event: any) => {
            if (event.type === 'transfer' || event.type === 'wasm') {
              event.attributes.forEach((attribute: any) => {
                if (attribute.key === 'recipient') {
                  listAddressReceiver[index]?.push({
                    address: attribute.value,
                    reason: `${event.type}.${attribute.key}`,
                  });
                }
              });
            }
          });
        });

        // set index to event
        this.setMsgIndexToEvent(tx);

        const txInsert = {
          '#id': `transaction-${height}-${indexTx}`,
          ...Transaction.fromJson({
            index: tx.tx_response.index,
            height: parseInt(tx.tx_response.height, 10),
            hash: tx.tx_response.txhash,
            codespace: tx.tx_response.codespace,
            code: parseInt(tx.tx_response.code, 10),
            gas_used: tx.tx_response.gas_used.toString(),
            gas_wanted: tx.tx_response.gas_wanted.toString(),
            gas_limit: tx.tx.auth_info.fee.gas_limit.toString(),
            fee: JSON.stringify(tx.tx.auth_info.fee.amount),
            timestamp,
            data: tx,
            memo: tx.tx.body.memo,
          }),
          events: tx.tx_response.events.map((event: any) => ({
            tx_msg_index: event.msg_index ?? undefined,
            type: event.type,
            attributes: event.attributes.map(
              (attribute: any, index: number) => ({
                tx_id: `#ref{transaction-${height}-${indexTx}.id}`,
                block_height: parseInt(tx.tx_response.height, 10),
                index,
                composite_key: attribute?.key
                  ? `${event.type}.${fromUtf8(fromBase64(attribute?.key))}`
                  : null,
                key: attribute?.key
                  ? fromUtf8(fromBase64(attribute?.key))
                  : null,
                value: attribute?.value
                  ? fromUtf8(fromBase64(attribute?.value))
                  : null,
              })
            ),
            block_height: height,
            source: Event.SOURCE.TX_EVENT,
          })),
          messages: tx.tx.body.messages.map((message: any, index: any) => ({
            sender,
            index,
            type: message['@type'],
            content: message,
            receivers: listAddressReceiver[index],
          })),
        };
        listTxModel.push(txInsert);
      });
    });

    const resultInsertGraph = await Transaction.query()
      .insertGraph(listTxModel, { allowRefs: true })
      .transacting(transactionDB);
    this.logger.debug('result insert tx', resultInsertGraph);
  }

  public mappingEventToLog(eventInLog: any, eventInTx: any, index: number) {
    const arrSrc = eventInTx;
    const arrFlat: any[] = [];
    arrSrc.forEach((item: any, index: number) => {
      item.attributes.forEach((attr: any) => {
        arrFlat.push({ ...attr, indexEvent: index });
      });
    });
    // eslint-disable-next-line no-inner-declarations
    function checkMapping(arr: any, arrCompare: any) {
      const indexes = _.uniq(
        arr
          .filter((item: any) => item.indexMapped !== undefined)
          .map((e: any) => e.indexEvent)
      );
      // all event must be included in log
      return indexes.every((index: any) => {
        const isMapped = arrSrc[index].attributes.every((item: any) => {
          const key = item.key ? fromUtf8(fromBase64(item.key)) : null;
          const value = item.value ? fromUtf8(fromBase64(item.value)) : null;
          // check if key and value found
          return arrCompare.some(
            (att: any) => att.key === key && att.value === value
          );
        });
        return isMapped;
      });
    }

    // eslint-disable-next-line no-inner-declarations
    function recursive(
      arrSrc: any[],
      arrDest: any[],
      indexSrc: number,
      indexDest: number,
      indexMsg: number
    ): boolean {
      if (indexDest === arrDest.length) {
        const isMapped = checkMapping(arrSrc, arrDest);
        return isMapped;
      }
      if (indexSrc === arrSrc.length || indexDest === arrDest.length) {
        return false;
      }
      let result = false;
      for (let i = indexSrc; i < arrSrc.length; i += 1) {
        const key = arrSrc[i].key ? fromUtf8(fromBase64(arrSrc[i].key)) : null;
        const value = arrSrc[i].value
          ? fromUtf8(fromBase64(arrSrc[i].value))
          : null;
        if (
          key === arrDest[indexDest].key &&
          value === arrDest[indexDest].value
        ) {
          // eslint-disable-next-line no-param-reassign
          arrSrc[i].indexMapped = indexMsg;
          result = recursive(arrSrc, arrDest, i + 1, indexDest + 1, indexMsg);
          if (result) {
            break;
          }
          // eslint-disable-next-line no-param-reassign
          delete arrSrc[i].indexMapped;
        }
      }
      return result;
    }

    const result = recursive(arrFlat, eventInLog.attributes, 0, 0, index);
    if (result === false) {
      this.logger.warn('something wrong: mapping event to log failed');
    } else {
      arrFlat
        .filter((item) => item.indexMapped !== undefined)
        .forEach((item) => {
          if (
            arrSrc[item.indexEvent].msg_index !== undefined &&
            arrSrc[item.indexEvent].msg_index !== item.indexMapped
          ) {
            this.logger.warn(
              `something wrong: setting index ${
                item.indexMapped
              } to existed index ${arrSrc[item.indexEvent].msg_index}`
            );
          }
          arrSrc[item.indexEvent].msg_index = item.indexMapped;
        });
    }
  }

  private setMsgIndexToEvent(tx: any) {
    // loop logs (has order for each messages)
    tx.tx_response.logs.forEach((log: any, index: number) => {
      // loop each event in log to compare with event encoded
      log.events.forEach((eventInLog: any) => {
        // filter list event has type equal eventInLog.type and not be setted index msg
        const filtedEventByType = tx.tx_response.events.filter(
          (eventEncoded: any) =>
            eventEncoded.type === eventInLog.type &&
            eventEncoded.msg_index === undefined
        );

        // mapping between log and event
        this.mappingEventToLog(eventInLog, filtedEventByType, index);
      });
    });
  }

  private _findAttribute(
    events: any,
    eventType: string,
    attributeKey: string
  ): string {
    let result = '';
    events.forEach((event: any) => {
      if (event.type === eventType) {
        event.attributes.forEach((attribute: any) => {
          if (attribute.key === attributeKey) {
            result = attribute.value;
          }
        });
      }
    });
    if (!result.length) {
      throw new Error(
        `Could not find attribute ${attributeKey} in event type ${eventType}`
      );
    }
    return result;
  }

  @Action({
    name: SERVICE.V1.CrawlTransaction.TriggerHandleTxJob.key,
  })
  async triggerHandleTxJob() {
    try {
      const queue: Queue = this.getQueueManager().getQueue(
        BULL_JOB_NAME.HANDLE_TRANSACTION
      );
      const jobInDelayed = await queue.getDelayed();
      if (jobInDelayed?.length > 0) {
        await jobInDelayed[0].promote();
      }
    } catch (error) {
      this.logger.error('No job can be promoted');
      this.logger.error(error);
    }
  }

  public async _start() {
    this._registry = new AuraRegistry(this.logger);
    this.createJob(
      BULL_JOB_NAME.HANDLE_TRANSACTION,
      BULL_JOB_NAME.HANDLE_TRANSACTION,
      {},
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
        repeat: {
          every: config.handleTransaction.millisecondCrawl,
        },
      }
    );
    return super._start();
  }
}

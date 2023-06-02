import { cosmwasm } from '@aura-nw/aurajs';
import {
  fromBase64,
  fromUtf8,
  toBase64,
  toHex,
  toUtf8,
} from '@cosmjs/encoding';
import { JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import { HttpBatchClient } from '@cosmjs/tendermint-rpc';
import { createJsonRpcRequest } from '@cosmjs/tendermint-rpc/build/jsonrpc';
import { Service } from '@ourparentcenter/moleculer-decorators-extended';
import { ServiceBroker } from 'moleculer';
import _ from 'lodash';
import { SmartContractEvent } from '../../models/smart_contract_event';
import config from '../../../config.json' assert { type: 'json' };
import BullableService, { QueueHandler } from '../../base/bullable.service';
import { Config, getHttpBatchClient } from '../../common';
import { BULL_JOB_NAME, SERVICE } from '../../common/constant';
import knex from '../../common/utils/db_connection';
import { BlockCheckpoint, EventAttribute } from '../../models';
import CW721Contract from '../../models/cw721_contract';
import CW721Token from '../../models/cw721_token';
import CW721Activity from '../../models/cw721_tx';
import { SmartContract } from '../../models/smart_contract';
import { getAttributeFrom } from '../../common/utils/smart_contract';

const { NODE_ENV } = Config;

interface IContractInfoAndMinter {
  address: string;
  name: string;
  symbol: string;
  minter: string;
}

const CW721_ACTION = {
  MINT: 'mint',
  BURN: 'burn',
  TRANSFER: 'transfer_nft',
  INSTANTIATE: 'instantiate',
  SEND_NFT: 'send_nft',
};

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

  // update new owner and last_update_height
  async handlerCw721Transfer(
    transferMsgs: SmartContractEvent[]
  ): Promise<void> {
    // get Ids for contracts
    const contractTrackedByAddress = _.keyBy(
      await this.getCw721TrackedContracts(
        transferMsgs.map((transferMsg) => transferMsg.contractAddress)
      ),
      'address'
    );
    // eslint-disable-next-line no-restricted-syntax
    for (const transferMsg of transferMsgs) {
      const recipient = getAttributeFrom(
        transferMsg.attributes,
        EventAttribute.ATTRIBUTE_KEY.RECIPIENT
      );
      const tokenId = getAttributeFrom(
        transferMsg.attributes,
        EventAttribute.ATTRIBUTE_KEY.TOKEN_ID
      );
      // find the id for correspond smart contract
      const cw721Contract =
        contractTrackedByAddress[transferMsg.contractAddress];
      if (cw721Contract) {
        if (tokenId && recipient) {
          // eslint-disable-next-line no-await-in-loop
          await CW721Token.query()
            .where('cw721_contract_id', cw721Contract.id)
            .andWhere('token_id', tokenId)
            .andWhere('last_updated_height', '<=', transferMsg.tx.height)
            .patch({
              owner: recipient,
              last_updated_height: transferMsg.tx.height,
            });
        } else {
          throw new Error(
            `Msg transfer in tx ${transferMsg.tx.hash} not found token id transfered or not found new owner`
          );
        }
      }
    }
  }

  // Insert new token if it haven't been in cw721_token table, or update burned to false if it already have been there
  async handlerCw721Mint(mintEvents: SmartContractEvent[]): Promise<void> {
    if (mintEvents.length > 0) {
      // from list contract address, get those ids
      const contractTrackedByAddress = _.keyBy(
        await this.getCw721TrackedContracts(
          mintEvents.map((mintEvent) => mintEvent.contractAddress)
        ),
        'address'
      );
      await knex.transaction(async (trx) => {
        const queries: any[] = [];
        mintEvents.forEach((mintEvent) => {
          // find the mintEvent's smart contract id
          const cw721Contract =
            contractTrackedByAddress[mintEvent.contractAddress];
          if (cw721Contract) {
            const tokenId = getAttributeFrom(
              mintEvent.attributes,
              EventAttribute.ATTRIBUTE_KEY.TOKEN_ID
            );
            const mediaInfo = null;
            queries.push(
              CW721Token.query()
                .insert(
                  CW721Token.fromJson({
                    token_id: tokenId,
                    media_info: mediaInfo,
                    owner: getAttributeFrom(
                      mintEvent.attributes,
                      EventAttribute.ATTRIBUTE_KEY.OWNER
                    ),
                    cw721_contract_id: cw721Contract.id,
                    last_updated_height: mintEvent.tx.height,
                    burned: false,
                  })
                )
                .onConflict(['token_id', 'cw721_contract_id'])
                .merge()
                .transacting(trx)
            );
          }
        });
        if (queries.length > 0) {
          await Promise.all(queries) // Once every query is written
            .then(trx.commit) // Try to execute all of them
            .catch((e) => {
              this.logger.error(e);
              trx.rollback();
            }); // And rollback in case any of them goes wrong
        }
      });
    }
  }

  // update burned field in cw721_token to true, last updated height
  async handlerCw721Burn(burnMsgs: SmartContractEvent[]): Promise<void> {
    // get Ids for contracts
    const cw721ContractDbRecords = _.keyBy(
      await this.getCw721TrackedContracts(
        burnMsgs.map((burnMsg) => burnMsg.contractAddress)
      ),
      'address'
    );
    await knex.transaction(async (trx) => {
      const queries: any[] = [];
      burnMsgs.forEach((burnMsg) => {
        // find the burnMsg's smart contract id
        const cw721Contract = cw721ContractDbRecords[burnMsg.contractAddress];
        if (cw721Contract) {
          const tokenId = getAttributeFrom(
            burnMsg.attributes,
            EventAttribute.ATTRIBUTE_KEY.TOKEN_ID
          );
          if (tokenId) {
            const query = CW721Token.query()
              .where('cw721_contract_id', cw721Contract.id)
              .andWhere('token_id', tokenId)
              .andWhere('last_updated_height', '<=', burnMsg.tx.height)
              .patch({
                last_updated_height: burnMsg.tx.height,
                burned: true,
              })
              .transacting(trx);
            queries.push(query);
          }
        }
      });
      if (queries.length > 0) {
        await Promise.all(queries) // Once every query is written
          .then(trx.commit) // Try to execute all of them
          .catch((e) => {
            this.logger.error(e);
            trx.rollback();
          }); // And rollback in case any of them goes wrong
      }
    });
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
    const listContractMsg = await this.getCw721ContractEvents(
      startBlock,
      endBlock
    );
    this.logger.info(listContractMsg);
    if (listContractMsg.length > 0) {
      // handle instantiate cw721 contracts
      await this.handleInstantiateMsgs(
        listContractMsg.filter((msg) => msg.action === CW721_ACTION.INSTANTIATE)
      );
      // handle all cw721 execute messages
      await this.handleCw721MsgExec(
        listContractMsg.filter((msg) => msg.action !== CW721_ACTION.INSTANTIATE)
      );
      // handle Cw721 Activity
      await this.handleCW721Activity(listContractMsg);
    }
    updateBlockCheckpoint.height = endBlock;
    await BlockCheckpoint.query()
      .insert(updateBlockCheckpoint)
      .onConflict('job_name')
      .merge();
  }

  // Insert new activities into cw721_activity table
  async handleCW721Activity(cw721Events: SmartContractEvent[]) {
    // from list onchain token-ids, get cw721-token records
    const cw721TokenRecords = _.keyBy(
      await this.getCw721TokensRecords(
        cw721Events.map((cw721Event) => ({
          contractAddress: cw721Event.contractAddress,
          onchainTokenId: getAttributeFrom(
            cw721Event.attributes,
            EventAttribute.ATTRIBUTE_KEY.TOKEN_ID
          ),
        }))
      ),
      (e) => `${e.contract_address}_${e.token_id}`
    );
    // from list contract address, get cw721-contract-id
    const cw721ContractDbRecords = _.keyBy(
      await this.getCw721TrackedContracts(
        cw721Events.map((cw721Event) => cw721Event.contractAddress)
      ),
      'address'
    );
    await knex.transaction(async (trx) => {
      const queries: any[] = [];
      cw721Events.forEach((cw721Event) => {
        // find the cw721 Event's smart contract id
        const cw721Contract =
          cw721ContractDbRecords[cw721Event.contractAddress];
        if (cw721Contract) {
          const onchainTokenId = getAttributeFrom(
            cw721Event.attributes,
            EventAttribute.ATTRIBUTE_KEY.TOKEN_ID
          );
          let cw721TokenId = null;
          if (onchainTokenId) {
            const foundRecord =
              cw721TokenRecords[
                `${cw721Event.contractAddress}_${onchainTokenId}`
              ];
            if (foundRecord) {
              cw721TokenId = foundRecord.cw721_token_id;
            } else {
              this.logger.error(
                `From tx ${cw721Event.tx.hash}: Token ${onchainTokenId} in smart contract ${cw721Event.contractAddress} not found in DB`
              );
            }
          }
          queries.push(
            CW721Activity.query()
              .insert(
                CW721Activity.fromJson({
                  action: cw721Event.action,
                  sender: cw721Event.sender,
                  tx_hash: cw721Event.tx.hash,
                  cw721_contract_id: cw721Contract.id,
                  cw721_token_id: cw721TokenId,
                  height: cw721Event.tx.height,
                })
              )
              .transacting(trx)
          );
        }
      });
      if (queries.length > 0) {
        await Promise.all(queries) // Once every query is written
          .then(trx.commit) // Try to execute all of them
          .catch((e) => {
            this.logger.error(e);
            trx.rollback();
          }); // And rollback in case any of them goes wrong
      }
    });
  }

  // handle Instantiate Msgs
  async handleInstantiateMsgs(msgsInstantiate: SmartContractEvent[]) {
    const cw721Contracts: any[] = await SmartContract.query()
      .alias('contract')
      .withGraphJoined('code')
      .whereIn(
        'contract.address',
        msgsInstantiate.map((msg) => msg.contractAddress)
      )
      .andWhere('code.type', 'CW721')
      .select(
        'contract.address as contract_address',
        'contract.name as contract_name',
        'contract.id as id'
      );
    if (cw721Contracts.length > 0) {
      const contractsInfo = _.keyBy(
        await this.getContractsInfo(
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
        });
      });
      await CW721Contract.query()
        .insert(instantiateContracts)
        .onConflict('contract_id')
        .merge();
    }
  }

  // handle Cw721 Msg Execute
  async handleCw721MsgExec(cw721MsgsExecute: SmartContractEvent[]) {
    // handle mint
    await this.handlerCw721Mint(
      cw721MsgsExecute.filter((msg) => msg.action === CW721_ACTION.MINT)
    );
    // handle transfer
    await this.handlerCw721Transfer(
      cw721MsgsExecute.filter(
        (msg) =>
          msg.action === CW721_ACTION.TRANSFER ||
          msg.action === CW721_ACTION.SEND_NFT
      )
    );
    // handle burn
    await this.handlerCw721Burn(
      cw721MsgsExecute.filter((msg) => msg.action === CW721_ACTION.BURN)
    );
  }

  // From list of tokens, get those appropriate ids in DB
  async getCw721TokensRecords(
    tokens: { contractAddress: string; onchainTokenId: string }[]
  ) {
    return CW721Token.query()
      .alias('cw721_token')
      .withGraphJoined('contract.smart_contract')
      .whereIn(
        ['contract:smart_contract.address', 'cw721_token.token_id'],
        tokens
          .map((token) => ({
            contract_address: token.contractAddress,
            token_id: token.onchainTokenId,
          }))
          .filter((token) => token.token_id)
          .map(({ contract_address, token_id }) => [contract_address, token_id])
      )
      .select(
        'contract:smart_contract.address as contract_address',
        'cw721_token.token_id as token_id',
        'cw721_token.id as cw721_token_id'
      );
  }

  // from list contract addresses, get those appopriate records in DB
  async getCw721TrackedContracts(addresses: string[]) {
    return CW721Contract.query()
      .alias('cw721_contract')
      .withGraphJoined('smart_contract')
      .whereIn('smart_contract.address', addresses)
      .andWhere('track', true)
      .select('smart_contract.address as address', 'cw721_contract.id as id');
  }

  // get contract info (minter, symbol, name) by query rpc
  async getContractsInfo(
    contractAddresses: string[]
  ): Promise<IContractInfoAndMinter[]> {
    const promisesInfo: any[] = [];
    const promisesMinter: any[] = [];
    contractAddresses.forEach((address: string) => {
      promisesInfo.push(
        this._httpBatchClient.execute(
          createJsonRpcRequest('abci_query', {
            path: '/cosmwasm.wasm.v1.Query/SmartContractState',
            data: toHex(
              cosmwasm.wasm.v1.QuerySmartContractStateRequest.encode({
                address,
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore
                queryData: toBase64(toUtf8('{"contract_info":{}}')),
              }).finish()
            ),
          })
        )
      );
    });
    contractAddresses.forEach((address: string) => {
      promisesMinter.push(
        this._httpBatchClient.execute(
          createJsonRpcRequest('abci_query', {
            path: '/cosmwasm.wasm.v1.Query/SmartContractState',
            data: toHex(
              cosmwasm.wasm.v1.QuerySmartContractStateRequest.encode({
                address,
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore
                queryData: toBase64(toUtf8('{"minter":{}}')),
              }).finish()
            ),
          })
        )
      );
    });
    const contractsInfo = [];
    const resultsContractsInfo: JsonRpcSuccessResponse[] = await Promise.all(
      promisesInfo
    );
    const resultsMinters: JsonRpcSuccessResponse[] = await Promise.all(
      promisesMinter
    );
    for (let index = 0; index < resultsContractsInfo.length; index += 1) {
      const contractInfo = JSON.parse(
        fromUtf8(
          cosmwasm.wasm.v1.QuerySmartContractStateResponse.decode(
            fromBase64(resultsContractsInfo[index].result.response.value)
          ).data
        )
      );
      const { minter }: { minter: string } = JSON.parse(
        fromUtf8(
          cosmwasm.wasm.v1.QuerySmartContractStateResponse.decode(
            fromBase64(resultsMinters[index].result.response.value)
          ).data
        )
      );
      contractsInfo.push({
        address: contractAddresses[index],
        name: contractInfo.name as string,
        symbol: contractInfo.symbol as string,
        minter,
      });
    }
    return contractsInfo;
  }

  async getCw721ContractEvents(startBlock: number, endBlock: number) {
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
          builder.select('sender');
        },
        selectAttribute(builder) {
          builder.select('key', 'value');
        },
        selectSmartContract(builder) {
          builder.select('address');
        },
      })
      .where('smart_contract:code.type', 'CW721')
      .where('tx.height', '>', startBlock)
      .andWhere('tx.height', '<=', endBlock)
      .select(
        'message.sender as sender',
        'smart_contract.address as contractAddress',
        'smart_contract_event.action',
        'smart_contract_event.event_id',
        'smart_contract_event.index'
      );
  }
}

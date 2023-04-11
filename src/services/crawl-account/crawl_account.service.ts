/* eslint-disable no-await-in-loop */
import {
  Action,
  Service,
} from '@ourparentcenter/moleculer-decorators-extended';
import { Context, ServiceBroker } from 'moleculer';
import { HttpBatchClient } from '@cosmjs/tendermint-rpc';
import { createJsonRpcRequest } from '@cosmjs/tendermint-rpc/build/jsonrpc';
import { fromBase64, fromUtf8, toHex } from '@cosmjs/encoding';
import { cosmos } from '@aura-nw/aurajs';
import { JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import Long from 'long';
import {
  QueryAllBalancesRequest,
  QueryAllBalancesResponse,
  QuerySpendableBalancesRequest,
  QuerySpendableBalancesResponse,
} from '@aura-nw/aurajs/types/codegen/cosmos/bank/v1beta1/query';
import {
  AccountType,
  BULL_JOB_NAME,
  getHttpBatchClient,
  getLcdClient,
  IAuraJSClientFactory,
  ICoin,
  IAddressesParam,
  REDIS_KEY,
  SERVICE,
  ABCI_QUERY_PATH,
} from '../../common';
import BullableService, { QueueHandler } from '../../base/bullable.service';
import config from '../../../config.json' assert { type: 'json' };
import { Account, AccountVesting, BlockCheckpoint } from '../../models';

@Service({
  name: SERVICE.V1.CrawlAccountService.key,
  version: 1,
})
export default class CrawlAccountService extends BullableService {
  private _lcdClient!: IAuraJSClientFactory;

  private _httpBatchClient: HttpBatchClient;

  public constructor(public broker: ServiceBroker) {
    super(broker);
    this._httpBatchClient = getHttpBatchClient();
  }

  @Action({
    name: SERVICE.V1.CrawlAccountService.UpdateAccount.key,
    params: {
      addresses: 'string[]',
    },
  })
  public actionUpdateAccount(ctx: Context<IAddressesParam>) {
    this.createJobAccount(ctx.params.addresses);
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_GENESIS_ACCOUNT,
    jobType: 'crawl',
    prefix: `horoscope-v2-${config.chainId}`,
  })
  public async handleJobCrawlGenesisAccount(_payload: object): Promise<void> {
    const crawlGenesisAccountBlockCheckpoint: BlockCheckpoint | undefined =
      await BlockCheckpoint.query()
        .select('*')
        .findOne('job_name', BULL_JOB_NAME.CRAWL_GENESIS_ACCOUNT);

    if (config.networkPrefixAddress === 'aura') {
      if (
        crawlGenesisAccountBlockCheckpoint &&
        crawlGenesisAccountBlockCheckpoint.height > 0
      )
        return;

      let addresses: string[] = [];

      try {
        const genesis = await this._httpBatchClient.execute(
          createJsonRpcRequest('genesis')
        );

        addresses = genesis.result.genesis.app_state.bank.balances.map(
          (balance: any) => balance.address
        );
      } catch (error: any) {
        if (JSON.parse(error.message).code !== -32603) {
          this.logger.error(error);
          return;
        }

        let genesisChunk = '';
        let index = 0;
        let done = false;
        while (!done) {
          try {
            this.logger.info(`Query genesis_chunked at page ${index}`);
            const resultChunk = await this._httpBatchClient.execute(
              createJsonRpcRequest('genesis_chunked', {
                chunk: index.toString(),
              })
            );

            genesisChunk += fromUtf8(fromBase64(resultChunk.result.data));
            index += 1;
          } catch (err) {
            if (JSON.parse(error.message).code !== -32603) {
              this.logger.error(error);
              return;
            }

            done = true;
          }
        }

        const genesisChunkObject: any = JSON.parse(genesisChunk);
        addresses = genesisChunkObject.app_state.bank.balances.map(
          (balance: any) => balance.address
        );
      }

      const listAccounts: Account[] = [];
      const existedAccounts: string[] = (
        await Account.query().select('*').whereIn('address', addresses)
      ).map((account: Account) => account.address);

      addresses.forEach((address: string) => {
        if (!existedAccounts.includes(address)) {
          const account: Account = Account.fromJson({
            address,
            balances: [],
            spendable_balances: [],
            type: null,
            pubkey: {},
            account_number: 0,
            sequence: 0,
          });
          listAccounts.push(account);
        }
      });

      if (listAccounts.length > 0) await Account.query().insert(listAccounts);

      this.createJobAccount(addresses);
    }

    let updateBlockCheckpoint: BlockCheckpoint;
    if (crawlGenesisAccountBlockCheckpoint) {
      updateBlockCheckpoint = crawlGenesisAccountBlockCheckpoint;
      updateBlockCheckpoint.height = 1;
    } else
      updateBlockCheckpoint = BlockCheckpoint.fromJson({
        job_name: BULL_JOB_NAME.CRAWL_GENESIS_ACCOUNT,
        height: 1,
      });
    await BlockCheckpoint.query()
      .insert(updateBlockCheckpoint)
      .onConflict('job_name')
      .merge()
      .returning('id');
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_ACCOUNT_AUTH,
    jobType: 'crawl',
    prefix: `horoscope-v2-${config.chainId}`,
  })
  public async handleJobAccountAuth(_payload: IAddressesParam): Promise<void> {
    this._lcdClient = await getLcdClient();

    const accounts: Account[] = [];
    const accountVestings: AccountVesting[] = [];

    if (_payload.addresses.length > 0) {
      const accountsInDb: Account[] = await Account.query()
        .select('*')
        .whereIn('address', _payload.addresses);

      await Promise.all(
        accountsInDb.map(async (acc) => {
          this.logger.info(`Crawl account auth address: ${acc.address}`);

          let resultCallApi;
          try {
            resultCallApi =
              await this._lcdClient.auranw.cosmos.auth.v1beta1.account({
                address: acc.address,
              });
          } catch (error) {
            this.logger.error(error);
            throw error;
          }

          const account = acc;
          account.type = resultCallApi.account['@type'];
          switch (resultCallApi.account['@type']) {
            case AccountType.CONTINUOUS_VESTING:
            case AccountType.DELAYED_VESTING:
            case AccountType.PERIODIC_VESTING:
              account.pubkey =
                resultCallApi.account.base_vesting_account.base_account.pub_key;
              account.account_number = Number.parseInt(
                resultCallApi.account.base_vesting_account.base_account
                  .account_number,
                10
              );
              account.sequence = Number.parseInt(
                resultCallApi.account.base_vesting_account.base_account
                  .sequence,
                10
              );
              break;
            case AccountType.MODULE:
              account.pubkey = resultCallApi.account.base_account.pub_key;
              account.account_number = Number.parseInt(
                resultCallApi.account.base_account.account_number,
                10
              );
              account.sequence = Number.parseInt(
                resultCallApi.account.base_account.sequence,
                10
              );
              break;
            default:
              account.pubkey = resultCallApi.account.pub_key;
              account.account_number = Number.parseInt(
                resultCallApi.account.account_number,
                10
              );
              account.sequence = Number.parseInt(
                resultCallApi.account.sequence,
                10
              );
              break;
          }

          accounts.push(account);

          if (
            resultCallApi.account['@type'] === AccountType.CONTINUOUS_VESTING ||
            resultCallApi.account['@type'] === AccountType.DELAYED_VESTING ||
            resultCallApi.account['@type'] === AccountType.PERIODIC_VESTING
          ) {
            const accountVesting: AccountVesting = AccountVesting.fromJson({
              account_id: account.id,
              original_vesting:
                resultCallApi.account.base_vesting_account.original_vesting,
              delegated_free:
                resultCallApi.account.base_vesting_account.delegated_free,
              delegated_vesting:
                resultCallApi.account.base_vesting_account.delegated_vesting,
              start_time: resultCallApi.account.start_time
                ? Number.parseInt(resultCallApi.account.start_time, 10)
                : null,
              end_time: resultCallApi.account.base_vesting_account.end_time,
            });
            accountVestings.push(accountVesting);
          }
        })
      );

      await Account.query()
        .insert(accounts)
        .onConflict('address')
        .merge()
        .returning('id')
        .catch((error) => {
          this.logger.error('Error insert account auth');
          this.logger.error(error);
        });

      if (accountVestings.length > 0) {
        await AccountVesting.query()
          .insert(accountVestings)
          .onConflict('account_id')
          .merge()
          .returning('id')
          .catch((error) => {
            this.logger.error('Error insert account vesting');
            this.logger.error(error);
          });
      }
    }
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_ACCOUNT_BALANCES,
    jobType: 'crawl',
    prefix: `horoscope-v2-${config.chainId}`,
  })
  public async handleJobAccountBalances(
    _payload: IAddressesParam
  ): Promise<void> {
    this._lcdClient = await getLcdClient();

    if (_payload.addresses.length > 0) {
      this.logger.info(`Crawl account balances: ${_payload.addresses}`);

      const accounts: Account[] = await Account.query()
        .select('id', 'address', 'balances')
        .whereIn('address', _payload.addresses);
      accounts.forEach((acc) => {
        acc.balances = [];
      });

      let accountsHaveNext: {
        address: string;
        idx: number;
        next_key: Uint8Array | undefined;
      }[] = accounts.map((acc, idx) => ({
        address: acc.address,
        idx,
        next_key: undefined,
      }));

      let done = false;
      while (!done) {
        const batchQueries: any[] = [];

        // generate queries
        accountsHaveNext.forEach((account) => {
          const request: QueryAllBalancesRequest = {
            address: account.address,
          };
          if (account.next_key)
            request.pagination = {
              key: account.next_key,
              limit: Long.fromInt(1),
              offset: Long.fromInt(0),
              countTotal: false,
              reverse: false,
            };
          const data = toHex(
            cosmos.bank.v1beta1.QueryAllBalancesRequest.encode(request).finish()
          );

          batchQueries.push(
            this._httpBatchClient.execute(
              createJsonRpcRequest('abci_query', {
                path: ABCI_QUERY_PATH.ACCOUNT_ALL_BALANCES,
                data,
              })
            )
          );
        });

        const result: JsonRpcSuccessResponse[] = await Promise.all(
          batchQueries
        );
        // decode result
        const accountBalances: QueryAllBalancesResponse[] = result.map((res) =>
          cosmos.bank.v1beta1.QueryAllBalancesResponse.decode(
            fromBase64(res.result.response.value)
          )
        );

        // map to accounts and extract next key
        const newAccHaveNext = [];
        for (let i = 0; i < accountBalances.length; i += 1) {
          const account = accounts[accountsHaveNext[i].idx];
          account.balances.push(...accountBalances[i].balances);
          if (accountBalances[i].pagination?.nextKey.length || -1 > 0)
            newAccHaveNext.push({
              address: account.address,
              idx: accountsHaveNext[i].idx,
              next_key: accountBalances[i].pagination?.nextKey,
            });
        }
        accountsHaveNext = newAccHaveNext;

        done = accountsHaveNext.length === 0;
      }

      await Promise.all(
        accounts.map(async (account) => {
          if (account.balances.length > 1)
            // eslint-disable-next-line no-param-reassign
            account.balances = await this.handleIbcDenom(account.balances);
        })
      );

      await Account.query()
        .insert(accounts)
        .onConflict('address')
        .merge()
        .returning('id')
        .catch((error) => {
          this.logger.error('Error insert account balance');
          this.logger.error(error);
        });
    }
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_ACCOUNT_SPENDABLE_BALANCES,
    jobType: 'crawl',
    prefix: `horoscope-v2-${config.chainId}`,
  })
  public async handleJobAccountSpendableBalances(
    _payload: IAddressesParam
  ): Promise<void> {
    this._lcdClient = await getLcdClient();

    if (_payload.addresses.length > 0) {
      this.logger.info(
        `Crawl account spendable balances: ${_payload.addresses}`
      );

      const accounts: Account[] = await Account.query()
        .select('id', 'address', 'spendable_balances')
        .whereIn('address', _payload.addresses);
      accounts.forEach((acc) => {
        acc.spendable_balances = [];
      });

      let accountsHaveNext: {
        address: string;
        idx: number;
        next_key: Uint8Array | undefined;
      }[] = accounts.map((acc, idx) => ({
        address: acc.address,
        idx,
        next_key: undefined,
      }));

      let done = false;
      while (!done) {
        const batchQueries: any[] = [];

        // generate queries
        accountsHaveNext.forEach((account) => {
          const request: QuerySpendableBalancesRequest = {
            address: account.address,
          };
          if (account.next_key)
            request.pagination = {
              key: account.next_key,
              limit: Long.fromInt(1),
              offset: Long.fromInt(0),
              countTotal: false,
              reverse: false,
            };
          const data = toHex(
            cosmos.bank.v1beta1.QuerySpendableBalancesRequest.encode(
              request
            ).finish()
          );

          batchQueries.push(
            this._httpBatchClient.execute(
              createJsonRpcRequest('abci_query', {
                path: ABCI_QUERY_PATH.ACCOUNT_SPENDABLE_BALANCES,
                data,
              })
            )
          );
        });

        const result: JsonRpcSuccessResponse[] = await Promise.all(
          batchQueries
        );
        // decode result
        const accountSpendableBalances: QuerySpendableBalancesResponse[] =
          result.map((res) =>
            cosmos.bank.v1beta1.QuerySpendableBalancesResponse.decode(
              fromBase64(res.result.response.value)
            )
          );

        // map to accounts and extract next key
        const newAccHaveNext = [];
        for (let i = 0; i < accountSpendableBalances.length; i += 1) {
          const account = accounts[accountsHaveNext[i].idx];
          account.spendable_balances.push(
            ...accountSpendableBalances[i].balances
          );
          if (accountSpendableBalances[i].pagination?.nextKey.length || -1 > 0)
            newAccHaveNext.push({
              address: account.address,
              idx: accountsHaveNext[i].idx,
              next_key: accountSpendableBalances[i].pagination?.nextKey,
            });
        }
        accountsHaveNext = newAccHaveNext;

        done = accountsHaveNext.length === 0;
      }

      await Promise.all(
        accounts.map(async (account) => {
          if (account.spendable_balances.length > 1)
            // eslint-disable-next-line no-param-reassign
            account.spendable_balances = await this.handleIbcDenom(
              account.spendable_balances
            );
        })
      );

      await Account.query()
        .insert(accounts)
        .onConflict('address')
        .merge()
        .returning('id')
        .catch((error) => {
          this.logger.error('Error insert account stake spendable balance');
          this.logger.error(error);
        });
    }
  }

  private async handleIbcDenom(balances: ICoin[]) {
    const result = await Promise.all(
      balances.map(async (balance) => {
        if (balance.denom.startsWith('ibc/')) {
          const hash = balance.denom.split('/')[1];
          let ibcDenomRedis = await this.broker.cacher?.get(
            REDIS_KEY.IBC_DENOM
          );
          if (ibcDenomRedis === undefined || ibcDenomRedis === null)
            ibcDenomRedis = [];
          const ibcDenom = ibcDenomRedis?.find(
            (ibc: any) => ibc.hash === balance.denom
          );
          if (ibcDenom) {
            return {
              amount: balance.amount,
              denom: balance.denom,
              base_denom: ibcDenom.base_denom,
            };
          }

          let denomResult;
          try {
            denomResult =
              await this._lcdClient.ibc.ibc.applications.transfer.v1.denomTrace(
                { hash }
              );

            ibcDenomRedis?.push({
              base_denom: denomResult.denom_trace.base_denom,
              hash: balance.denom,
            });
            await this.broker.cacher?.set(REDIS_KEY.IBC_DENOM, ibcDenomRedis);
          } catch (error) {
            this.logger.error(error);
            throw error;
          }

          return {
            amount: balance.amount,
            denom: balance.denom,
            base_denom: denomResult.denom_trace.base_denom,
          };
        }
        return balance;
      })
    );

    return result;
  }

  private createJobAccount(addresses: string[]) {
    this.createJob(
      BULL_JOB_NAME.CRAWL_ACCOUNT_AUTH,
      'crawl',
      {
        addresses,
      },
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
      }
    );
    this.createJob(
      BULL_JOB_NAME.CRAWL_ACCOUNT_BALANCES,
      'crawl',
      {
        addresses,
      },
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
      }
    );
    this.createJob(
      BULL_JOB_NAME.CRAWL_ACCOUNT_SPENDABLE_BALANCES,
      'crawl',
      {
        addresses,
      },
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
      }
    );
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.HANDLE_VESTING_ACCOUNT,
    jobType: 'crawl',
    prefix: `horoscope-v2-${config.chainId}`,
  })
  public async handleVestingAccounts(_payload: object): Promise<void> {
    const addresses: string[] = [];

    const now = Math.floor(
      new Date().setSeconds(new Date().getSeconds() - 6) / 1000
    );
    let offset = 0;
    let done = false;
    while (!done) {
      const result = await Account.query()
        .joinRelated('vesting')
        .where((builder) =>
          builder
            .whereIn('account.type', [
              AccountType.CONTINUOUS_VESTING,
              AccountType.PERIODIC_VESTING,
            ])
            .andWhere('vesting.end_time', '>=', now)
        )
        .orWhere((builder) =>
          builder
            .where('account.type', AccountType.DELAYED_VESTING)
            .andWhere('vesting.end_time', '<=', now)
        )
        .select('account.address')
        .page(offset, 1000);

      if (result.results.length > 0) {
        result.results.map((res) => addresses.push(res.address));
        offset += 1;
      } else done = true;
    }

    await this.handleJobAccountSpendableBalances({
      addresses,
    });
  }

  public async _start() {
    this.createJob(
      BULL_JOB_NAME.CRAWL_GENESIS_ACCOUNT,
      'crawl',
      {},
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
      }
    );
    this.createJob(
      BULL_JOB_NAME.HANDLE_VESTING_ACCOUNT,
      'crawl',
      {},
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
        repeat: {
          every: config.crawlAccount.handleVestingAccount.millisecondCrawl,
        },
      }
    );

    return super._start();
  }
}

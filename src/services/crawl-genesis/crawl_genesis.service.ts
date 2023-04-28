/* eslint-disable no-param-reassign */
/* eslint-disable no-await-in-loop */
import { Service } from '@ourparentcenter/moleculer-decorators-extended';
import { ServiceBroker } from 'moleculer';
import { HttpBatchClient } from '@cosmjs/tendermint-rpc';
import { createJsonRpcRequest } from '@cosmjs/tendermint-rpc/build/jsonrpc';
import { fromBase64, fromUtf8, toHex, toUtf8 } from '@cosmjs/encoding';
import fs from 'fs';
import _ from 'lodash';
import { QueryDenomTraceRequest } from '@aura-nw/aurajs/types/codegen/ibc/applications/transfer/v1/query';
import { ibc } from '@aura-nw/aurajs';
import { JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import Utils from '../../common/utils/utils';
import {
  Account,
  BlockCheckpoint,
  Code,
  Proposal,
  SmartContract,
  Validator,
} from '../../models';
import BullableService, { QueueHandler } from '../../base/bullable.service';
import {
  ABCI_QUERY_PATH,
  AccountType,
  BULL_JOB_NAME,
  getHttpBatchClient,
  MSG_TYPE,
  REDIS_KEY,
  SERVICE,
} from '../../common';
import config from '../../../config.json' assert { type: 'json' };

@Service({
  name: SERVICE.V1.CrawlGenesisService.key,
  version: 1,
})
export default class CrawlGenesisService extends BullableService {
  private _httpBatchClient: HttpBatchClient;

  private genesisJobs: string[] = [
    BULL_JOB_NAME.CRAWL_GENESIS_ACCOUNT,
    BULL_JOB_NAME.CRAWL_GENESIS_VALIDATOR,
    BULL_JOB_NAME.CRAWL_GENESIS_PROPOSAL,
    BULL_JOB_NAME.CRAWL_GENESIS_CODE,
    BULL_JOB_NAME.CRAWL_GENESIS_CONTRACT,
  ];

  public constructor(public broker: ServiceBroker) {
    super(broker);
    this._httpBatchClient = getHttpBatchClient();
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_GENESIS,
    jobType: 'crawl',
    prefix: `horoscope-v2-${config.chainId}`,
  })
  public async handleGenesis(_payload: object): Promise<void> {
    const genesisBlkCheck: BlockCheckpoint | undefined =
      await BlockCheckpoint.query()
        .select('*')
        .findOne('job_name', BULL_JOB_NAME.CRAWL_GENESIS);

    if (genesisBlkCheck && genesisBlkCheck.height > 0) {
      this.logger.info('Genesis job had already been processed');
      await this.terminateProcess();
      return;
    }

    if (!fs.existsSync('genesis.txt')) fs.appendFileSync('genesis.txt', '');

    let genesis;
    try {
      genesis = await this._httpBatchClient.execute(
        createJsonRpcRequest('genesis')
      );

      fs.appendFileSync('genesis.txt', JSON.stringify(genesis));
    } catch (error: any) {
      if (JSON.parse(error.message).code !== -32603) {
        this.logger.error(error);
        return;
      }

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

          fs.appendFileSync(
            'genesis.txt',
            fromUtf8(fromBase64(resultChunk.result.data))
          );
          index += 1;
        } catch (err) {
          if (JSON.parse(error.message).code !== -32603) {
            this.logger.error(error);
            return;
          }

          done = true;
        }
      }
    }

    let updateBlkCheck: BlockCheckpoint;
    if (genesisBlkCheck) {
      updateBlkCheck = genesisBlkCheck;
      updateBlkCheck.height = 1;
    } else
      updateBlkCheck = BlockCheckpoint.fromJson({
        job_name: BULL_JOB_NAME.CRAWL_GENESIS,
        height: 1,
      });
    await BlockCheckpoint.query()
      .insert(updateBlkCheck)
      .onConflict('job_name')
      .merge()
      .returning('id');

    this.genesisJobs.forEach(async (job) => {
      if (job !== BULL_JOB_NAME.CRAWL_GENESIS_CONTRACT) {
        await this.createJob(
          job,
          'crawl',
          {},
          {
            removeOnComplete: true,
            removeOnFail: {
              count: 3,
            },
          }
        );
      }
    });
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_GENESIS_ACCOUNT,
    jobType: 'crawl',
    prefix: `horoscope-v2-${config.chainId}`,
  })
  public async crawlGenesisAccounts(_payload: object): Promise<void> {
    this.logger.info('Crawl genesis accounts');

    const [accountsInDb, genesisCheckpoint]: [
      Account[],
      BlockCheckpoint[] | undefined
    ] = await Promise.all([
      Account.query(),
      BlockCheckpoint.query()
        .select('*')
        .whereIn('job_name', [
          BULL_JOB_NAME.CRAWL_GENESIS,
          BULL_JOB_NAME.CRAWL_GENESIS_ACCOUNT,
        ]),
    ]);
    if (
      genesisCheckpoint.find(
        (check) => check.job_name === BULL_JOB_NAME.CRAWL_GENESIS
      )?.height !== 1
    ) {
      this.logger.info('Job crawl genesis is still processing');
      return;
    }
    if (
      genesisCheckpoint.find(
        (check) => check.job_name === BULL_JOB_NAME.CRAWL_GENESIS_ACCOUNT
      )?.height === 1
    ) {
      this.logger.info('Job crawl genesis accounts had already been processed');
      return;
    }
    if (accountsInDb.length > 0) {
      this.logger.error('DB already contains some accounts');
      return;
    }

    let genesis = JSON.parse(fs.readFileSync('genesis.txt').toString());
    if (genesis.result) genesis = genesis.result.genesis;

    const { balances } = genesis.app_state.bank;
    const auths: any = _.keyBy(
      genesis.result?.genesis.app_state.auth.accounts.map((acc: any) =>
        Utils.flattenObject(acc)
      ) ||
        genesis.app_state.auth.accounts.map((acc: any) =>
          Utils.flattenObject(acc)
        ),
      'address'
    );

    let accounts: Account[] = [];

    balances.forEach((bal: any) => {
      const account: any = {
        address: bal.address,
        balances: bal.coins,
        spendable_balances: bal.coins,
        type: auths[bal.address]['@type'],
        pubkey: auths[bal.address].pub_key,
        account_number: Number.parseInt(auths[bal.address].account_number, 10),
        sequence: Number.parseInt(auths[bal.address].sequence, 10),
      };
      if (
        account.type === AccountType.CONTINUOUS_VESTING ||
        account.type === AccountType.DELAYED_VESTING ||
        account.type === AccountType.PERIODIC_VESTING
      )
        account.vesting = {
          original_vesting: auths[bal.address].original_vesting,
          delegated_free: auths[bal.address].delegated_free,
          delegated_vesting: auths[bal.address].delegated_vesting,
          start_time: auths[bal.address].start_time
            ? Number.parseInt(auths[bal.address].start_time, 10)
            : null,
          end_time: auths[bal.address].end_time,
        };

      accounts.push(account);
    });

    accounts = await this.handleIbcDenom(accounts);

    if (accounts.length > 0) {
      await Promise.all(
        _.chunk(accounts, 5000).map(async (chunkAccounts, index) => {
          this.logger.info(`Insert batch of 5000 accounts number ${index}`);
          await Account.query().insertGraph(chunkAccounts);
        })
      );
    }

    await BlockCheckpoint.query()
      .insert(
        BlockCheckpoint.fromJson({
          job_name: BULL_JOB_NAME.CRAWL_GENESIS_ACCOUNT,
          height: 1,
        })
      )
      .onConflict('job_name')
      .merge()
      .returning('id');

    await this.terminateProcess();
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_GENESIS_VALIDATOR,
    jobType: 'crawl',
    prefix: `horoscope-v2-${config.chainId}`,
  })
  public async crawlGenesisValidators(_payload: object): Promise<void> {
    this.logger.info('Crawl genesis validators');

    const genesisCheckpoint = await BlockCheckpoint.query()
      .select('*')
      .whereIn('job_name', [
        BULL_JOB_NAME.CRAWL_GENESIS,
        BULL_JOB_NAME.CRAWL_GENESIS_VALIDATOR,
      ]);
    if (
      genesisCheckpoint.find(
        (check) => check.job_name === BULL_JOB_NAME.CRAWL_GENESIS
      )?.height !== 1
    ) {
      this.logger.info('Job crawl genesis is still processing');
      return;
    }
    if (
      genesisCheckpoint.find(
        (check) => check.job_name === BULL_JOB_NAME.CRAWL_GENESIS_VALIDATOR
      )?.height === 1
    ) {
      this.logger.info(
        'Job crawl genesis validators had already been processed'
      );
      return;
    }

    let genesis = JSON.parse(fs.readFileSync('genesis.txt').toString());
    if (genesis.result) genesis = genesis.result.genesis;

    let genValidators = genesis.app_state.genutil.gen_txs
      .map((genTx: any) =>
        genTx.body.messages.filter(
          (msg: any) => msg['@type'] === MSG_TYPE.MSG_CREATE_VALIDATOR
        )
      )
      .flat();
    if (genValidators.length === 0)
      genValidators = genesis.app_state.staking.validators;
    else
      genValidators.forEach((genVal: any) => {
        genVal.consensus_pubkey = genVal.pubkey;
        genVal.operator_address = genVal.validator_address;
        genVal.jailed = false;
        genVal.status = 'BOND_STATUS_BONDED';
        genVal.tokens = genVal.value.amount;
        genVal.delegator_shares = genVal.value.amount;
        genVal.unbonding_height = '0';
        genVal.unbonding_time = new Date(0).toISOString();
      });

    const validators: Validator[] = [];
    genValidators.forEach((genVal: any) => {
      validators.push(Validator.createNewValidator(genVal));
    });

    this.logger.info('Insert genesis validators');
    await Validator.query()
      .insert(validators)
      .onConflict('operator_address')
      .merge()
      .returning('id');

    await BlockCheckpoint.query()
      .insert(
        BlockCheckpoint.fromJson({
          job_name: BULL_JOB_NAME.CRAWL_GENESIS_VALIDATOR,
          height: 1,
        })
      )
      .onConflict('job_name')
      .merge()
      .returning('id');

    await this.terminateProcess();
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_GENESIS_PROPOSAL,
    jobType: 'crawl',
    prefix: `horoscope-v2-${config.chainId}`,
  })
  public async crawlGenesisProposals(_payload: object): Promise<void> {
    this.logger.info('Crawl genesis proposals');

    const genesisCheckpoint = await BlockCheckpoint.query()
      .select('*')
      .whereIn('job_name', [
        BULL_JOB_NAME.CRAWL_GENESIS,
        BULL_JOB_NAME.CRAWL_GENESIS_PROPOSAL,
      ]);
    if (
      genesisCheckpoint.find(
        (check) => check.job_name === BULL_JOB_NAME.CRAWL_GENESIS
      )?.height !== 1
    ) {
      this.logger.info('Job crawl genesis is still processing');
      return;
    }
    if (
      genesisCheckpoint.find(
        (check) => check.job_name === BULL_JOB_NAME.CRAWL_GENESIS_PROPOSAL
      )?.height === 1
    ) {
      this.logger.info(
        'Job crawl genesis proposals had already been processed'
      );
      return;
    }

    let genesis = JSON.parse(fs.readFileSync('genesis.txt').toString());
    if (genesis.result) genesis = genesis.result.genesis;

    const genProposals = genesis.app_state.gov.proposals;

    if (genProposals.length > 0) {
      const proposals: Proposal[] = [];
      genProposals.forEach(async (propose: any) => {
        proposals.push(await Proposal.createNewProposal(propose));
      });

      this.logger.info('Insert genesis proposals');
      await Proposal.query()
        .insert(proposals)
        .onConflict('proposal_id')
        .merge()
        .returning('proposal_id');
    }

    await BlockCheckpoint.query()
      .insert(
        BlockCheckpoint.fromJson({
          job_name: BULL_JOB_NAME.CRAWL_GENESIS_PROPOSAL,
          height: 1,
        })
      )
      .onConflict('job_name')
      .merge()
      .returning('id');

    await this.terminateProcess();
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_GENESIS_CODE,
    jobType: 'crawl',
    prefix: `horoscope-v2-${config.chainId}`,
  })
  public async crawlGenesisCodes(_payload: object): Promise<void> {
    this.logger.info('Crawl genesis codes');

    let done = false;

    const genesisCheckpoint = await BlockCheckpoint.query()
      .select('*')
      .whereIn('job_name', [
        BULL_JOB_NAME.CRAWL_GENESIS,
        BULL_JOB_NAME.CRAWL_GENESIS_CODE,
      ]);
    if (
      genesisCheckpoint.find(
        (check) => check.job_name === BULL_JOB_NAME.CRAWL_GENESIS
      )?.height !== 1
    ) {
      this.logger.info('Job crawl genesis is still processing');
      return;
    }
    if (
      genesisCheckpoint.find(
        (check) => check.job_name === BULL_JOB_NAME.CRAWL_GENESIS_CODE
      )?.height === 1
    ) {
      this.logger.info('Job crawl genesis codes had already been processed');
      done = true;
    }

    if (!done) {
      let genesis = JSON.parse(fs.readFileSync('genesis.txt').toString());
      if (genesis.result) genesis = genesis.result.genesis;

      const genCodes = genesis.app_state.wasm.codes;

      if (genCodes.length > 0) {
        const codes: Code[] = [];
        genCodes.forEach((code: any) => {
          codes.push(
            Code.fromJson({
              code_id: parseInt(code.code_id, 10),
              creator: code.code_info.creator,
              data_hash: toHex(toUtf8(code.code_info.code_hash)).toLowerCase(),
              instantiate_permission: code.code_info.instantiate_config,
              type: null,
              status: null,
              store_hash: '',
              store_height: 0,
            })
          );
        });

        this.logger.info('Insert genesis codes');
        await Code.query()
          .insert(codes)
          .onConflict('code_id')
          .merge()
          .returning('code_id');
      }

      await BlockCheckpoint.query()
        .insert(
          BlockCheckpoint.fromJson({
            job_name: BULL_JOB_NAME.CRAWL_GENESIS_CODE,
            height: 1,
          })
        )
        .onConflict('job_name')
        .merge()
        .returning('id');
    }

    await this.createJob(
      BULL_JOB_NAME.CRAWL_GENESIS_CONTRACT,
      'crawl',
      {},
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
      }
    );

    await this.terminateProcess();
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_GENESIS_CONTRACT,
    jobType: 'crawl',
    prefix: `horoscope-v2-${config.chainId}`,
  })
  public async crawlGenesisContracts(_payload: object): Promise<void> {
    this.logger.info('Crawl genesis contracts');

    const genesisCheckpoint = await BlockCheckpoint.query()
      .select('*')
      .whereIn('job_name', [
        BULL_JOB_NAME.CRAWL_GENESIS,
        BULL_JOB_NAME.CRAWL_GENESIS_CONTRACT,
      ]);
    if (
      genesisCheckpoint.find(
        (check) => check.job_name === BULL_JOB_NAME.CRAWL_GENESIS
      )?.height !== 1
    ) {
      this.logger.info('Job crawl genesis is still processing');
      return;
    }
    if (
      genesisCheckpoint.find(
        (check) => check.job_name === BULL_JOB_NAME.CRAWL_GENESIS_CONTRACT
      )?.height === 1
    ) {
      this.logger.info(
        'Job crawl genesis contracts had already been processed'
      );
      return;
    }

    let genesis = JSON.parse(fs.readFileSync('genesis.txt').toString());
    if (genesis.result) genesis = genesis.result.genesis;

    const genContracts = genesis.app_state.wasm.contracts;

    if (genContracts.length > 0) {
      const contracts: SmartContract[] = [];
      genContracts.forEach((contract: any) => {
        contracts.push(
          SmartContract.fromJson({
            name: null,
            address: contract.contract_address,
            creator: contract.contract_info.creator,
            code_id: contract.contract_info.code_id,
            instantiate_hash: '',
            instantiate_height: 0,
            version: null,
          })
        );
      });

      this.logger.info('Insert genesis smart contracts');
      await SmartContract.query()
        .insert(contracts)
        .onConflict('address')
        .merge()
        .returning('address');
    }

    await BlockCheckpoint.query()
      .insert(
        BlockCheckpoint.fromJson({
          job_name: BULL_JOB_NAME.CRAWL_GENESIS_CONTRACT,
          height: 1,
        })
      )
      .onConflict('job_name')
      .merge()
      .returning('id');

    await this.terminateProcess();
  }

  private async handleIbcDenom(accounts: Account[]): Promise<Account[]> {
    if (accounts.length === 0) return [];

    this.logger.info('Handle IBC denom');
    let ibcDenomRedis = await this.broker.cacher?.get(REDIS_KEY.IBC_DENOM);
    if (ibcDenomRedis === undefined || ibcDenomRedis === null)
      ibcDenomRedis = {};

    let ibcDenoms: string[] = [];
    const batchQueries: any[] = [];

    accounts.forEach((account) => {
      account.balances.forEach((balance) => {
        if (balance.denom.startsWith('ibc/')) {
          if (ibcDenomRedis && !ibcDenomRedis[balance.denom])
            ibcDenoms.push(balance.denom);
        }
      });
    });

    if (ibcDenoms.length > 0) {
      // Filter unique hashes
      ibcDenoms = Array.from(new Set(ibcDenoms));
      ibcDenoms.forEach((hash) => {
        const request: QueryDenomTraceRequest = {
          hash,
        };
        const data = toHex(
          ibc.applications.transfer.v1.QueryDenomTraceRequest.encode(
            request
          ).finish()
        );
        batchQueries.push(
          this._httpBatchClient.execute(
            createJsonRpcRequest('abci_query', {
              path: ABCI_QUERY_PATH.DENOM_TRACE,
              data,
            })
          )
        );
      });

      const resultIbcDenom: JsonRpcSuccessResponse[] = await Promise.all(
        batchQueries
      );
      const ibcDenomResponses = resultIbcDenom.map((res, index) => ({
        hash: ibcDenoms[index],
        ...ibc.applications.transfer.v1.QueryDenomTraceResponse.decode(
          fromBase64(res.result.response.value)
        ).denomTrace,
      }));

      ibcDenomResponses.forEach((denomTrace) => {
        if (ibcDenomRedis)
          ibcDenomRedis[denomTrace.hash] = denomTrace.baseDenom;
      });
      await this.broker.cacher?.set(REDIS_KEY.IBC_DENOM, ibcDenomRedis);
    }

    accounts.forEach((account) => {
      account.balances.forEach((balance) => {
        if (balance.denom.startsWith('ibc/') && ibcDenomRedis) {
          balance.base_denom = ibcDenomRedis[balance.denom];
        }
      });
    });

    return accounts;
  }

  private async terminateProcess() {
    const checkpoint = await BlockCheckpoint.query().whereIn(
      'job_name',
      this.genesisJobs
    );

    if (
      checkpoint.length < this.genesisJobs.length ||
      checkpoint.find((check) => check.height !== 1)
    ) {
      this.logger.info('Crawl genesis jobs are still processing');
      return;
    }
    process.exit();
  }

  public async _start() {
    this.createJob(
      BULL_JOB_NAME.CRAWL_GENESIS,
      'crawl',
      {},
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
      }
    );

    return super._start();
  }
}

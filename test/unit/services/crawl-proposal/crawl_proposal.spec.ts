import { AfterAll, BeforeAll, Describe, Test } from '@jest-decorated/core';
import { ServiceBroker } from 'moleculer';
import { coins, DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import {
  assertIsDeliverTxSuccess,
  MsgSubmitProposalEncodeObject,
  SigningStargateClient,
} from '@cosmjs/stargate';
import { cosmos } from '@aura-nw/aurajs';
import {
  Account,
  Block,
  BlockCheckpoint,
  Proposal,
  Transaction,
} from '../../../../src/models';
import { BULL_JOB_NAME } from '../../../../src/common';
import CrawlProposalService from '../../../../src/services/crawl-proposal/crawl_proposal.service';
import CrawlTallyProposalService from '../../../../src/services/crawl-proposal/crawl_tally_proposal.service';
import config from '../../../../config.json' assert { type: 'json' };
import network from '../../../../network.json' assert { type: 'json' };
import {
  defaultSendFee,
  defaultSigningClientOptions,
} from '../../../helper/constant';
import knex from '../../../../src/common/utils/db_connection';

@Describe('Test crawl_proposal service')
export default class CrawlProposalTest {
  account: Account = Account.fromJson(
    Account.fromJson({
      address: 'aura1qwexv7c6sm95lwhzn9027vyu2ccneaqa7c24zk',
      balances: [],
      spendable_balances: [],
      type: null,
      pubkey: {},
      account_number: 0,
      sequence: 0,
    })
  );

  block: Block = Block.fromJson({
    height: 3967530,
    hash: '4801997745BDD354C8F11CE4A4137237194099E664CD8F83A5FBA9041C43FE9F',
    time: '2023-01-12T01:53:57.216Z',
    proposer_address: 'auraomd;cvpio3j4eg',
    data: {},
  });

  txInsert = {
    ...Transaction.fromJson({
      height: 3967530,
      hash: '4A8B0DE950F563553A81360D4782F6EC451F6BEF7AC50E2459D1997FA168997D',
      codespace: '',
      code: 0,
      gas_used: '123035',
      gas_wanted: '141106',
      gas_limit: '141106',
      fee: 353,
      timestamp: '2023-01-12T01:53:57.000Z',
      data: {},
    }),
    messages: {
      sender: 'aura1qwexv7c6sm95lwhzn9027vyu2ccneaqa7c24zk',
      index: 0,
      type: '/cosmos.gov.v1beta1.MsgSubmitProposal',
      content: {
        initial_deposit: [
          {
            denom: 'uaura',
            amount: '100000',
          },
        ],
        proposer: 'aura1qwexv7c6sm95lwhzn9027vyu2ccneaqa7c24zk',
      },
    },
    events: [
      {
        tx_msg_index: 0,
        type: 'submit_proposal',
        attributes: {
          key: 'proposal_id',
          value: '1',
        },
      },
      {
        tx_msg_index: 0,
        type: 'submit_proposal',
        attributes: [
          {
            key: 'proposal_id',
            value: '1',
          },
          {
            key: 'proposal_type',
            value: 'CommunityPoolSpend',
          },
        ],
      },
    ],
  };

  broker = new ServiceBroker({ logger: false });

  crawlProposalService?: CrawlProposalService;

  crawlTallyProposalService?: CrawlTallyProposalService;

  @BeforeAll()
  async initSuite() {
    await this.broker.start();
    this.crawlProposalService = this.broker.createService(
      CrawlProposalService
    ) as CrawlProposalService;
    this.crawlTallyProposalService = this.broker.createService(
      CrawlTallyProposalService
    ) as CrawlTallyProposalService;
    await Promise.all([
      this.crawlProposalService
        .getQueueManager()
        .getQueue(BULL_JOB_NAME.CRAWL_PROPOSAL)
        .empty(),
      this.crawlProposalService
        .getQueueManager()
        .getQueue(BULL_JOB_NAME.HANDLE_NOT_ENOUGH_DEPOSIT_PROPOSAL)
        .empty(),
      this.crawlTallyProposalService
        .getQueueManager()
        .getQueue(BULL_JOB_NAME.CRAWL_TALLY_PROPOSAL)
        .empty(),
    ]);
    await Promise.all([
      BlockCheckpoint.query().delete(true),
      knex.raw('TRUNCATE TABLE block RESTART IDENTITY CASCADE'),
      knex.raw('TRUNCATE TABLE account RESTART IDENTITY CASCADE'),
    ]);
    await Block.query().insert(this.block);
    await Transaction.query().insertGraph(this.txInsert);
    await Account.query().insert(this.account);
  }

  @AfterAll()
  async tearDown() {
    await Promise.all([
      BlockCheckpoint.query().delete(true),
      knex.raw('TRUNCATE TABLE block RESTART IDENTITY CASCADE'),
      knex.raw('TRUNCATE TABLE account RESTART IDENTITY CASCADE'),
    ]);
    await this.broker.stop();
  }

  @Test('Crawl new proposal success')
  public async testCrawlNewProposal() {
    const amount = coins(10000000, 'uaura');
    const memo = 'test create proposal';

    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(
      'symbol force gallery make bulk round subway violin worry mixture penalty kingdom boring survey tool fringe patrol sausage hard admit remember broken alien absorb',
      {
        prefix: 'aura',
      }
    );
    const client = await SigningStargateClient.connectWithSigner(
      network.find((net) => net.chainId === config.chainId)?.RPC[0] ?? '',
      wallet,
      defaultSigningClientOptions
    );

    const msgSubmitProposal: MsgSubmitProposalEncodeObject = {
      typeUrl: '/cosmos.gov.v1beta1.MsgSubmitProposal',
      value: cosmos.gov.v1beta1.MsgSubmitProposal.fromPartial({
        content: {
          typeUrl: '/cosmos.gov.v1beta1.TextProposal',
          value: Uint8Array.from(
            cosmos.gov.v1beta1.TextProposal.encode(
              cosmos.gov.v1beta1.TextProposal.fromPartial({
                title: 'Community Pool Spend test 1',
                description: 'Test 1',
              })
            ).finish()
          ),
        },
        initialDeposit: amount,
        proposer: 'aura1qwexv7c6sm95lwhzn9027vyu2ccneaqa7c24zk',
      }),
    };
    const result = await client.signAndBroadcast(
      'aura1qwexv7c6sm95lwhzn9027vyu2ccneaqa7c24zk',
      [msgSubmitProposal],
      defaultSendFee,
      memo
    );
    assertIsDeliverTxSuccess(result);

    await this.crawlProposalService?.handleCrawlProposals({});

    const [newProposal, proposer]: [Proposal | undefined, Account | undefined] =
      await Promise.all([
        Proposal.query().where('proposal_id', 1).first(),
        Account.query()
          .where('address', 'aura1qwexv7c6sm95lwhzn9027vyu2ccneaqa7c24zk')
          .first(),
      ]);

    expect(newProposal?.proposal_id).toEqual(1);
    expect(newProposal?.proposer_id).toEqual(proposer?.id);
    expect(newProposal?.type).toEqual('/cosmos.gov.v1beta1.TextProposal');
    expect(newProposal?.title).toEqual('Community Pool Spend test 1');
    expect(newProposal?.description).toEqual('Test 1');
  }

  @Test('Handle not enough deposit proposal success')
  public async testHandleNotEnoughDepositProposal() {
    await Proposal.query()
      .patch({
        deposit_end_time: new Date(new Date().getSeconds() - 10).toISOString(),
        status: Proposal.STATUS.PROPOSAL_STATUS_DEPOSIT_PERIOD,
      })
      .where({ proposal_id: 1 });

    await this.crawlProposalService?.handleNotEnoughDepositProposals({});

    const updateProposal = await Proposal.query()
      .select('*')
      .where('proposal_id', 1)
      .first();

    expect(updateProposal?.status).toEqual(
      Proposal.STATUS.PROPOSAL_STATUS_NOT_ENOUGH_DEPOSIT
    );
  }
}

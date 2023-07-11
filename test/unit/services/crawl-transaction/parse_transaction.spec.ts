/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
import { AfterEach, BeforeEach, Describe, Test } from '@jest-decorated/core';
import { ServiceBroker } from 'moleculer';
import { Log } from '@cosmjs/stargate/build/logs';
import { Attribute, Event } from '@cosmjs/stargate/build/events';
import {
  Transaction,
  Event as EventModel,
  Block,
} from '../../../../src/models';
import CrawlTxService from '../../../../src/services/crawl-tx/crawl_tx.service';
import knex from '../../../../src/common/utils/db_connection';
import tx_fixture from './tx.fixture.json' assert { type: 'json' };
import tx_fixture_authz from './tx_authz.fixture.json' assert { type: 'json' };

@Describe('Test crawl transaction service')
export default class CrawlTransactionTest {
  broker = new ServiceBroker({ logger: false });

  crawlTxService?: CrawlTxService;

  @BeforeEach()
  async initSuite() {
    this.crawlTxService = this.broker.createService(
      CrawlTxService
    ) as CrawlTxService;
    this.crawlTxService?.getQueueManager().stopAll();
    await Promise.all([
      knex.raw('TRUNCATE TABLE block RESTART IDENTITY CASCADE'),
      knex.raw('TRUNCATE TABLE block_checkpoint RESTART IDENTITY CASCADE'),
    ]);
    await this.crawlTxService._start();
  }

  @Test('Parse transaction and insert to DB')
  public async testHandleTransaction() {
    await Block.query().insert(
      Block.fromJson({
        height: 423136,
        hash: 'data hash',
        time: '2023-04-17T03:44:41.000Z',
        proposer_address: 'proposer address',
        data: {},
      })
    );

    const listdecodedTx = await this.crawlTxService?.decodeListRawTx([
      {
        listTx: { ...tx_fixture },
        height: 423136,
        timestamp: '2023-04-17T03:44:41.000Z',
      },
    ]);
    if (listdecodedTx)
      await knex.transaction(async (trx) => {
        await this.crawlTxService?.insertDecodedTxAndRelated(
          listdecodedTx,
          trx
        );
      });

    const tx = await Transaction.query().findOne(
      'hash',
      '5F38B0C3E9FAB4423C37FB6306AC06D983AF50013BC7BCFBD9F684D6BFB0AF23'
    );
    expect(tx).not.toBeUndefined();
    if (tx) {
      const logs = JSON.parse(tx_fixture.txs[0].tx_result.log);
      const eventAttributes = await EventModel.query()
        .select(
          'attributes.composite_key',
          'attributes.value',
          'event.tx_msg_index'
        )
        .joinRelated('attributes')
        .where('event.tx_id', tx.id);

      logs.forEach((log: Log) => {
        const msgIndex = log.msg_index ?? 0;
        log.events.forEach((event: Event) => {
          event.attributes.forEach((attribute: Attribute) => {
            const found = eventAttributes.find(
              (item) =>
                item.composite_key === `${event.type}.${attribute.key}` &&
                item.value === attribute.value &&
                item.tx_msg_index === msgIndex
            );

            expect(found).not.toBeUndefined();
          });
        });
      });
    }
  }

  @Test('Parse transaction authz and insert to DB')
  public async testHandleTransactionAuthz() {
    await Block.query().insert(
      Block.fromJson({
        height: 452049,
        hash: 'data hash authz',
        time: '2023-04-17T03:44:41.000Z',
        proposer_address: 'proposer address',
        data: {},
      })
    );
    const listdecodedTx = await this.crawlTxService?.decodeListRawTx([
      {
        listTx: { ...tx_fixture_authz },
        height: 452049,
        timestamp: '2023-04-17T03:44:41.000Z',
      },
    ]);
    if (listdecodedTx)
      await knex.transaction(async (trx) => {
        await this.crawlTxService?.insertDecodedTxAndRelated(
          listdecodedTx,
          trx
        );
      });
    const tx = await Transaction.query().findOne(
      'hash',
      '14B177CFD3AC22F6AF1B46EF24C376B757B2379023E9EE075CB81A5E2FF18FAC'
    );
    expect(tx).not.toBeUndefined();
    if (tx) {
      const logs = JSON.parse(tx_fixture_authz.txs[0].tx_result.log);
      const eventAttributes = await EventModel.query()
        .select(
          'attributes.composite_key',
          'attributes.value',
          'event.tx_msg_index'
        )
        .joinRelated('attributes')
        .where('event.tx_id', tx.id);

      logs.forEach((log: Log) => {
        const msgIndex = log.msg_index ?? 0;
        log.events.forEach((event: Event) => {
          event.attributes.forEach((attribute: Attribute) => {
            const found = eventAttributes.find(
              (item) =>
                item.composite_key === `${event.type}.${attribute.key}` &&
                item.value === attribute.value &&
                item.tx_msg_index === msgIndex
            );
            expect(found).not.toBeUndefined();
          });
        });
      });
    }
    // }
    // );
  }

  @AfterEach()
  async tearDown() {
    this.crawlTxService?.getQueueManager().stopAll();
    await Promise.all([
      knex.raw('TRUNCATE TABLE block RESTART IDENTITY CASCADE'),
      knex.raw('TRUNCATE TABLE block_checkpoint RESTART IDENTITY CASCADE'),
      this.crawlTxService?._stop(),
      this.broker.stop(),
    ]);
  }
}

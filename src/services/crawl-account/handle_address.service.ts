import {
  Action,
  Service,
} from '@ourparentcenter/moleculer-decorators-extended';
import { Context, ServiceBroker } from 'moleculer';
import Utils from '../../common/utils/utils';
import {
  BULL_JOB_NAME,
  SERVICE_NAME,
  SERVICE,
  BULL_ACTION_NAME,
  MSG_TYPE,
} from '../../common/constant';
import BullableService, { QueueHandler } from '../../base/bullable.service';
import { Config } from '../../common';
import BlockCheckpoint from '../../models/block_checkpoint';
import Block from '../../models/block';
import Transaction from '../../models/transaction';
import { Account } from '../../models/account';
import config from '../../../config.json';
import TransactionEventAttribute from '../../models/transaction_event_attribute';
import { IListAddressesParam } from '../../common/utils/request';

@Service({
  name: SERVICE_NAME.HANDLE_ADDRESS,
  version: 1,
})
export default class HandleAddressService extends BullableService {
  private msgStakes = [
    MSG_TYPE.MSG_DELEGATE,
    MSG_TYPE.MSG_REDELEGATE,
    MSG_TYPE.MSG_UNDELEGATE,
  ];

  public constructor(public broker: ServiceBroker) {
    super(broker);
  }

  @Action({
    name: BULL_ACTION_NAME.CRAWL_NEW_ACCOUNT_API,
    params: {
      listAddresses: 'string[]',
    },
  })
  public async actionCrawlNewAccountApi(ctx: Context<IListAddressesParam>) {
    await this.insertNewAccount(ctx.params.listAddresses, []);
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.HANDLE_ADDRESS,
    jobType: 'crawl',
    prefix: `horoscope-v2-${Config.CHAIN_ID}`,
  })
  public async handleJob(_payload: object): Promise<void> {
    const listTxStakes: any[] = [];

    const [handleAddressBlockCheckpoint, latestBlock]: [
      BlockCheckpoint | undefined,
      Block | undefined
    ] = await Promise.all([
      BlockCheckpoint.query()
        .select('*')
        .findOne('job_name', BULL_JOB_NAME.HANDLE_ADDRESS),
      Block.query().select('height').findOne({}).orderBy('height', 'desc'),
    ]);
    this.logger.info(
      `Block Checkpoint: ${JSON.stringify(handleAddressBlockCheckpoint)}`
    );

    let lastHeight = 0;
    let updateBlockCheckpoint: BlockCheckpoint;
    if (handleAddressBlockCheckpoint) {
      lastHeight = handleAddressBlockCheckpoint.height;
      updateBlockCheckpoint = handleAddressBlockCheckpoint;
    } else
      updateBlockCheckpoint = BlockCheckpoint.fromJson({
        job_name: BULL_JOB_NAME.HANDLE_ADDRESS,
        height: 0,
      });

    if (latestBlock) {
      if (latestBlock.height === lastHeight) return;

      const eventAddresses: string[] = [];
      let offset = 0;
      let done = false;
      this.logger.info(
        `Start query Tx from height ${lastHeight} to ${latestBlock.height}`
      );
      while (!done) {
        // eslint-disable-next-line no-await-in-loop
        const resultTx = await Transaction.query()
          .select(
            'transaction.id',
            'transaction.height',
            'transaction.timestamp'
          )
          .join(
            'transaction_message',
            'transaction.id',
            'transaction_message.tx_id'
          )
          .select(
            'transaction_message.tx_id as tx_msg_id',
            'transaction_message.index',
            'transaction_message.type',
            'transaction_message.content'
          )
          .join(
            'transaction_event',
            'transaction.id',
            'transaction_event.tx_id'
          )
          .select('transaction_event.tx_id')
          .join(
            'transaction_event_attribute',
            'transaction_event.id',
            'transaction_event_attribute.event_id'
          )
          .select(
            'transaction_event_attribute.key',
            'transaction_event_attribute.value'
          )
          .where('transaction.height', '>', lastHeight)
          .andWhere('transaction.height', '<=', latestBlock.height)
          .andWhere((builder) =>
            builder.whereIn('transaction_event_attribute.key', [
              TransactionEventAttribute.EVENT_KEY.RECEIVER,
              TransactionEventAttribute.EVENT_KEY.SPENDER,
              TransactionEventAttribute.EVENT_KEY.SENDER,
            ])
          )
          .limit(100)
          .offset(offset);
        this.logger.info(
          `Query Tx from height ${lastHeight} to ${latestBlock.height} page ${
            offset + 1
          }`
        );

        if (resultTx.length > 0) {
          resultTx.map((res: any) => eventAddresses.push(res.value));

          listTxStakes.push(
            ...resultTx.filter((res: any) => this.msgStakes.includes(res.type))
          );
        }

        if (resultTx.length === 100) offset += 1;
        else done = true;
      }

      const listAddresses = eventAddresses
        .filter((addr: string) => Utils.isValidAddress(addr, 20))
        .filter(Utils._onlyUnique);

      if (listAddresses.length > 0) {
        await this.insertNewAccount(listAddresses, listTxStakes);

        updateBlockCheckpoint.height = latestBlock.height;
        await BlockCheckpoint.query()
          .insert(updateBlockCheckpoint)
          .onConflict('job_name')
          .merge()
          .returning('id');
      }
    }
  }

  private async insertNewAccount(listAddresses: string[], listTxStakes: any[]) {
    const listInsert: any[] = [];

    const existedAccounts: string[] = (
      await Account.query().select('*').whereIn('address', listAddresses)
    ).map((account: Account) => account.address);

    listAddresses.forEach((address: string) => {
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
        listInsert.push(Account.query().insert(account));
      }
    });

    try {
      await Promise.all(listInsert);
    } catch (error) {
      this.logger.error(error);
    }

    this.broker.call(`${SERVICE.V1.CrawlAccount.UpdateAccount}`, {
      listAddresses,
    });

    if (listTxStakes.length > 0) {
      this.broker.call(`${SERVICE.V1.CrawlAccountStake.UpdateAccountStake}`, {
        listTxStakes,
      });
      this.broker.call(`${SERVICE.V1.HandleStakeEvent.UpdatePowerEvent}`, {
        listTxStakes,
      });
    }
  }

  public async _start() {
    await Promise.all([
      this.broker.waitForServices([`${SERVICE.V1.CrawlAccount.name}`]),
      this.broker.waitForServices([`${SERVICE.V1.CrawlAccountStake.name}`]),
      this.broker.waitForServices([`${SERVICE.V1.HandleStakeEvent.name}`]),
    ]);

    this.createJob(
      BULL_JOB_NAME.HANDLE_ADDRESS,
      'crawl',
      {},
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
        repeat: {
          every: config.handleAddress.millisecondCrawl,
        },
      }
    );

    return super._start();
  }
}

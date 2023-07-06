import { Service } from '@ourparentcenter/moleculer-decorators-extended';
import { ServiceBroker } from 'moleculer';
import { Account, DailyStatistics, Transaction } from '../../models';
import { BULL_JOB_NAME, IDailyStatsParam, SERVICE } from '../../common';
import config from '../../../config.json' assert { type: 'json' };
import BullableService, { QueueHandler } from '../../base/bullable.service';
import Utils from '../../common/utils/utils';

@Service({
  name: SERVICE.V1.DailyStatisticsService.key,
  version: 1,
})
export default class DailyStatisticsService extends BullableService {
  public constructor(public broker: ServiceBroker) {
    super(broker);
  }

  @QueueHandler({
    queueName: BULL_JOB_NAME.CRAWL_DAILY_STATISTICS,
    jobName: BULL_JOB_NAME.CRAWL_DAILY_STATISTICS,
    // prefix: `horoscope-v2-${config.chainId}`,
  })
  public async handleJob(_payload: IDailyStatsParam): Promise<void> {
    try {
      const syncDate = _payload.date ? new Date(_payload.date) : new Date();
      const endTime = syncDate.setUTCHours(0, 0, 0, 0);
      syncDate.setDate(syncDate.getDate() - 1);
      const startTime = syncDate.setUTCHours(0, 0, 0, 0);
      this.logger.info(
        `Get daily statistic events at page ${
          _payload.offset
        } for day ${new Date(startTime)}`
      );

      const dailyEvents = await Transaction.query()
        .joinRelated('events.[attributes]')
        .select('transaction.id', 'transaction.code', 'events:attributes.value')
        .where('transaction.timestamp', '>=', new Date(startTime))
        .andWhere('transaction.timestamp', '<', new Date(endTime))
        .andWhere(
          'events:attributes.value',
          'like',
          `${config.networkPrefixAddress}%`
        )
        .orderBy('transaction.id')
        .limit(config.dailyStatistics.recordsPerCall)
        .offset(_payload.offset * config.dailyStatistics.recordsPerCall);

      if (dailyEvents.length > 0) {
        const activeAddrs = Array.from(
          new Set(
            _payload.addresses.concat(
              dailyEvents
                .filter((event) =>
                  Utils.isValidAccountAddress(
                    event.value,
                    config.networkPrefixAddress,
                    20
                  )
                )
                .map((event) => event.value)
            )
          )
        );
        const dailyTxs = Array.from(
          new Set(
            _payload.txIds.concat(
              Array.from(
                new Set(
                  dailyEvents
                    .filter((event) => event.code === 0)
                    .map((event) => event.id)
                )
              )
            )
          )
        );
        const offset = _payload.offset + 1;

        await this.createJob(
          BULL_JOB_NAME.CRAWL_DAILY_STATISTICS,
          BULL_JOB_NAME.CRAWL_DAILY_STATISTICS,
          {
            offset,
            txIds: dailyTxs,
            addresses: activeAddrs,
          },
          {
            removeOnComplete: true,
            removeOnFail: {
              count: 3,
            },
          }
        );
      } else {
        syncDate.setDate(syncDate.getDate() - 1);
        const previousDay = syncDate.setUTCHours(0, 0, 0, 0);

        const [uniqueAddrs, prevDailyStat] = await Promise.all([
          Account.query().count('id'),
          DailyStatistics.query().findOne('date', new Date(previousDay)),
        ]);

        const dailyStat = DailyStatistics.fromJson({
          daily_txs: _payload.txIds.length,
          daily_active_addresses: _payload.addresses.length,
          unique_addresses: Number(uniqueAddrs[0].count),
          unique_addresses_increase: prevDailyStat
            ? uniqueAddrs[0].count - prevDailyStat.unique_addresses
            : 0,
          date: new Date(startTime).toISOString(),
        });

        await DailyStatistics.query()
          .insert(dailyStat)
          .catch((error) => {
            this.logger.error('Error insert new daily statistic record');
            this.logger.error(error);
          });
      }
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async _start() {
    this.createJob(
      BULL_JOB_NAME.CRAWL_DAILY_STATISTICS,
      BULL_JOB_NAME.CRAWL_DAILY_STATISTICS,
      {
        offset: 0,
        date: null,
        txIds: [],
        addresses: [],
      },
      {
        removeOnComplete: true,
        removeOnFail: {
          count: 3,
        },
        // repeat: {
        //   pattern: config.dailyStatistics.jobPattern,
        // },
      }
    );

    return super._start();
  }
}

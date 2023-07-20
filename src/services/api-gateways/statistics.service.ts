import { Get, Service } from '@ourparentcenter/moleculer-decorators-extended';
import { Context, ServiceBroker } from 'moleculer';
import BaseService from '../../base/base.service';
import networks from '../../../network.json' assert { type: 'json' };

@Service({
  name: 'statistics',
  version: 1,
})
export default class StatisticsService extends BaseService {
  public constructor(public broker: ServiceBroker) {
    super(broker);
  }

  @Get('/top-accounts', {
    name: 'getTopAccountsByChainId',
    params: {
      chainid: {
        type: 'string',
        optional: false,
        enum: networks.map((network) => network.chainId),
      },
    },
    cache: {
      keys: ['chainid'],
      ttl: 3600,
    },
  })
  async getTopAccountsByChainId(
    ctx: Context<{ chainid: string }, Record<string, unknown>>
  ) {
    const selectedChain = networks.find(
      (network) => network.chainId === ctx.params.chainid
    );

    return this.broker.call(
      `v1.cross-chains.getTopAccounts@${selectedChain?.moleculerNamespace}`
    );
  }
}

import { Post, Service } from '@ourparentcenter/moleculer-decorators-extended';
import { Context, ServiceBroker } from 'moleculer';
import { SERVICE } from '../../common';
import BaseService from '../../base/base.service';
import networks from '../../../network.json' assert { type: 'json' };

@Service({
  name: 'job',
  version: 1,
})
export default class JobService extends BaseService {
  public constructor(public broker: ServiceBroker) {
    super(broker);
  }

  @Post('/composite-index-to-attribute-partition', {
    name: 'composite-index-to-attribute-partition',
    params: {
      chainid: {
        type: 'string',
        optional: false,
        enum: networks.map((network) => network.chainId),
      },
      partitionName: {
        type: 'string',
        optional: false,
      },
      needConcurrently: {
        type: 'boolean',
        optional: false,
        convert: true,
        default: true,
      },
    },
  })
  async createCompositeIndexInAttributePartition(
    ctx: Context<
      { chainid: string; partitionName: string; needConcurrently: boolean },
      Record<string, unknown>
    >
  ) {
    const selectedChain = networks.find(
      (network) => network.chainId === ctx.params.chainid
    );

    return this.broker.call(
      `${SERVICE.V1.JobService.CreateIndexCompositeAttrPartition.actionCreateJob.path}@${selectedChain?.moleculerNamespace}`,
      {
        partitionName: ctx.params.partitionName,
        needConcurrently: ctx.params.needConcurrently,
      }
    );
  }
}

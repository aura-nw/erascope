/* eslint-disable @typescript-eslint/no-var-requires */
import { ServiceBroker, Context } from 'moleculer';
import { Get, Service } from '@ourparentcenter/moleculer-decorators-extended';
// import BaseService from 'src/base/BaseService';
// TODO: Not very happy with relative import,
//  but ts-node loader does not support yet with type alias for ESM project, will try to fix later
import BaseService from '../../base/base.service';
import { Summary, Response } from '../../base/openapi';

@Service()
export default class GreeterService extends BaseService {
  public constructor(public broker: ServiceBroker) {
    super(broker);
  }

  @Response(200, 'return when success', {
    type: 'array',
    items: {
      type: 'object',
      example: {
        id: 1,
        filename: 'foo.txt',
        mimetype: 'text/plain',
        sizeInBytes: 100,
      },
    },
  })
  @Response(201, 'return when success', {
    type: 'array',
    items: {
      type: 'object',
      example: {
        id: 1,
        filename: 'foo.txt',
        mimetype: 'text/plain',
        sizeInBytes: 100,
      },
    },
  })
  @Summary('Say hello from decorator')
  @Get('/sayHello', {})
  public async sayHello(): Promise<string> {
    return 'Hello Moleculer';
  }

  @Get('/sayWelcome', {
    openapi: {
      summary: 'Say welcom to a persons',
    },
    params: {
      name: { type: 'string', min: 5 },
    },
  })
  public sayWelcome(ctx: Context<{ name: string }>): string {
    return `Welcome, ${JSON.stringify(ctx.params.name)}`;
  }
}

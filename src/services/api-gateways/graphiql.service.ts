import { Context, ServiceBroker } from 'moleculer';
import { Post, Service } from '@ourparentcenter/moleculer-decorators-extended';
import axios from 'axios';
import BaseService from '../../base/base.service';
import { IContextGraphQLQuery, Config } from '../../common';
import { ResponseDto } from '../../common/types/response-api';
import config from '../../../config.json' assert { type: 'json' };

@Service({
  name: 'graphiql',
  version: 1,
})
export default class GraphiQLService extends BaseService {
  public constructor(public broker: ServiceBroker) {
    super(broker);
  }

  /**
   * call it with curl  --request POST 'http://0.0.0.0:3000/graphiql'
   * Schema for validattion
   */
  @Post('/', {
    name: 'handleGraphQLQuery',
    params: {
      operationName: 'string',
      query: 'string',
      variables: 'any',
    },
  })
  async handleGraphQLQuery(ctx: Context<IContextGraphQLQuery>) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { operationName, query, variables } = ctx.params;

    let result: ResponseDto = {
      code: '',
      message: '',
      data: null,
    };
    if ((query.match(/{/g) || []).length > 4) {
      result = {
        code: 'ERROR',
        message: 'The query depth must not be greater than 3',
        data: query,
      };
    }

    try {
      const data = await axios({
        url: config.hasuraGraphQL,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-hasura-admin-secret': Config.HASURA_SECRET,
        },
        data: ctx.params,
      });
      result = {
        code: 'SUCCESSFUL',
        message: 'Successful',
        data: data.data,
      };
    } catch (error) {
      this.logger.error('Error execute GraphQL query');
      this.logger.error(error);
    }

    return result;
  }
}

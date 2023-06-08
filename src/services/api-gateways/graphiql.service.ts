import { Context, ServiceBroker } from 'moleculer';
import { Post, Service } from '@ourparentcenter/moleculer-decorators-extended';
import axios from 'axios';
import BaseService from '../../base/base.service';
import { IContextGraphQLQuery, Config } from '../../common';
import { ResponseDto } from '../../common/types/response-api';
import config from '../../../config.json' assert { type: 'json' };
import { ErrorCode, ErrorMessage } from '../../common/types/errors';

@Service({
  name: 'graphiql',
  version: 1,
  settings: {
    rateLimit: {
      window: config.graphiqlApi.rateLimitWindow,
      limit: config.graphiqlApi.rateLimitQuery,
      headers: true,
      key: (req: any) =>
        req.headers['x-forwarded-for'] ||
        req.connection.remoteAddress ||
        req.socket.remoteAddress ||
        req.connection.socket.remoteAddress,
    },
  },
})
export default class GraphiQLService extends BaseService {
  public constructor(public broker: ServiceBroker) {
    super(broker);
  }

  /**
   * call it with curl  --request POST 'http://0.0.0.0:3000/api/v1/graphiql'
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
    const { query } = ctx.params;

    let result: ResponseDto = {
      code: '',
      message: '',
      data: null,
    };
    let openBrackets = 0;
    let isWhere = false;
    for (let i = 0; i < query.length; i += 1) {
      if (query.charAt(i) === '(') isWhere = true;
      else if (query.charAt(i) === ')') isWhere = false;

      if (query.charAt(i) === '{' && !isWhere) openBrackets += 1;
      else if (query.charAt(i) === '}' && !isWhere) openBrackets -= 1;

      if (openBrackets > config.graphiqlApi.depthLimit + 2) {
        result = {
          code: ErrorCode.WRONG,
          message: ErrorMessage.VALIDATION_ERROR,
          data: 'The query depth must not be greater than 3',
        };
        return result;
      }
    }

    try {
      const response = await axios({
        url: config.graphiqlApi.hasuraGraphQL,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-hasura-admin-secret': Config.HASURA_SECRET,
          // Authorization: `Bearer ${Config.HASURA_JWT}`,
          // 'X-Hasura-Role': config.graphiqlApi.hasuraRole,
        },
        data: ctx.params,
      });
      result = {
        code: response.data.data ? ErrorCode.SUCCESSFUL : ErrorCode.BAD_REQUEST,
        message: response.data.data
          ? ErrorMessage.SUCCESSFUL
          : ErrorMessage.BAD_REQUEST,
        data: response.data.data ?? response.data,
      };
    } catch (error) {
      this.logger.error('Error execute GraphQL query');
      this.logger.error(error);
    }

    return result;
  }
}
